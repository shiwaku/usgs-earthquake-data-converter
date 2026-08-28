import type { LayerSpecification } from 'maplibre-gl'

import { mltTileUrl } from '../../lib/pmtiles'
import { coordFooter, esc, prop, row } from '../../lib/format'
import { depthLegendCss, depthLegendTicks } from './depthScale'
import type { LayerModule } from './types'

const KEY = 'hypocenter'

/**
 * 2Dの描画は行わない。震源は map/pointCloudLayer.ts の点群で深さ方向に配置して
 * 描いており、地表にも同じ点を描くと二重になる。
 *
 * ただしレイヤーを完全に無くすとMapLibreがタイルを読み込まなくなり、
 * querySourceFeatures で点を拾えず点群が空になる。そのため不透明度0の円を
 * 1枚だけ置いて、ソースとタイル読み込みだけを生かしている。
 * この円はクリック判定にも使う（ポップアップは地表側に出る）。
 */
const LOADER_ID = `${KEY}-loader`

/**
 * 数値属性を表示用に丸める。
 * MLTタイルの数値列は、整数値だけの列がINTとして書かれると型が混ざって
 * エンコーダが止まるため、作る側（src/csv2geojsonseq.py の FLOAT_OFFSET）で
 * +0.0001 して float に固定してある。ここで元の桁に戻す。
 */
function num(p: Record<string, unknown>, key: string, digits: number): string {
  const v = Number(p[key])
  return Number.isFinite(v) ? v.toFixed(digits) : ''
}

/**
 * USGS(ANSS ComCat)の震源。1967年以降・M2.5以上・全球。
 *
 * M2.5で切っているのはカタログの網羅性の境目だから。これより小さい地震は
 * 米国内の観測網が密な地域に強く偏り、全球の分布として見ると地域差が
 * 観測網の密度を映してしまう。
 */
export const hypocenterLayer: LayerModule = {
  def: {
    key: KEY,
    name: '震源（M2.5以上）',
    format: 'mlt',
    url: mltTileUrl('usgs-hypocenter'),
    minzoom: 0,
    maxzoom: 8,
    sourceLayer: 'hypocenter',
    defaultVisible: true,
    defaultOpacity: 1,
    desc:
      'USGS(ANSS ComCat)が公開している全球の震源です。1967年以降・マグニチュード2.5以上を収録しています。'
      + '\n\n'
      + '色は震源の深さを表します。浅いほど暖色、深いほど寒色という地震学の慣例に従っています。0〜500kmを等間隔に塗り、500kmより深いものは端の色になります。'
      + '\n\n'
      + '地図を傾けると、震源が深さ方向に配置されて立体に見えます。海溝から大陸側へ向かって深くなる震源の並び、すなわち沈み込むプレートの形が世界中で確かめられます。'
      + '\n\n'
      + 'マグニチュード2.5で切っているのは、カタログの網羅性の境目だからです。これより小さい地震は米国内の観測網が密な地域に強く偏るため、全球の分布として見ると地域差が観測網の密度を映してしまいます。',
    attribution:
      '<a href="https://earthquake.usgs.gov/" target="_blank" rel="noopener">USGS Earthquake Hazards Program</a>',
  },

  layerIds: [LOADER_ID],
  pickLayerId: LOADER_ID,

  specs(): LayerSpecification[] {
    return [
      {
        id: LOADER_ID,
        type: 'circle',
        source: KEY,
        'source-layer': this.def.sourceLayer,
        paint: { 'circle-radius': 3, 'circle-opacity': 0 },
      } as LayerSpecification,
    ]
  },

  // 見た目は点群側が持つ。2Dには反映するものがない。
  paintUpdates() {
    return []
  },

  filters() {
    // 分布そのものを見るためのレイヤーなので絞らない
    return [{ id: LOADER_ID, filter: null }]
  },

  legend() {
    return { kind: 'gradient', css: depthLegendCss(), ticks: depthLegendTicks() }
  },

  popupHtml(p, lng, lat) {
    // 列名は FDSN の CSV に合わせてある（src/build_mlt_tiles.sh の --keep を参照）
    const rows =
      row('発生時刻(UTC)', prop(p, 'time'), true) +
      row('深さ(km)', num(p, 'depth', 2)) +
      row('マグニチュード', `${num(p, 'mag', 1)}${prop(p, 'magType') ? ` (${prop(p, 'magType')})` : ''}`) +
      row('イベントID', prop(p, 'id'))
    const id = prop(p, 'id')
    const link = id
      ? `<div class="pp-foot"><a href="https://earthquake.usgs.gov/earthquakes/eventpage/${esc(id)}" target="_blank" rel="noopener">USGSのイベントページ</a></div>`
      : ''
    return (
      `<div class="pp-title">${esc(prop(p, 'place') || this.def.name)}</div>` +
      `<div class="pp-sub">${esc(this.def.name)}</div>` +
      (rows ? `<dl class="pp-dl">${rows}</dl>` : '') +
      coordFooter(lng, lat) +
      link
    )
  },
}
