"""USGS(ANSS ComCat)の震源データを FDSN Event Web Service から取得する。

  python src/usgs_event_dl.py work/raw --start 1967-01-01 --end 2026-08-28

期間を区切ってCSVを1本ずつ落とし、出力ディレクトリに並べる。
マージは usgs_csv_merge.py が行う。

**1リクエストの上限は20,000件**（`maxAllowed`）。超えると400が返って何も取れない。
年で投げてみて超えたら月へ、月でも超えたら日へと自動的に割る。
1967年は年間数千件だが2011年3月のような月は日単位でも一万件を超える日がある。

取得済みのファイルは飛ばすので、途中で止めても同じコマンドで再開できる。
"""
import argparse
import csv
import io
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta

BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query'
COUNT = 'https://earthquake.usgs.gov/fdsnws/event/1/count'

# 上限は20,000。余裕を持たせて、これを超えそうなら割る
LIMIT = 18000

# 連絡先を入れておく。FDSNは素性の分からない大量アクセスを弾くことがある
USER_AGENT = 'usgs-earthquake-data-converter (+https://github.com/shiwaku/usgs-earthquake-data-converter)'

RETRY = 4
RETRY_WAIT = 5


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('out_dir', help='CSVを並べる出力ディレクトリ')
    parser.add_argument('--start', required=True, help='開始日 YYYY-MM-DD')
    parser.add_argument('--end', required=True, help='終了日 YYYY-MM-DD（この日を含む）')
    parser.add_argument('--min-magnitude', type=float, default=2.5,
                        help='最小マグニチュード（既定: 2.5）')
    return parser.parse_args()


def fetch(url):
    """GETしてテキストを返す。落ちたら間を空けて数回やり直す。"""
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    for attempt in range(RETRY):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return response.read().decode('utf-8')
        except (urllib.error.URLError, TimeoutError) as e:
            # 400は「上限超え」なので、やり直さず呼び出し側へ返す
            if isinstance(e, urllib.error.HTTPError) and e.code == 400:
                return None
            if attempt == RETRY - 1:
                raise
            print(f'    再試行 {attempt + 1}/{RETRY - 1}: {e}', file=sys.stderr)
            time.sleep(RETRY_WAIT * (attempt + 1))
    return None


def count_events(start, end, min_magnitude):
    """その期間の件数。上限を超えている場合も件数だけは返ってくる。"""
    query = urllib.parse.urlencode({
        'format': 'geojson', 'starttime': start.isoformat(),
        'endtime': (end + timedelta(days=1)).isoformat(),
        'minmagnitude': min_magnitude,
    })
    text = fetch(f'{COUNT}?{query}')
    if text is None:
        return None
    # {"count":25153,...} か {"count":25153,"maxAllowed":20000,"error":"..."}
    import json
    return json.loads(text).get('count')


def download(start, end, min_magnitude, out_dir):
    """1期間ぶんを落とす。既にあれば飛ばす。"""
    import os
    path = os.path.join(out_dir, f'query-{start.isoformat()}-{end.isoformat()}.csv')
    if os.path.exists(path) and os.path.getsize(path) > 0:
        print(f'  済 {os.path.basename(path)}')
        return True
    query = urllib.parse.urlencode({
        'format': 'csv', 'starttime': start.isoformat(),
        'endtime': (end + timedelta(days=1)).isoformat(),
        'minmagnitude': min_magnitude, 'orderby': 'time',
    })
    text = fetch(f'{BASE}?{query}')
    if text is None:
        return False
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    rows = max(0, text.count('\n') - 1)
    print(f'  {os.path.basename(path)}  {rows:,}件')
    return True


def months(start, end):
    """[start, end] を月で割る。"""
    spans = []
    cursor = start.replace(day=1)
    while cursor <= end:
        nxt = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
        spans.append((max(cursor, start), min(nxt - timedelta(days=1), end)))
        cursor = nxt
    return spans


def days(start, end):
    return [(start + timedelta(days=i), start + timedelta(days=i))
            for i in range((end - start).days + 1)]


def walk(start, end, min_magnitude, out_dir, depth=0):
    """件数を見て、上限に収まる粒度まで割ってから落とす。"""
    n = count_events(start, end, min_magnitude)
    label = f'{start.isoformat()}〜{end.isoformat()}'
    if n is None:
        print(f'{label}: 件数が取れなかった。割って試す', file=sys.stderr)
        n = LIMIT + 1
    if n == 0:
        print(f'{label}: 0件')
        return
    if n <= LIMIT:
        print(f'{label}: {n:,}件')
        if download(start, end, min_magnitude, out_dir):
            return
        print(f'{label}: 取得に失敗。割って試す', file=sys.stderr)
    # 年 → 月 → 日 の順に割る
    if depth == 0:
        spans = months(start, end)
    elif depth == 1:
        spans = days(start, end)
    else:
        sys.exit(f'{label}: 1日で上限を超えている。--min-magnitude を上げて分けてください')
    print(f'{label}: {n:,}件 → {len(spans)}分割')
    for s, e in spans:
        walk(s, e, min_magnitude, out_dir, depth + 1)


def main():
    args = parse_args()
    import os
    os.makedirs(args.out_dir, exist_ok=True)
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)
    if start > end:
        sys.exit('--start が --end より後になっています')

    # 年で切ってから、必要な年だけ細かく割る
    for year in range(start.year, end.year + 1):
        y0 = max(start, date(year, 1, 1))
        y1 = min(end, date(year, 12, 31))
        walk(y0, y1, args.min_magnitude, args.out_dir)

    print('取得終了')


if __name__ == '__main__':
    main()
