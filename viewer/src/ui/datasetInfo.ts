import { esc } from '../lib/format'

/**
 * 収録データの要約。
 *
 * 件数はタイルを作った時点のもので、ビューワからは数えられない
 * （タイルは低ズームで間引かれており、読み込まれた分しか手元に来ない）。
 * データを作り直したらここも直すこと。
 */
const ROWS: [string, string][] = [
  ['震源（M2.5以上）', '約100万件'],
  ['収録期間', '1967年〜'],
  ['出典', 'USGS ANSS ComCat'],
]

export function createDatasetInfo(): void {
  const root = document.getElementById('dataset-info') as HTMLElement | null
  if (!root) return
  root.innerHTML = ROWS.map(
    ([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`,
  ).join('')
}
