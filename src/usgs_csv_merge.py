"""usgs_event_dl.py が落とした期間ごとのCSVを1本にまとめる。

  python src/usgs_csv_merge.py work/raw work/earthquakes.csv

期間は重ならないように取っているが、境界の00:00:00ちょうどの地震は
隣り合う2つのファイルに入りうる。**イベントID（`id`列）で重複を落とす**。

FDSNは `orderby=time`（新しい順）で返すので、ファイル内は降順。
ファイル名の開始日で並べ、各ファイルを逆順に読むことで、
全体を時刻の昇順にする。100万件を一度にメモリへ載せずに済む。

`type` は earthquake のほかに quarry blast / explosion / ice quake などがある。
既定では落とさない。落とすなら --only-earthquake を付ける。
"""
import argparse
import csv
import glob
import io
import os
import re
import sys

START_IN_NAME = re.compile(r'query-(\d{4}-\d{2}-\d{2})-')


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('raw_dir', help='期間ごとのCSVが並ぶディレクトリ')
    parser.add_argument('output_csv', help='まとめた先')
    parser.add_argument('--only-earthquake', action='store_true',
                        help='type が earthquake の行だけを残す')
    return parser.parse_args()


def sort_key(path):
    m = START_IN_NAME.search(os.path.basename(path))
    return m.group(1) if m else os.path.basename(path)


def main():
    args = parse_args()
    files = sorted(glob.glob(os.path.join(args.raw_dir, 'query-*.csv')), key=sort_key)
    if not files:
        sys.exit(f'{args.raw_dir} にCSVがありません')

    header = None
    seen = set()
    total = written = duplicated = filtered = 0

    with io.open(args.output_csv, 'w', encoding='utf-8', newline='\n') as sink:
        writer = None
        for path in files:
            with io.open(path, encoding='utf-8', newline='') as source:
                rows = list(csv.reader(source))
            if not rows:
                continue
            if header is None:
                header = rows[0]
                writer = csv.writer(sink, lineterminator='\n')
                writer.writerow(header)
            elif rows[0] != header:
                sys.exit(f'{path} の列が他と違います')
            id_at = header.index('id')
            type_at = header.index('type')
            # ファイル内は新しい順なので逆から読む
            for row in reversed(rows[1:]):
                total += 1
                if not row:
                    continue
                if row[id_at] in seen:
                    duplicated += 1
                    continue
                seen.add(row[id_at])
                if args.only_earthquake and row[type_at] != 'earthquake':
                    filtered += 1
                    continue
                writer.writerow(row)
                written += 1

    print(f'{len(files)}ファイル -> {args.output_csv}')
    note = f'重複ID {duplicated}件を除外'
    if args.only_earthquake:
        note += f'、earthquake以外 {filtered}件を除外'
    print(f'  入力 {total:,}行 / 出力 {written:,}行（{note}）')


if __name__ == '__main__':
    main()
