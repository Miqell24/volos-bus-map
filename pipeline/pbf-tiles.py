#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cuts the OSM extracts this map needs out of a Geofabrik .pbf — same JSON shape
as Overpass ('elements': ways with tags, node ids and geometry), so build.mjs
cannot tell the difference. The Greek extract is shared by every Greek map in
the family and lives one level up, in ../_pbf/.

Volos: 2 x 2 road tiles over the 14 x 20 km the network actually covers
(Nea Ionia and Dimini west, Ano Volos, Alli Meria and Melissatika north, the Pelion coast east as far as Lechonia and Platanidia). No rail file: Volos has no tram and no metro.

A second pass harvests every NAMED node and non-road way in the frame — bus
stops, villages, churches, schools, cemeteries, squares — into data/osm/names.json. The operator writes
its stop names in capitals, and Greek capitals drop the accents, so build.mjs
recovers the accented spellings from these OSM names (lib/greek.mjs).
"""
import json, os, re, sys
import osmium

ROOT = os.path.join(os.path.dirname(__file__), '..')
PBFS = [os.path.join(ROOT, '..', '_pbf', 'greece-latest.osm.pbf')]

# must match pipeline/download.sh — the stop cloud is 39.3028..39.3917 N, 22.8910..23.0579 E;
# this adds ~2 km of margin so a route never runs off the graph at the edge
S, N, W, E = 39.282, 39.412, 22.855, 23.083

HW = re.compile(r'^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$')

road_tiles = {}
for i in range(1, 5):
    f = os.path.join(ROOT, f'data/osm/tiles/t{i}.json')
    if os.path.exists(f):
        continue
    row, col = (i - 1) // 2, (i - 1) % 2
    road_tiles[i] = (S + (N - S) * row / 2, S + (N - S) * (row + 1) / 2,
                     W + (E - W) * col / 2, W + (E - W) * (col + 1) / 2)
names_file = os.path.join(ROOT, 'data/osm/names.json')
need_names = not os.path.exists(names_file)
print('brakujące kafle dróg:', sorted(road_tiles), '| nazwy OSM:', 'do zebrania' if need_names else 'są', flush=True)
if not road_tiles and not need_names:
    sys.exit(0)
os.makedirs(os.path.join(ROOT, 'data/osm/tiles'), exist_ok=True)

out = {i: [] for i in road_tiles}
out_names = []


class H(osmium.SimpleHandler):
    def way(self, w):
        tags = w.tags
        hw = tags.get('highway')
        is_road = hw is not None and HW.match(hw)
        # a named area or line that is not a road — cemetery, hospital, square,
        # park, church, school — teaches the accent dictionary a word each
        wants_name = need_names and not is_road and tags.get('name') is not None
        if not is_road and not wants_name:
            return
        geom, ids = [], []
        la0, la1, lo0, lo1 = 90.0, -90.0, 180.0, -180.0
        for n in w.nodes:
            try:
                lo, la = n.lon, n.lat
            except osmium.InvalidLocationError:
                continue
            # node ids ride along: buildGraph() builds topology from el.nodes
            # and SILENTLY skips ways without them (the London t13 hole)
            ids.append(n.ref)
            geom.append({'lat': la, 'lon': lo})
            if la < la0: la0 = la
            if la > la1: la1 = la
            if lo < lo0: lo0 = lo
            if lo > lo1: lo1 = lo
        if len(geom) < 2:
            return
        if wants_name:
            if la1 >= S and la0 <= N and lo1 >= W and lo0 <= E:
                out_names.append({'type': 'way', 'id': w.id, 'tags': {'name': tags.get('name')}})
            return
        el = None
        for i, (s, n_, w_, e) in road_tiles.items():
            if la1 >= s and la0 <= n_ and lo1 >= w_ and lo0 <= e:
                if el is None:
                    el = {'type': 'way', 'id': w.id, 'nodes': ids,
                          'tags': {t.k: t.v for t in tags}, 'geometry': geom}
                out[i].append(el)


# Named nodes only — a plain node pass, no location index needed (and with
# locations=True pyosmium swallows node callbacks, the Ruse lesson).
class Nm(osmium.SimpleHandler):
    def node(self, n):
        name = n.tags.get('name')
        if not name:
            return
        try:
            la, lo = n.location.lat, n.location.lon
        except osmium.InvalidLocationError:
            return
        if not (S <= la <= N and W <= lo <= E):
            return
        out_names.append({'type': 'node', 'id': n.id, 'lat': la, 'lon': lo,
                          'tags': {t.k: t.v for t in n.tags if t.k in ('name', 'highway', 'public_transport', 'place', 'amenity')}})


for pbf in PBFS:
    if not os.path.exists(pbf):
        sys.exit(f'brak {pbf} — pobierz go (pipeline/download.sh)')
    print('czytam', os.path.basename(pbf), flush=True)
    if road_tiles or need_names:
        H().apply_file(pbf, locations=True, idx='flex_mem')
    if need_names:
        Nm().apply_file(pbf)

GEN = 'pbf-tiles.py (Geofabrik greece)'
for i, els in out.items():
    f = os.path.join(ROOT, f'data/osm/tiles/t{i}.json')
    json.dump({'version': 0.6, 'generator': GEN, 'elements': els}, open(f, 'w'))
    print(f't{i}: {len(els)} dróg', flush=True)
if need_names:
    json.dump({'version': 0.6, 'generator': GEN, 'elements': out_names}, open(names_file, 'w'), ensure_ascii=False)
    print(f'nazwy OSM: {len(out_names)} nazwanych węzłów i obszarów w kadrze', flush=True)
print('gotowe', flush=True)
