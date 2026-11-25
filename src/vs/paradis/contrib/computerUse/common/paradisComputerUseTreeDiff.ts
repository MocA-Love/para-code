/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 操作の後に返すアクセシビリティのツリーを、前に返したツリーとの差分にする。
//
// 守ること: 「エージェントが覚えている番号は、同じ要素に当たるか、はっきり失敗する」。番号は補助アプリが読むたびに
// 深さ優先で振り直すので、上に 1 行増えるだけで、それより下の番号は別の要素を指す。そこで差分は番号ごとに
// 行の全文（役割・名前・値・位置・字下げ）で比べ、同じ番号で 1 字でも違えば「変わった」として出す。番号がずれると
// ずれた先の行が軒並み「変わった」になり、差分が大きくなるので、そのときは差分をやめて全文を返す。
// 差分に出ない行は、番号も中身も前に返したものと同じ。

/** 差分にしてよい変化の上限（これを超えたら全文を返す）。行の数に対する割合と、行の数。 */
const MAX_CHANGED_RATIO = 0.3;
const MAX_CHANGED_LINES = 60;
/** 小さなツリーでも、この行数までの変化は差分にする。 */
const MIN_CHANGED_ALLOWANCE = 8;

export type ParadisComputerUseTreeDiff =
	/** 差分にできない（途中で切れたツリー、前のツリーが無い、変化が大きい）。全文を返すこと。 */
	| { readonly kind: 'full' }
	/** 1 行も変わっていない。 */
	| { readonly kind: 'unchanged'; readonly elements: number }
	/** `~` 変わった・`+` 増えた・`-` 消えた、の行（今のツリーの順。消えた行は最後）。 */
	| { readonly kind: 'changes'; readonly lines: readonly string[]; readonly elements: number };

/** ツリーの 1 行の番号（`  [12] AXButton …` の 12）。番号の無い行（切れた・隠した数の知らせ）は undefined。 */
export function paradisComputerUseTreeLineIndex(line: string): number | undefined {
	const match = /^\s*\[(?<index>\d+)\]/.exec(line);
	return match?.groups ? Number(match.groups.index) : undefined;
}

function isTruncated(lines: readonly string[]): boolean {
	return lines.some(line => line.trim() === '... (tree truncated)');
}

/**
 * 前に返したツリーと今のツリーの差分。番号の無い行（隠した入れ物の数など）が違うだけなら、変わっていないとみなす。
 */
export function paradisComputerUseDiffTree(previous: string | undefined, current: string): ParadisComputerUseTreeDiff {
	if (previous === undefined) {
		return { kind: 'full' };
	}
	const before = previous.split('\n');
	const after = current.split('\n');
	if (isTruncated(before) || isTruncated(after)) {
		return { kind: 'full' };
	}
	const old = new Map<number, string>();
	for (const line of before) {
		const index = paradisComputerUseTreeLineIndex(line);
		if (index !== undefined) {
			old.set(index, line);
		}
	}
	const lines: string[] = [];
	const seen = new Set<number>();
	let elements = 0;
	for (const line of after) {
		const index = paradisComputerUseTreeLineIndex(line);
		if (index === undefined) {
			continue;
		}
		elements++;
		seen.add(index);
		const was = old.get(index);
		if (was === undefined) {
			lines.push(`+ ${line}`);
		} else if (was !== line) {
			lines.push(`~ ${line}`);
		}
	}
	for (const [index, line] of old) {
		if (!seen.has(index)) {
			lines.push(`- ${line.trim()}`);
		}
	}
	if (lines.length === 0) {
		return { kind: 'unchanged', elements };
	}
	if (lines.length > MAX_CHANGED_LINES || lines.length > Math.max(MIN_CHANGED_ALLOWANCE, Math.floor(Math.max(elements, old.size) * MAX_CHANGED_RATIO))) {
		return { kind: 'full' };
	}
	return { kind: 'changes', lines, elements };
}
