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

/**
 * 点群に載せる点の上限。
 *
 * キャッシュは消さない設計（タイルの出入りで点が明滅するのを防ぐため）だが、
 * 消さないままだと触っているほど増え続け、setPoints の詰め直しも重くなる。
 * 上限を超えたら**拾った順に古いものから捨てる**。Mapは挿入順を保つのでそのまま使える。
 *
 * 50万点で詰め直し4.5ms・当たり判定8.3ms（ソフトウェアGL実測）。
 * 通常の閲覧で載る点は数万なので、長く触ったときだけ効く。
 */
const MAX_POINTS = 300_000

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
    if (!grew) return
    // 増えすぎたら古いものから捨てる
    if (cache.size > MAX_POINTS) {
      let over = cache.size - MAX_POINTS
      for (const key of cache.keys()) {
        cache.delete(key)
        if (--over <= 0) break
      }
    }
    upload()
  }

  /** ズームに応じた濃さ・大きさを点群へ渡す。 */
  function applyRamp(): void {
    const state = store.get().layers[SOURCES[0][0]]
    const ramp = rampFor(map.getZoom())
    // レイヤーパネルのスライダー値を掛ける
    layer.opacity = (state?.opacity ?? 1) * ramp.opacity
    layer.size = ramp.size
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
    order = visible
    applyRamp()
    layer.setPoints(visible, visible.length)
  }

  function enable(): void {
    if (!added) {
      // データ層の上に置く。地図の一番手前で描く
      map.addLayer(layer)
      map.on('sourcedata', onSourceData)
      map.on('moveend', schedule)
      // ズームで濃さが変わる。動かしている最中も追従させる
      map.on('zoom', applyRamp)
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
 * 点の濃さと大きさはズームで変える。
 *
 * タイルは低ズームほど強く間引かれる（tippecanoe の --drop-densest-as-needed）。
 * 引いた絵では点が少ないので、濃さを上げないと震源の並びが読めない。
 * 逆に寄ると点が一気に増え、濃いままだと重なって一枚の塊になり深さが読めなくなる。
 *
 * 実測: 全球版の初期表示（z1.6）は全世界で1,712点しかない。ここを0.25で描くと
 * ほとんど見えない。z10まで寄ると数十万点になるので、そこは薄くする。
 */
const RAMP = { minZoom: 4, maxZoom: 7, opacityNear: 0.25, opacityFar: 0.9, sizeNear: 2, sizeFar: 3 }

/** ズームから濃さと大きさを求める。低ズーム側で濃く・大きく。 */
function rampFor(zoom: number): { opacity: number; size: number } {
  const t = Math.min(1, Math.max(0, (zoom - RAMP.minZoom) / (RAMP.maxZoom - RAMP.minZoom)))
  return {
    opacity: RAMP.opacityFar + (RAMP.opacityNear - RAMP.opacityFar) * t,
    size: RAMP.sizeFar + (RAMP.sizeNear - RAMP.sizeFar) * t,
  }
}
