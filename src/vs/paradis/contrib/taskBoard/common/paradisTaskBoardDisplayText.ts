/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Keep this module free of imports: the task board server (app/taskboard) imports it directly.

/**
 * 確認のダイアログで、見えている文字と実際に走る文字がずれうる文字。改行以外の制御文字（タブ・`\r`・ESC で始まる
 * ANSI のエスケープを含む）、C1 の制御文字、改行に見える区切り（U+2028・U+2029）、向きを変える文字（U+061C・U+200E・
 * U+200F・U+202A〜U+202E・U+2066〜U+2069）、幅の無い・空白に見える文字（U+00A0・U+00AD・U+034F・U+115F・U+1160・
 * U+180E・U+200B〜U+200D・U+2060〜U+2064・U+3164・U+FEFF）、異体字セレクタ（U+FE00〜U+FE0F）、タグ文字
 * （U+E0000〜U+E007F。BMP の外なので `u` フラグで判定する）。日本語の濁点などの結合文字は正当に使うので含めない。
 */
const HIDDEN_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u00a0\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\u{e0000}-\u{e007f}]/u;

/** 工程のコマンドに、確認のダイアログで正しく見せられない文字が入っているか（窓・REH・ボードの 3 か所で断る）。 */
export function paradisTaskBoardHasHiddenCharacters(text: string): boolean {
	return HIDDEN_CHARACTERS.test(text) || hasInvisibleJoiner(text);
}

/**
 * U+034F（結合書記素結合子）と異体字セレクタ（U+FE00〜U+FE0F）。正規表現の文字クラスに入れると前の文字と結合して読めて
 * しまう（no-misleading-character-class）ので、文字の番号で調べる。
 */
function hasInvisibleJoiner(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x034f || (code >= 0xfe00 && code <= 0xfe0f)) {
			return true;
		}
	}
	return false;
}

/** ボードと窓が返す、断った理由。 */
export const PARADIS_TASK_BOARD_HIDDEN_CHARACTERS_MESSAGE = 'The command contains characters that cannot be displayed, so it is not run.';

/** 確認のダイアログに出す本文の要約と、行番号を付けた全文（空行を挟んで後ろに隠した行も、番号で見える）。 */
export interface IParadisTaskBoardCommandPreview {
	readonly lines: number;
	readonly characters: number;
	readonly hashPrefix: string;
	/** 長い本文（20 行・2000 文字を超える）。スクロールできるモーダルで見せる。 */
	readonly long: boolean;
	readonly numbered: string;
}

export function paradisTaskBoardCommandPreview(command: string, hash: string): IParadisTaskBoardCommandPreview {
	const lines = command.split('\n');
	const width = String(lines.length).length;
	return {
		lines: lines.length,
		characters: command.length,
		hashPrefix: hash.slice(0, 12),
		long: lines.length > 20 || command.length > 2000,
		numbered: lines.map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`).join('\n'),
	};
}
