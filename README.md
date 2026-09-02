# Volos Public Transport — interactive map

Interactive, poster-grade map of the public transport network of **Volos**:
the 12 bus lines of Αστικό ΚΤΕΛ Βόλου Α.Ε. drawn on the real roadway, one stroke
per street with the line numbers beside it, every stop with its name, the
termini as badges. Same engine and same visual language as the rest of the
family (see the city switcher in the panel).

Live: https://miqell24.github.io/volos-bus-map/

## Where the data comes from

**Volos publishes no GTFS anywhere.** The operator's site carries timetables and
route pictures and nothing else; the Greek open-data portal data.gov.gr holds
Athens and Thessaloniki only; neither the MobilityDatabase nor Transitous knows
the city, and OSM has a handful of route relations.

What IS public — and unauthenticated — is the backend of the operator's own
passenger site, `volos.citybus.gr`, one tenant of the citybus.gr platform that
several Greek urban KTELs share. Its REST API (`rest.citybus.gr`) carries the
whole network: every pole with its coordinates, every line with its patterns,
each pattern with its ordered stop list and a polyline of the road it takes.
`pipeline/citybus-feed.mjs` turns that into a proper GTFS under `data/gtfs/`
(stops, routes, trips, stop_times, shapes). The API wants a bearer token; the
passenger page hands a short-lived one to every visitor in a script constant,
and the feed writer reads it off the page exactly as a browser would.

One trip per pattern: the API publishes patterns, not runs, so `build.mjs`
reads the feed with `allVariants` — every pattern is a branch the operator
itself lists. No departure times are invented; the pipeline never reads a
clock, it matches geometry.

**Stop names.** The operator writes them in capitals, and Greek capitals drop
the accents — ΠΛΑΤΕΙΑ ΤΑΧΥΔΡΟΜΕΙΟΥ gives no clue that it is Πλατεία
Ταχυδρομείου. `pipeline/lib/greek.mjs` rewrites them word by word through a
dictionary of accented forms harvested from the OSM names of the frame; what
the dictionary does not know falls back to plain title case. The platform's
direction markers on the pole names (a trailing Μ/Ε, „ΠΡΟΣ ΚΕΝΤΡΟ") name the
run rather than the place and come off before printing.

OSM roads come from the Geofabrik Greece extract (`../_pbf/`, shared with the
other Greek maps), cut into 2 × 2 tiles by `pipeline/pbf-tiles.py`.

## Build

```
npm run download   # writes the GTFS from the API, cuts the OSM tiles
npm run build      # GTFS + OSM → HMM map matching → data/out/*.geojson
npm run lines      # the Lines view
npm run serve      # http://localhost:8178
```

`docs/` is what GitHub Pages serves; it is a copy of `web/` plus `data/out/`.
