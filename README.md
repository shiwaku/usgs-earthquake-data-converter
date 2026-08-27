# usgs-earthquake-data-converter

USGS（ANSS ComCat）の全球震源データを FDSN Event Web Service から取得し、GISデータ（CSV / GeoParquet / PMTiles / MLT）へ変換して、MapLibre GL JS のビューワで**地球儀（globe）表示**するためのリポジトリです。

日本域を扱う姉妹リポジトリ [jma-earthquake-data-converter](https://github.com/shiwaku/jma-earthquake-data-converter)（気象庁 地震月報(カタログ編)）の全球版にあたります。変換の流れとビューワの構成は基本的にそちらに合わせてあります。

| 収録 | 件数 | 期間 |
|---|---|---|
| 震源（M2.5以上・全球） | 取得時点による | 1967年〜 |

## 元データ — USGS FDSN Event Web Service

気象庁が固定長テキストのファイルを年別に配布しているのに対し、USGSは**Web APIで期間を指定して取る**形です。

- APIドキュメント: https://earthquake.usgs.gov/fdsnws/event/1/
- カタログ: ANSS ComCat（各地の観測網の震源を統合したもの）

> [!IMPORTANT]
> **1リクエストの上限は20,000件**です。超えると400が返り、1件も取れません。`src/usgs_event_dl.py` は年で投げてみて超えたら月へ、月でも超えたら日へと自動的に割ります。

M2.5以上に絞っているのは、これがカタログの実質的な網羅性の境目だからです。これより小さい地震は米国内の観測網が密な地域に強く偏り、全球の分布として見ると地域差が観測網の密度を映してしまいます。

## クイックスタート

### ビューワだけ動かす

配信済みのタイルを読むので、変換は不要です。

```bash
cd viewer
npm ci
npm run dev
```

### データを取り直す

```bash
# 1. 取得（期間ごとにCSVが並ぶ。途中で止めても同じコマンドで再開できる）
python src/usgs_event_dl.py work/raw --start 1967-01-01 --end 2026-08-28

# 2. 1本にまとめる（イベントIDで重複を落とし、時刻の昇順にする）
python src/usgs_csv_merge.py work/raw work/earthquakes.csv

# 3. タイルにする
bash src/build_mlt_tiles.sh work/earthquakes.csv work/mlt
```

## 列

FDSNのCSVをそのまま持ちます。

```
time,latitude,longitude,depth,mag,magType,nst,gap,dmin,rms,net,id,
updated,place,type,horizontalError,depthError,magError,magNst,status,
locationSource,magSource
```

- `depth` は km。負の値（地表より上）もあり、これは震源が浅すぎて決められなかった場合に使われます
- `type` は `earthquake` のほかに `quarry blast` / `explosion` / `ice quake` などがあります。既定では落としていません
- `id` はイベントID（`us6000tkp2` のような形）。ネットワーク接頭辞＋連番で、**一意**です

> [!NOTE]
> 姉妹リポジトリの気象庁データは地震IDが発生時刻そのもの（14桁）で一意ではありませんが、USGSは一意です。突き合わせの問題は起きません。

## ライセンス

コードは MIT License です。データの出典は [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/) です。
