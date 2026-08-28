import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl'

import { depthColor } from './layers/depthScale'
import { PointCloudLayer, type PointCloudPoint } from './pointCloudLayer'
import type { AppStore, Selection } from '../state'

/**
 * 震源を深さで立体表示する。
 *
 * データは震源レイヤーのMLTソースをそのまま使う。取得は1系統で、タイルの読み込みは
 * MapLibreに任せ、読み込まれた地物を querySourceFeatures で拾って点群に足していく。
 *
 * 描画は map/pointCloudLayer.ts（MapLibreのカスタムレイヤー）。deck.gl を使わない
 * 理由はそちらに書いてある。要は globe で傾けると deck.gl の点が地図から外れるため。
 */

/** 点群のソース。レイヤーキーとMLTのsource-layer名。 */
const SOURCES: [string, string][] = [['hypocenter', 'hypocenter']]

const LAYER_ID = 'hypocenter-3d'

interface CachedPoint extends PointCloudPoint {
  /** 地物の同一性。重複を落とすために持つ。 */
  id: string
  /** 由来のレイヤーキー。表示中のものだけを描くために持つ。 */
  source: string
}

/**
 * 点の同一性。イベントIDは一意（USGSのIDはネットワーク接頭辞＋連番）なので、
 * 気象庁版と違って座標を混ぜる必要はない。
 */
function featureKey(p: Record<string, unknown>): string {
  return String(p['id'] ?? '')
}

/** 立体表示の点を画面座標で拾う口。クリック処理（map/interactions.ts）が使う。 */
export interface Hypocenter3dPicker {
  /** その位置に点があるか。カーソル形状の判定に使う。 */
  hitTest(x: number, y: number): boolean
  /** その位置の点を属性ごと拾う。当たらなければ null。 */
  pick(x: number, y: number): Selection | null
}

export function createHypocenter3d(map: MapLibreMap, store: AppStore): Hypocenter3dPicker {
  const layer = new PointCloudLayer(LAYER_ID)
  // querySourceFeatures はタイルのロード・アンロードで返る集合が変動する。
  // 取得したものを加算キャッシュして削除しないことで、点の明滅を防ぐ。
  const cache = new Map<string, CachedPoint>()
  // GPUへ上げた並び。ピッキングが返す番号をこれで点に戻す。
  let order: CachedPoint[] = []
  let pending = false
  let added = false

  function collect(): void {
    pending = false
    if (!store.get().depth3d) return
    let grew = false
    for (const [source, sourceLayer] of SOURCES) {
      if (!map.getSource(source)) continue
      for (const f of map.querySourceFeatures(source, { sourceLayer })) {
        const p = f.properties ?? {}
        const g = f.geometry
        if (g?.type !== 'Point') continue
        const id = featureKey(p)
        if (!id || cache.has(id)) continue
        const [lng, lat] = g.coordinates as [number, number]
        // 深さはkm。地下は負の標高になる。USGSは地表より上（負の深さ）も持つ
        const km = Number(p['depth'])
        const depth = Number.isFinite(km) ? km : 0
        const mercator = MercatorCoordinate.fromLngLat([lng, lat])
        cache.set(id, {
          id,
          source,
          x: mercator.x,
          y: mercator.y,
          elevation: -depth * 1000,
          color: depthColor(depth),
        })
        grew = true
      }
    }
    if (grew) upload()
  }

  function schedule(): void {
    if (pending) return
    pending = true
    requestAnimationFrame(collect)
  }

  /** 表示中のレイヤーぶんだけをGPUへ上げ直す。 */
  function upload(): void {
    const layers = store.get().layers
    const visible: CachedPoint[] = []
    for (const point of cache.values()) {
      if (layers[point.source]?.visible) visible.push(point)
    }
    // 不透明度はレイヤーパネルの値。点の重なりで密度を見せるので上限を抑える。
    const state = layers[SOURCES[0][0]]
    layer.opacity = (state?.opacity ?? 1) * BASE_OPACITY
    order = visible
    layer.setPoints(visible, visible.length)
  }

  function enable(): void {
    if (!added) {
      // データ層の上に置く。地図の一番手前で描く
      map.addLayer(layer)
      map.on('sourcedata', onSourceData)
      map.on('moveend', schedule)
      added = true
    }
    schedule()
  }

  function disable(): void {
    cache.clear()
    order = []
    layer.setPoints([], 0)
  }

  /**
   * 拾った点に対応する地物の属性。
   * 点群は表示に要る値しか持たない（全点ぶんの属性を抱えるとメモリを食う）ため、
   * 拾えたときだけソースから引き直す。
   */
  function propertiesOf(point: CachedPoint): Record<string, unknown> | null {
    const entry = SOURCES.find(([source]) => source === point.source)
    if (!entry || !map.getSource(point.source)) return null
    const feats = map.querySourceFeatures(point.source, {
      sourceLayer: entry[1],
      filter: ['==', ['to-string', ['get', 'id']], point.id],
    })
    const hit = feats[0]
    return hit ? ((hit.properties ?? {}) as Record<string, unknown>) : null
  }

  function onSourceData(e: { sourceId?: string; sourceDataType?: string }): void {
    if (e.sourceDataType === 'metadata') return
    if (!SOURCES.some(([id]) => id === e.sourceId)) return
    schedule()
  }

  store.subscribe((s, prev) => {
    if (s.depth3d !== prev.depth3d) {
      if (s.depth3d) enable()
      else disable()
      return
    }
    if (s.layers !== prev.layers) {
      // 表示の切替は即座に反映する。新たにONになった分は idle 後に集め直す。
      upload()
      map.once('idle', schedule)
      return
    }
    if (s.depth3d && (s.theme !== prev.theme || s.basemap !== prev.basemap)) {
      // スタイルを作り直すとカスタムレイヤーも外れる
      added = false
      map.once('idle', () => {
        enable()
        schedule()
      })
    }
  })

  if (store.get().depth3d) {
    if (map.isStyleLoaded()) enable()
    else map.once('load', enable)
  }

  function pickPoint(x: number, y: number): CachedPoint | null {
    if (!store.get().depth3d) return null
    const index = layer.pick(x, y)
    return index === null ? null : (order[index] ?? null)
  }

  return {
    hitTest: (x, y) => pickPoint(x, y) !== null,

    pick(x, y) {
      const point = pickPoint(x, y)
      if (!point) return null
      const properties = propertiesOf(point)
      // タイルが入れ替わって元の地物が引けないことがある
      if (!properties) return null
      // 点はメルカトルで持っている。ポップアップは緯度経度で置くので戻す
      const coord = new MercatorCoordinate(point.x, point.y, 0).toLngLat()
      return {
        layerKey: point.source,
        properties,
        lng: coord.lng,
        lat: coord.lat,
        altitude: point.elevation,
      }
    },
  }
}

/**
 * 点の重ね合わせで密度を見せるための基準不透明度。
 * レイヤーパネルのスライダー値にこれを掛ける。濃くすると点が一枚の塊になって
 * 深さが読めなくなるため、上限をここで抑える。
 */
const BASE_OPACITY = 0.25
