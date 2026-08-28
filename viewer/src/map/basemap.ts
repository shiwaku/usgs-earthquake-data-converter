import type { StyleSpecification } from 'maplibre-gl'
import type { Theme } from '../theme'

/**
 * 背景地図。全球を1枚で覆えて、鍵のいらないものだけを使う。
 *
 * 姉妹リポジトリ（日本域）は地理院のベクトルタイルを読み、ダークテーマは
 * スタイルの色を明度反転して作っていた。全球版は OpenFreeMap が
 * ライトとダークの両方を用意しているのでそれをそのまま読む。
 *
 * CARTO のラスタ（basemaps.cartocdn.com）は鍵が要るようになっていて、
 * タイルに「API KEY REQUIRED」と焼き込まれて返る。使わない。
 */

const ESRI_ATTRIBUTION =
  'Esri, Maxar, Earthstar Geographics, and the GIS User Community'

export type Basemap = 'map' | 'satellite'

/** OpenFreeMap のスタイル。鍵も登録も要らず、全球のベクトルタイルを配信している。 */
const OPENFREEMAP = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
}

function satelliteStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 18,
        attribution: ESRI_ATTRIBUTION,
      },
    },
    layers: [
      // タイルが届く前でも球が黒く抜けないようにする
      { id: 'background', type: 'background', paint: { 'background-color': '#0b1020' } },
      { id: 'base', type: 'raster', source: 'base' },
    ],
  } as StyleSpecification
}

/**
 * スタイルはURL（ベクトル）とオブジェクト（ラスタ）が混ざる。
 * MapLibre の `setStyle` と Map のコンストラクタはどちらも受け取れる。
 */
export function getBasemapStyle(base: Basemap, theme: Theme): StyleSpecification | string {
  if (base === 'satellite') return satelliteStyle()
  return theme === 'dark' ? OPENFREEMAP.dark : OPENFREEMAP.light
}
