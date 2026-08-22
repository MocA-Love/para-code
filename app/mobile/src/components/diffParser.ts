// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * unified diff のパーサ。**React に依存しない純関数**として diffView.tsx から分離してある
 * （単体テストから直接叩けるように。swipeRowGeometry.ts と同じ流儀）。
 */

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffRow {
	kind: DiffRowKind;
	oldNo?: number;
	newNo?: number;
	text: string;
}

/** unified diff を表示行の配列にパースする（ファイルヘッダ行は省く）。 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('@@')) {
			const m = line.match(/^@@ -(?<oldStart>\d+)(?:,\d+)? \+(?<newStart>\d+)(?:,\d+)? @@(?<rest>.*)$/);
			if (m?.groups) {
				oldNo = parseInt(m.groups.oldStart ?? '1', 10);
				newNo = parseInt(m.groups.newStart ?? '1', 10);
				rows.push({ kind: 'hunk', text: line });
			}
		} else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('Binary files') || line.startsWith('\\')) {
			// ファイルメタ情報はビューアのヘッダで代替する（Binary等は文脈行として出さない）
			if (line.startsWith('Binary files')) {
				rows.push({ kind: 'hunk', text: line });
			}
		} else if (line.startsWith('+')) {
			// 未追跡ファイルの擬似diff（全行+でハンク見出しなし）は1行目から数える
			if (newNo === 0) {
				newNo = 1;
			}
			rows.push({ kind: 'add', newNo: newNo++, text: line.slice(1) });
		} else if (line.startsWith('-')) {
			if (oldNo === 0) {
				oldNo = 1;
			}
			rows.push({ kind: 'del', oldNo: oldNo++, text: line.slice(1) });
		} else if (line.startsWith(' ')) {
			// ハンク開始前の空行などは無視（ハンク内の文脈行のみ番号を進める）。
			// split('\n') が生む末尾の空文字列はここへ来ない——正当な空行のコンテキストは
			// 常にスペース1文字（' '）として届くため、この分岐だけで区別できる。
			if (oldNo > 0 || newNo > 0) {
				rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
			}
		}
	}
	return rows;
}
