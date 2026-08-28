import {
  AttributionControl,
  FullscreenControl,
  GeolocateControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  addProtocol,
  setWorkerUrl,
} from 'maplibre-gl'
// maplibre 6 はワーカーの場所を実行時に import.meta.url から決める（同じ階層に
// maplibre-gl-worker.mjs がある前提）。バンドルすると import.meta.url は
// assets/index-*.js を指すためワーカーが404になり、タイルが1枚も復号されない。
// 症状は「地図が真っ白なまま load イベントが飛ばず、データレイヤーも追加されない」。
// ?worker&url でVite側にワーカーを別チャンクとして吐かせ、そのURLを渡して回避する。
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Protocol } from 'pmtiles'

import { isMobile } from '../lib/env'
import type { AppState } from '../state'
import { getBasemapStyle } from './basemap'

setWorkerUrl(workerUrl)

const ATTRIBUTION =
  '<a href="https://earthquake.usgs.gov/" target="_blank" rel="noreferrer">USGS Earthquake Hazards Program</a>'

export function createMap(container: string, state: AppState): MapLibreMap {
  const protocol = new Protocol()
  addProtocol('pmtiles', protocol.tile)

  const map = new MapLibreMap({
    container,
    style: getBasemapStyle(state.basemap, state.theme),
    // 全球版なので地球全体が入る位置から始める。環太平洋の火山帯が正面に来るよう
    // 太平洋側を中心に置く。
    center: [150, 10],
    zoom: 1.6,
    // 傾きは付けない。真上から地球儀を見せてから、利用者が傾けて深さを見る。
    pitch: 0,
    // 既定の上限は60。震源の深さを断面のように見るには浅すぎるので上げる。
    // maplibre は 60 超を experimental としているが、地形を使っていないので影響は小さい。
    maxPitch: 85,
    // 位置は `#map=z/lat/lng/bearing/pitch` として書く。名前を付けておくと
    // MapLibre が自分のキーだけ差し替えるようになり、テーマなど自前の状態を
    // 同じハッシュに同居させられる（lib/urlState.ts）。
    hash: 'map',
    attributionControl: false,
    // モバイルのGPU・メモリ逼迫対策
    maxTileCacheSize: isMobile ? 24 : undefined,
    pixelRatio: isMobile ? Math.min(window.devicePixelRatio || 1, 2) : undefined,
  })

  // 全球表示。MapLibreの標準機能で、傾けても震源の点群（map/pointCloudLayer.ts）が
  // 追従する。スタイルを差し替えると戻ってしまうので、その都度かけ直す。
  map.on('style.load', () => map.setProjection({ type: 'globe' }))

  map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right')
  map.addControl(new FullscreenControl(), 'top-right')
  map.addControl(
    new GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }),
    'top-right')
  map.addControl(new ScaleControl({ maxWidth: 200, unit: 'metric' }), 'bottom-left')
  map.addControl(
    new AttributionControl({ compact: true, customAttribution: ATTRIBUTION }),
    'bottom-right')

  return map
}
