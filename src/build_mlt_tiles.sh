#!/usr/bin/env bash
# 震源CSVから MLT（MapLibre Tile）タイルを作る。ビューワが読んでいるものと同じ。
#
#   bash src/build_mlt_tiles.sh work/earthquakes.csv work/mlt
#
# MLTには MVT を経由する。参考実装の Encode CLI が MVT を入力に取るトランスコーダで、
# タイル自体は作れないため。
#
#   CSV → GeoJSONSeq（csv2geojsonseq.py）→ MVT（tippecanoe）→ MLT（encode.jar）→ XYZ
#
# 前提（WSL Ubuntu で確認）:
#   - Java 21以上   … encode.jar のビルドと実行に要る（17では不可）
#   - tippecanoe 2.x
#   - python3
#
# encode.jar は maplibre-tile-spec から自前でビルドする。
#   git clone --depth=1 https://github.com/maplibre/maplibre-tile-spec.git ~/mlt-spec
#   cd ~/mlt-spec/java && chmod +x gradlew && ./gradlew cli
#   → java/mlt-cli/build/libs/encode.jar
set -e

CSV=${1:?使い方: bash src/build_mlt_tiles.sh <earthquakes.csv> <出力ディレクトリ>}
OUT=${2:?使い方: bash src/build_mlt_tiles.sh <earthquakes.csv> <出力ディレクトリ>}
JAR=${MLT_ENCODE_JAR:-$HOME/mlt-spec/java/mlt-cli/build/libs/encode.jar}
MINZOOM=${MINZOOM:-0}
MAXZOOM=${MAXZOOM:-8}

[ -f "$JAR" ] || { echo "encode.jar が見つからない: $JAR" >&2; exit 1; }

mkdir -p "$OUT"
# ファイル名が source-layer 名になる。ビューワの sourceLayer: 'hypocenter' に合わせる
GEOJSON="$OUT/hypocenter.geojson"
MBTILES="$OUT/hypocenter.mbtiles"

echo "=== 1. CSV → GeoJSONSeq ==="
# 属性はビューワのポップアップが使うものに絞る。全22列を載せるとタイルが太る。
# 深さとマグニチュードは --float にする。整数値のまま出すとMVT内でINT/DOUBLEが
# 混在し、MLTエンコーダが型エラーで止まる。
python3 src/csv2geojsonseq.py "$CSV" "$GEOJSON" \
  --lon longitude --lat latitude \
  --keep time --keep depth --keep mag --keep magType --keep place --keep id \
  --float depth --float mag

echo "=== 2. GeoJSONSeq → MVT（tippecanoe）==="
# --drop-densest-as-needed : 低ズームは間引く。間引かないと1タイルが巨大になる
# --no-tile-compression    : MLTエンコーダが非圧縮PBFを要求する
tippecanoe --no-tile-compression -Z"$MINZOOM" -z"$MAXZOOM" -l hypocenter \
  --drop-densest-as-needed -o "$MBTILES" "$GEOJSON" --force 2>&1 | tail -3

echo "=== 3. MVT → MLT（encode.jar）==="
rm -rf "$OUT/mlt" "$OUT/tiles"
mkdir -p "$OUT/mlt"
java -jar "$JAR" --mbtiles "$MBTILES" --dir "$OUT/mlt"

echo "=== 4. MLT(mbtiles) → XYZ ==="
python3 src/explode_mbtiles.py "$OUT/mlt/hypocenter.mlt.mbtiles" -o "$OUT/tiles" --ext mlt

total() { find "$1" -name "$2" -printf '%s\n' | awk '{s+=$1} END {print s+0}'; }
echo
echo "タイル数: $(find "$OUT/tiles" -name '*.mlt' | wc -l)（z$MINZOOM-$MAXZOOM）"
printf 'MLT: %12d B\n' "$(total "$OUT/tiles" '*.mlt')"
echo "出力: $OUT/tiles"
