# usgs-earthquake-data-converter

[![Demo](https://img.shields.io/badge/demo-世界の震源マップ-2a78d6)](https://shiwaku.github.io/usgs-earthquake-data-converter/)

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

## 配信

タイルは Cloudflare R2 に置いています。

| データ | URL | ズーム |
|---|---|---|
| 震源（M2.5以上） | `https://shi-works.com/mlt/usgs-hypocenter/{z}/{x}/{y}.mlt` | 0〜8 |

配信元は `viewer/.env` の `VITE_PMTILES_BASE` で切り替えられます。

## ビューワ（`viewer/`）

Vite + TypeScript + MapLibre GL JS 6 で構築しています。**地球儀（globe）表示**で、傾けると震源が深さ方向に配置されて立体に見えます。

### deck.gl を使っていません

姉妹リポジトリ（日本域）は震源の点群を deck.gl で描いていますが、全球版では使えませんでした。

`@deck.gl/mapbox` は globe 投影のとき `_GlobeView` に切り替わりますが、その `GlobeViewState` には **pitch も bearing もありません**。地図は傾いて描かれ、deck.gl は真上から描くので、傾けた瞬間に点が地図から外れます。

代わりに MapLibre が custom layer 向けに公開している `projectTileFor3D` を使っています（`viewer/src/map/pointCloudLayer.ts`）。globe でもメルカトルでも、標高付きの位置を地図と同じ式で投影します。globe では球（半径 6371008.8m）からの標高(m)として扱われるので、深さは負の標高としてそのまま渡せます。

> [!NOTE]
> 3D経路（`projectTileFor3D`）は球の裏側をクリップしません。2D経路（`projectTile`）が深度を上書きして行っているクリップを、こちらでは `u_projection_clipping_plane` を使って頂点側で落としています。

クリック判定は**GPUピッキング**です。同じシェーダに頂点番号を色として描かせ、クリック位置の画素を読み戻します。点は最大百万件あり、JS側で1点ずつ投影して探すのは重いうえ、globe の投影式は MapLibre のシェーダの中にしかないためです。

### 背景地図

- 地図: [OpenFreeMap](https://openfreemap.org/)（`positron` / `dark`）
- 衛星: Esri World Imagery

> [!WARNING]
> CARTO のラスタ（`basemaps.cartocdn.com`）は鍵が要るようになっていて、タイルに「API KEY REQUIRED」が焼き込まれて返ります。使えません。

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
