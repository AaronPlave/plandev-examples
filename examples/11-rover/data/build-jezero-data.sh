#!/usr/bin/env bash
# Rebuilds the rover example's terrain dataset, and optionally basemap tiles, from USGS Astrogeology's
# Mars 2020 Terrain Relative Navigation CTX products for Jezero crater (public domain):
#   DTM (20 m/px):         JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif
#   Orthomosaic (6 m/px):  JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif
#
#   ./build-jezero-data.sh                 # terrain grid only (committed; rebuild only to change it)
#   ./build-jezero-data.sh <tiles-dir>     # also cut the orthomosaic into TMS tiles for an MMGIS layer
#
# Needs GDAL (gdaldem, gdalwarp, gdal_translate, gdal2tiles.py) and python3.
set -euo pipefail
cd "$(dirname "$0")"
BASE=https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX
DTM=JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif
ORTHO=JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif
ID=jezero-ctx-slope-200m-v1
OUT=../src/main/resources/rover/terrain/$ID.asc
mkdir -p cache
[ -f cache/$DTM ] || curl -fL --retry 3 -o cache/$DTM $BASE/$DTM

# Slope of the 20 m DTM (degrees), then the mean of those slopes in each 200 m cell. The product is
# equirectangular with latTs=0, so east-west distances are overstated by 1/cos(18.5 deg) = 5 % and
# east-west slope components understated by as much; not corrected.
gdaldem slope -q cache/$DTM cache/slope20.tif
gdalwarp -q -overwrite -tr 200 200 -r average cache/slope20.tif cache/slope200.tif
gdal_translate -q -of AAIGrid -co DECIMAL_PRECISION=1 cache/slope200.tif cache/slope200.asc
# AAIGrid header in degrees: with latTs=0 on the Mars 2000 sphere, x = R*lon and y = R*lat, so cells are square in degrees.
python3 - cache/slope200.asc "$OUT" <<'PY'
import math, sys
src, out = sys.argv[1:]
R = 3396190.0
lines = open(src).read().splitlines()
h = {k.lower(): float(v) for k, v in (l.split() for l in lines[:6] if l.split()[0].lower() != 'nodata_value')}
n = len([l for l in lines[:7] if l.split()[0][0].isalpha()])
deg = lambda m: math.degrees(m / R)
with open(out, 'w') as f:
    f.write(f"ncols {int(h['ncols'])}\nnrows {int(h['nrows'])}\nxllcorner {deg(h['xllcorner']):.6f}\nyllcorner {deg(h['yllcorner']):.6f}\ncellsize {deg(h['cellsize']):.8f}\nNODATA_value -9999\n")
    for l in lines[n:]:
        f.write(' '.join('-9999' if float(v) < 0 or float(v) > 90 else v for v in l.split()) + '\n')
PY
echo "wrote $OUT ($(shasum -a 256 "$OUT" | cut -c1-12))"

if [ "${1:-}" ]; then
  [ -f cache/$ORTHO ] || curl -fL --retry 3 -o cache/$ORTHO $BASE/$ORTHO
  # To planetocentric degrees, then labelled EPSG:4326 so gdal2tiles cuts spherical-mercator tiles: tile
  # indices depend only on angles, and MMGIS scales by the mission's own radius.
  gdalwarp -q -overwrite -t_srs '+proj=longlat +R=3396190 +no_defs' -r bilinear -dstalpha cache/$ORTHO cache/ortho_ll.tif
  gdal_translate -q -a_srs EPSG:4326 cache/ortho_ll.tif cache/ortho_4326.tif
  mkdir -p "$1"
  gdal2tiles.py -q --profile=mercator -z 7-14 -w none --processes=4 cache/ortho_4326.tif "$1"
  echo "tiles in $1"
fi
