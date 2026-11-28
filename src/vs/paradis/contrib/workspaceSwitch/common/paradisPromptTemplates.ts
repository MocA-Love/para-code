/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいスペース」の指示のテンプレート（q.html Q691）。中身はコマンドプリセットの「エージェント向けプロンプト」
// （action: agent-prompt）をそのまま使い、ダイアログは見出しの右のチップから 1 回押すだけで指示の欄へ入れる。
// ここには入れ方（どこへ入れて、どこを選ぶか）と名前の決め方だけを置く。プリセットを読む・書くのは呼び出し側。

/** ダイアログに出すテンプレート 1 件。 */
export interface IParadisPromptTemplate {
	/** 同じ名前が並んでも区別できる鍵（プリセットの key）。 */
	readonly key: string;
	readonly name: string;
	readonly prompt: string;
}

/** 入れた直後に選ぶ「穴」。`{{Issue の URL}}` のように書いておくと、貼るか打つだけで置き換わる。 */
const PARADIS_PROMPT_TEMPLATE_HOLE = /\{\{[^{}\n]*\}\}/;

/** テンプレートの名前の上限（チップと一覧の見出し）。 */
const PARADIS_PROMPT_TEMPLATE_NAME_MAX_CHARS = 24;

export interface IParadisPromptTemplateInsertion {
	readonly value: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

/**
 * 指示の欄へテンプレートを入れた後の中身と選択。
 *
 * - 欄に触っていれば（`touched`）カーソルの位置へ入れ、文字を選んでいればそれを置き換える
 * - 触っていなければ末尾へ足す。前の文が改行で終わっていなければ改行を 1 つはさむ
 * - 入れた文に穴（`{{…}}`）があれば最初の穴を選び、無ければ入れた文の後ろにカーソルを置く
 */
export function paradisInsertPromptTemplate(value: string, selectionStart: number, selectionEnd: number, touched: boolean, template: string): IParadisPromptTemplateInsertion {
	let start = touched ? Math.max(0, Math.min(selectionStart, value.length)) : value.length;
	let end = touched ? Math.max(start, Math.min(selectionEnd, value.length)) : value.length;
	if (end < start) {
		[start, end] = [end, start];
	}
	// 触っていない欄の末尾へ足すときだけ、前の文と行を分ける（カーソルを置いた所へは、そのまま入れる）
	const text = !touched && value.length > 0 && !value.endsWith('\n') ? `\n${template}` : template;
	const next = value.slice(0, start) + text + value.slice(end);
	const hole = PARADIS_PROMPT_TEMPLATE_HOLE.exec(text);
	if (hole) {
		return { value: next, selectionStart: start + hole.index, selectionEnd: start + hole.index + hole[0].length };
	}
	return { value: next, selectionStart: start + text.length, selectionEnd: start + text.length };
}

/**
 * 今の指示から作るテンプレートの名前。1 行目（空白を畳む）を 24 字で切り、同じ名前があれば ` (2)` から番号を足す。
 * 指示が空なら undefined。
 */
export function paradisPromptTemplateName(prompt: string, existingNames: readonly string[]): string | undefined {
	const firstLine = prompt.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).find(line => line.length > 0);
	if (!firstLine) {
		return undefined;
	}
	const chars = Array.from(firstLine);
	const base = chars.length > PARADIS_PROMPT_TEMPLATE_NAME_MAX_CHARS ? `${chars.slice(0, PARADIS_PROMPT_TEMPLATE_NAME_MAX_CHARS).join('')}…` : firstLine;
	const taken = new Set(existingNames);
	if (!taken.has(base)) {
		return base;
	}
	for (let suffix = 2; ; suffix++) {
		const candidate = `${base} (${suffix})`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}
