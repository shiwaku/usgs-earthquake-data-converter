import { Popup, type Map as MapLibreMap } from 'maplibre-gl'

import { layerByKey } from './layers/registry'
import type { AppStore } from '../state'

/**
 * 選択された地物の属性を出すポップアップ。開閉は state.selection に従う。
 *
 * **ポップアップは地表に出る。** 選択は地表の当たり判定（不可視の円）で拾っており、
 * 深さ方向に配置された点そのものを拾ってはいない。深い地震では画面上の点と
 * ポップアップの位置がずれる。点群側の当たり判定は未実装。
 */
export function createPopup(map: MapLibreMap, store: AppStore): void {
  let popup: Popup | null = null

  function close(): void {
    if (!popup) return
    // close ハンドラの誤発火を防ぐため、参照を外してから remove する
    const old = popup
    popup = null
    old.remove()
  }

  function render(): void {
    close()
    const { selection, eventId, theme } = store.get()
    if (!selection) return
    const mod = layerByKey(selection.layerKey)
    if (!mod) return

    const p = new Popup({ closeButton: true, maxWidth: '320px' })
      .setLngLat([selection.lng, selection.lat])
      .setHTML(mod.popupHtml(selection.properties, selection.lng, selection.lat, { eventId, theme }))
      .addTo(map)
    p.on('close', () => {
      if (popup !== p) return
      popup = null
      store.set({ selection: null })
    })
    popup = p
  }

  store.subscribe((s, prev) => {
    if (s.selection !== prev.selection) render()
  })
}
