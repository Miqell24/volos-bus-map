// Volos has no downloadable GTFS, so this writes one.
//
// The operator publishes timetables on its own site and nothing else: no feed
// on the Greek open-data portal (data.gov.gr carries Athens and Thessaloniki
// only), nothing in the MobilityDatabase or Transitous, and OSM holds a
// handful of route relations. What IS public is the backend of the operator's
// own passenger site at volos.citybus.gr — the citybus.gr platform that several Greek
// urban KTELs share. Its REST API (rest.citybus.gr) carries the whole network:
// every pole with its coordinates, every line with its patterns, each pattern
// with an ordered stop list AND a polyline of the road it takes. That is a
// complete GTFS in a different dress, so this script undresses it:
//
//   /lines                     → routes.txt (+ the pattern list per line)
//   /stops                     → stops.txt
//   /routes/{code}/sequence    → stop_times.txt (one trip per pattern)
//   /lines/{code}/points       → shapes.txt
//
// The API wants a bearer token. The passenger page hands one to every visitor
// in a <script> constant (a short-lived JWT carrying nothing but an expiry),
// so the script loads that page first and reads the token and the agency code
// off it — no account, no key, exactly what the browser does.
//
// One trip per pattern, because the endpoint publishes patterns, not runs —
// which is why build.mjs reads this feed with allVariants: every pattern here
// is a real branch the operator itself lists, not a short-turn sampled out of
// a timetable. stop_times carries the sequence only; the pipeline never reads
// a clock (it matches geometry), so no departure times are invented.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GD = join(ROOT, 'data/gtfs');

const HOST = 'volos.citybus.gr';
const API = 'https://rest.citybus.gr/api/v1';
const AGENCY_ID = 'ASTIKO_VOLOU';
const AGENCY_NAME = 'Αστικό ΚΤΕΛ Βόλου Α.Ε.';
const AGENCY_URL = 'https://astikovolou.gr';

const t0 = Date.now();
const log = (m) => console.log(`[feed ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const UA = 'Mozilla/5.0 (transit-maps family; contact via github.com/Miqell24)';

async function getText(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (attempt === 4) throw e;
      log(`${url}: ${e.message} — retrying (${attempt}/3)`);
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

// ---------- 0) the token and the agency code, off the passenger page ----------
const page = await getText(`https://${HOST}/el/stops`);
const token = /const\s+token\s*=\s*'([^']+)'/.exec(page)?.[1];
const agency = /const\s+agencyCode\s*=\s*(\d+)/.exec(page)?.[1];
if (!token || !agency) throw new Error(`nie znalazłem tokena/agencyCode na https://${HOST}/el/stops`);
try {
  const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
  log(`token ze strony, agencja ${agency}, ważny do ${new Date(exp * 1000).toISOString()}`);
} catch { log(`token ze strony, agencja ${agency}`); }

async function getJson(path, { optional = false } = {}) {
  const url = `${API}/${path}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', authorization: `Bearer ${token}` } });
      if (r.status === 404 && optional) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 4) throw e;
      log(`${path}: ${e.message} — retrying (${attempt}/3)`);
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}
// a few requests at a time — it is somebody else's passenger backend
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const q = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (header, rows) => header.join(',') + '\n' + rows.map((r) => r.map(q).join(',')).join('\n') + '\n';
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

mkdirSync(GD, { recursive: true });
log('pobieram lines + stops');
const [lines, stops] = await Promise.all([getJson(`el/${agency}/lines`), getJson(`el/${agency}/stops`)]);
log(`API: ${lines.length} linii, ${stops.length} przystanków`);

// ---------- stops ----------
const stopById = new Map();   // API id → row
const idByCode = new Map();   // pole code (what sequences reference) → API id
const stopRows = [];
for (const s of stops) {
  const name = clean(s.name);
  stopById.set(s.id, s);
  if (idByCode.has(s.code)) log(`UWAGA: kod przystanku ${s.code} powtórzony (${idByCode.get(s.code)} i ${s.id})`);
  idByCode.set(s.code, s.id);
  stopRows.push([s.id, s.code || '', name, s.latitude, s.longitude]);
}
writeFileSync(join(GD, 'stops.txt'), csv(['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon'], stopRows));

// ---------- routes / trips / stop_times / shapes ----------
const withRoutes = lines.filter((l) => (l.routes || []).length);
for (const l of lines) if (!(l.routes || []).length) log(`linia ${l.code} „${clean(l.name)}” nie ma w systemie żadnej trasy — pomijam`);

const allRoutes = withRoutes.flatMap((l) => l.routes.map((r) => ({ line: l, route: r })));
log(`pobieram ${withRoutes.length} polilinii linii i ${allRoutes.length} sekwencji tras`);
const pointsByLine = new Map();
await pool(withRoutes, 4, async (l) => {
  const p = await getJson(`${agency}/lines/${l.code}/points`, { optional: true });
  pointsByLine.set(l.code, new Map((p || []).map((x) => [x.routeCode, x.routePoints || []])));
});
const seqByRoute = new Map();
await pool(allRoutes, 4, async ({ route }) => {
  seqByRoute.set(route.code, (await getJson(`el/${agency}/routes/${route.code}/sequence`, { optional: true })) || []);
});

const routeRows = [], tripRows = [], stRows = [], shapeRows = [];
let patterns = 0, noGeom = 0, noSeq = 0, orphan = 0;
for (const l of withRoutes) {
  const short = clean(l.code).replace(/^0+(?=\d)/, '');   // the flag says 1, the system 01
  routeRows.push([l.code, AGENCY_ID, short, clean(l.name), 3, l.color ? String(l.color).replace('#', '').toUpperCase() : '']);
  for (const r of l.routes) {
    const seq = [...seqByRoute.get(r.code) || []].sort((a, b) => a.sequence - b.sequence);
    if (!seq.length) { noSeq++; log(`UWAGA: trasa ${r.code} (linia ${short}) bez sekwencji przystanków — pomijam`); continue; }
    const pts = [...(pointsByLine.get(l.code)?.get(r.code) || [])].sort((a, b) => a.sequence - b.sequence)
      .map((p) => [Number(p.latitude), Number(p.longitude)]).filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));
    if (!pts.length) noGeom++;
    const tripId = `R${r.code}`;
    const lastCode = seq[seq.length - 1].code;
    const last = stopById.get(idByCode.get(lastCode));
    // the platform's direction flag is 1 or 2 (a loop comes back as 2 too)
    tripRows.push([l.code, 'ALL', tripId, last ? clean(last.name) : '', r.direction === 1 ? '1' : '0', pts.length ? tripId : '']);
    seq.forEach((s, i) => {
      const sid = idByCode.get(s.code);
      if (sid === undefined) { orphan++; return; }
      stRows.push([tripId, sid, i + 1, '', '']);
    });
    pts.forEach(([la, lo], i) => shapeRows.push([tripId, la.toFixed(6), lo.toFixed(6), i + 1]));
    patterns++;
  }
}
writeFileSync(join(GD, 'routes.txt'),
  csv(['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color'], routeRows));
writeFileSync(join(GD, 'trips.txt'),
  csv(['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id'], tripRows));
writeFileSync(join(GD, 'stop_times.txt'),
  csv(['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'], stRows));
writeFileSync(join(GD, 'shapes.txt'),
  csv(['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'], shapeRows));
writeFileSync(join(GD, 'agency.txt'),
  csv(['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang'],
    [[AGENCY_ID, AGENCY_NAME, AGENCY_URL, 'Europe/Athens', 'el']]));
writeFileSync(join(GD, 'calendar.txt'),
  csv(['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    [['ALL', 1, 1, 1, 1, 1, 1, 1, '20260101', '20271231']]));

const lat = stops.map((s) => s.latitude), lon = stops.map((s) => s.longitude);
log(`zapisano data/gtfs: ${routeRows.length} linii, ${patterns} wzorców, ${stopRows.length} przystanków, ${shapeRows.length} punktów kształtów`);
log(`kadr przystanków: ${Math.min(...lat).toFixed(4)}..${Math.max(...lat).toFixed(4)} N, ${Math.min(...lon).toFixed(4)}..${Math.max(...lon).toFixed(4)} E`);
if (noGeom) log(`UWAGA: ${noGeom} wzorców bez polilinii — dla nich zadziała pseudo-dopasowanie po przystankach`);
if (noSeq) log(`UWAGA: ${noSeq} tras bez sekwencji — pominięte`);
if (orphan) log(`UWAGA: ${orphan} odwołań do kodów przystanków spoza /stops`);
