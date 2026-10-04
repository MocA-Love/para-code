// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 承認カードに出す「危険な操作」ラベルの判定。
 *
 * エージェントが実行の許可を求めてきたコマンドから、取り消しの利かない操作
 * （再帰削除・強制 push・履歴の破棄・管理者権限など）を拾い、短い呼び名にして返す。
 * 許可ボタンを押す前に目に入るようにするためのもので、網羅的な安全判定ではない
 * （拾えなかったから安全、という意味にはならない）。
 *
 * 並びは下の表の順で固定し、同じ呼び名は1回だけ返す。
 */

/** ラベルの呼び名。画面にそのまま出すので短く保つ。 */
export type DangerousCommandLabel =
	| '削除を含む'
	| '強制 push'
	| '履歴を書き換える'
	| '管理者権限'
	| '権限を一括変更'
	| 'DB を削除'
	| 'ディスクを上書き';

/**
 * コマンドの区切り（行頭・空白・`;` `&` `|` `(` `)` `` ` ``）と引用符（`sh -c "rm -rf …"` の中のコマンド）の直後から
 * 始まる語だけを拾う。
 */
const START = '(?:^|[\\s;&|()`"\'])';
/** 同じコマンドの範囲（次の区切り記号や改行の手前まで）。 */
const SAME_COMMAND = '[^;&|\\n]*?';

const RULES: readonly { readonly label: DangerousCommandLabel; readonly pattern: RegExp }[] = [
	// rm -r / -rf / -fr / -R / --recursive。`docker run --rm` の `--rm` は語頭が `-` なので拾わない。
	{ label: '削除を含む', pattern: new RegExp(`${START}rm(?=\\s)${SAME_COMMAND}\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\\s|$)`, 'm') },
	// git clean -f / -fd / -xdf / --force（追跡していないファイルを消す）。
	{ label: '削除を含む', pattern: new RegExp(`${START}git(?=\\s)${SAME_COMMAND}\\bclean\\b${SAME_COMMAND}\\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\\s|$)`, 'm') },
	// git push --force / --force-with-lease / -f（-uf のようにまとめた指定も含む）。
	{ label: '強制 push', pattern: new RegExp(`${START}git(?=\\s)${SAME_COMMAND}\\bpush\\b${SAME_COMMAND}\\s(?:--force(?:-with-lease)?(?:=\\S*)?|-[a-zA-Z]*f[a-zA-Z]*)(?=\\s|$)`, 'm') },
	{ label: '履歴を書き換える', pattern: new RegExp(`${START}git(?=\\s)${SAME_COMMAND}\\breset\\b${SAME_COMMAND}\\s--hard(?=\\s|$)`, 'm') },
	{ label: '管理者権限', pattern: new RegExp(`${START}sudo(?=\\s|$)`, 'm') },
	{ label: '権限を一括変更', pattern: new RegExp(`${START}(?:chmod|chown)(?=\\s)${SAME_COMMAND}\\s(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)(?=\\s|$)`, 'm') },
	{ label: 'DB を削除', pattern: /\bdrop\s+(?:table|database|schema)\b/i },
	{ label: 'ディスクを上書き', pattern: new RegExp(`${START}mkfs(?:\\.\\w+)?(?=\\s|$)`, 'm') },
	{ label: 'ディスクを上書き', pattern: new RegExp(`${START}dd(?=\\s)${SAME_COMMAND}\\sif=`, 'm') },
	// `> /dev/null` や `2>/dev/stderr` のような捨て先・標準出力への書き込みは日常的なので除く。
	{ label: 'ディスクを上書き', pattern: />\s*\/dev\/(?!null\b|stdout\b|stderr\b|stdin\b|tty\b|fd\/)\w/ },
];

/** コマンド（または承認の詳細文）に含まれる危険な操作の呼び名。無ければ空配列。 */
export function dangerousCommandLabels(command: string | undefined): DangerousCommandLabel[] {
	if (command === undefined || command.length === 0) {
		return [];
	}
	const labels: DangerousCommandLabel[] = [];
	for (const rule of RULES) {
		if (!labels.includes(rule.label) && rule.pattern.test(command)) {
			labels.push(rule.label);
		}
	}
	return labels;
}
