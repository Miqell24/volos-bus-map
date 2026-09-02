#!/usr/bin/env bash
# Downloads input data: the Volos GTFS this project writes itself, the OSM
# extract, MapLibre GL. Everything is cached — re-running only fetches what is
# missing.
#
# There is NO Volos GTFS to download. The operator publishes timetables on
# its own site and nothing else; data.gov.gr carries Athens and Thessaloniki
# only, and nothing reaches the MobilityDatabase or Transitous.
# pipeline/citybus-feed.mjs writes the feed instead, out of the public backend
# of the operator's own passenger site (volos.citybus.gr → rest.citybus.gr).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/gtfs data/osm/tiles web/vendor

# pyosmium does the cutting; it is the one dependency outside Node here.
need_osmium () {
  python3 -c "import osmium" 2>/dev/null && return 0
  echo "brak pakietu osmium — zainstaluj: pip3 install --user osmium" >&2
  return 1
}

# 1) GTFS — written from the citybus.gr API, not downloaded
if [ ! -f data/gtfs/routes.txt ]; then
  echo "== volos.citybus.gr API -> data/gtfs =="
  node pipeline/citybus-feed.mjs
fi

# 2) OSM — from the Geofabrik extract, not Overpass. The Greek extract is
#    shared by the Greek maps of the family and lives in ../_pbf/.
#    pipeline/pbf-tiles.py cuts 2 x 2 road tiles out of it and harvests the
#    named nodes of the frame for the accent dictionary (lib/greek.mjs).
if [ ! -f data/osm/tiles/t4.json ] || [ ! -f data/osm/names.json ]; then
  need_osmium
  mkdir -p ../_pbf
  if [ ! -f ../_pbf/greece-latest.osm.pbf ]; then
    echo "== Geofabrik greece-latest.osm.pbf =="
    curl -fL --retry 5 --retry-delay 5 -C - --max-time 3600 -o ../_pbf/greece-latest.osm.pbf \
      "https://download.geofabrik.de/europe/greece-latest.osm.pbf"
  fi
  echo "== cutting OSM tiles out of the extract =="
  python3 pipeline/pbf-tiles.py
fi

# 3) MapLibre GL (vendored, no CDN at runtime)
if [ ! -f web/vendor/maplibre-gl.js ]; then
  echo "== MapLibre GL =="
  curl -fL --retry 3 -o web/vendor/maplibre-gl.js  https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js
  curl -fL --retry 3 -o web/vendor/maplibre-gl.css https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css
fi

echo "OK — data ready:"
du -sh data/gtfs data/osm 2>/dev/null || true
