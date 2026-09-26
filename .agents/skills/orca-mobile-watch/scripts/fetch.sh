#!/usr/bin/env bash
# Orca の mobile まわりの、前回確認した SHA 以降のコミットと差分を集める。
# 使い方: fetch.sh [出力ディレクトリ]（既定: /tmp/orca-mobile-watch）
# 環境変数 ORCA_WATCH_SINCE=<sha> で、state.json の代わりに起点を指定できる（見直し・試験用）。
# 出力: commits.tsv（sha, 日時, 題名, PR 番号）, files.tsv（sha, 状態, パス）, diffs/<sha>.patch, range.txt
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$SKILL_DIR/state.json"
OUT="${1:-/tmp/orca-mobile-watch}"
CLONE="${ORCA_WATCH_CLONE:-$HOME/.cache/orca-mobile-watch/orca}"
REPO_URL="https://github.com/stablyai/orca.git"
# 見る範囲。mobile 本体に加えて、モバイルのドキュメントと UI の決まりごと。
PATHS=(mobile docs/site/content/docs/mobile.mdx docs/STYLEGUIDE.md)

since_sha="${ORCA_WATCH_SINCE:-$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['lastReviewedSha'])" "$STATE")}"
mkdir -p "$OUT/diffs" "$(dirname "$CLONE")"
rm -f "$OUT"/diffs/*.patch

if [ ! -d "$CLONE/.git" ]; then
	git clone -q --filter=blob:none --no-checkout "$REPO_URL" "$CLONE"
fi
git -C "$CLONE" fetch -q origin main
head_sha="$(git -C "$CLONE" rev-parse origin/main)"

if ! git -C "$CLONE" cat-file -e "$since_sha^{commit}" 2>/dev/null; then
	echo "前回の SHA ($since_sha) が見つからない。state.json を確認すること" >&2
	exit 2
fi

echo "$since_sha..$head_sha" > "$OUT/range.txt"
git -C "$CLONE" log --reverse --format='%H%x09%cI%x09%s' "$since_sha..origin/main" -- "${PATHS[@]}" \
	| awk -F'\t' '{ pr=""; if (match($3, /\(#[0-9]+\)$/)) pr=substr($3, RSTART+2, RLENGTH-3); print $1"\t"$2"\t"$3"\t"pr }' > "$OUT/commits.tsv"
: > "$OUT/files.tsv"
while IFS=$'\t' read -r sha _date _subject _pr; do
	git -C "$CLONE" show --format= --name-status "$sha" -- "${PATHS[@]}" | awk -v s="$sha" -F'\t' '{ print s"\t"$1"\t"$NF }' >> "$OUT/files.tsv"
	git -C "$CLONE" show --format='%H%n%s%n%n%b' --stat --patch "$sha" -- "${PATHS[@]}" > "$OUT/diffs/$sha.patch"
done < "$OUT/commits.tsv"

echo "範囲: $since_sha..$head_sha"
echo "コミット数: $(wc -l < "$OUT/commits.tsv" | tr -d ' ')"
echo "変更ファイル数（延べ）: $(wc -l < "$OUT/files.tsv" | tr -d ' ')"
echo "出力: $OUT"
