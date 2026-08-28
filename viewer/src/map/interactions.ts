import type { Map as MapLibreMap, Point } from 'maplibre-gl'

import { activePickIds } from './dataLayers'
import type { Hypocenter3dPicker } from './hypocenter3d'
import { layerByPickId } from './layers/registry'
import type { AppStore } from '../state'

/**
 * クリックで地物を選択し、ホバーでカーソルを変える。
 * 選択そのものは store に入れるだけで、描くのはポップアップ側の仕事。
 *
 * 当たり判定は2系統ある。地表に描かれるレイヤーはMapLibreに、深さ方向へ配置した
 * 震源の点は点群レイヤー（picker）に問い合わせる。見えている点を狙ってクリック
 * するのだから、立体表示の点を先に見る。
 */
export function createInteractions(map: MapLibreMap, store: AppStore, picker: Hypocenter3dPicker): void {
  // ホバーのカーソルはマウス環境だけ。タッチでは意味がないうえ、
  // mousemove がタップのたびに走ってしまう。
  if (window.matchMedia('(hover: hover)').matches) {
    // 立体表示の当たり判定は点群を丸ごと描いて読み戻すため、50万点で1回8msかかる。
    // mousemove のたび、あるいは毎フレーム走らせるには重すぎる。
    // カーソルが止まってから1回だけ見る。動かしている最中は判定しない。
    const SETTLE_MS = 120
    let timer: number | undefined
    let last: Point | null = null

    function updateCursor(): void {
      if (!last) return
      const ids = activePickIds(map, store.get())
      const hit =
        (ids.length > 0 && map.queryRenderedFeatures(last, { layers: ids }).length > 0) ||
        picker.hitTest(last.x, last.y)
      map.getCanvas().style.cursor = hit ? 'pointer' : ''
    }

    map.on('mousemove', (e) => {
      last = e.point
      // 動かしている間は前の判定結果のカーソルのままにする
      clearTimeout(timer)
      timer = window.setTimeout(updateCursor, SETTLE_MS)
    })
  }

  map.on('click', (e) => {
    // 見えているのは立体表示の点なので、そちらを先に見る
    const hit3d = picker.pick(e.point.x, e.point.y)
    if (hit3d) {
      store.set({ selection: hit3d })
      return
    }
    const ids = activePickIds(map, store.get())
    const feats = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids }) : []
    if (!feats.length) {
      store.set({ selection: null })
      return
    }
    // 最前面のものを採る。震源（×）→震度（点）→人口集中地区（面）の順に当たる。
    const f = feats[0]
    const mod = layerByPickId(f.layer.id)
    if (!mod) return
    store.set({
      selection: {
        layerKey: mod.def.key,
        properties: f.properties as Record<string, unknown>,
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
      },
    })
  })

  store.subscribe((s, prev) => {
    if (!s.selection) return
    // 地震を切り替えると、選択していた地物は地図から消える。
    // レイヤーを消したときも同じ。取り残されたポップアップを閉じる。
    const gone =
      s.eventId !== prev.eventId ||
      (s.layers !== prev.layers && !s.layers[s.selection.layerKey]?.visible)
    if (gone) store.set({ selection: null })
  })
}
