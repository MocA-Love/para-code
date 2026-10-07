/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのカーソルの名前（`set_cursor_label`・`open_browser_tab` の `label`）を確かめて整える
// （純粋関数のみ。q.html Q273〜Q274 A、agent-cursor-after-mock.html の「名前の規則」）。
//
// 名前は LLM が決めるので、決め忘れる・長く書く・ページの文言（人の名前・メール・注文番号）を写す・
// 「あなた」「Para Code」と名乗る、を前提にする。Para Code は名前の左に必ず CLI の印を描くので、
// 名前だけで Para Code 自身や利用者に見せかけることはできない。

/** 名前の幅の上限（全角は 2、半角は 1 と数える）。 */
export const PARADIS_CURSOR_LABEL_MAX_WIDTH = 12;
/** 名前の幅の下限。 */
export const PARADIS_CURSOR_LABEL_MIN_WIDTH = 2;
/** 1 つの持ち主が名前を変えられる回数（{@link PARADIS_CURSOR_LABEL_RATE_WINDOW_MS} あたり）。 */
export const PARADIS_CURSOR_LABEL_RATE_LIMIT = 3;
export const PARADIS_CURSOR_LABEL_RATE_WINDOW_MS = 60_000;

/** 断る理由（道具の戻り値で英語のまま返す）。 */
export type ParadisCursorLabelRejection = 'empty' | 'too short' | 'contains a URL' | 'contains an e-mail address' | 'contains a long number' | 'reserved name';

export type ParadisCursorLabelResult =
	| { readonly ok: true; readonly label: string; readonly truncated: boolean }
	| { readonly ok: false; readonly rejected: ParadisCursorLabelRejection };

/** 名乗れない名前（小文字・空白なしで比べる）。 */
const RESERVED = new Set(['あなた', 'ユーザー', 'ユーザ', 'paracode', 'システム', '管理者', 'user', 'you', 'admin', 'system', 'administrator']);

/** 全角として数える文字か（East Asian Width の W・F の近似）。 */
function isWide(codePoint: number): boolean {
	return (codePoint >= 0x1100 && codePoint <= 0x115f)
		|| (codePoint >= 0x2e80 && codePoint <= 0x303e)
		|| (codePoint >= 0x3041 && codePoint <= 0x33ff)
		|| (codePoint >= 0x3400 && codePoint <= 0x4dbf)
		|| (codePoint >= 0x4e00 && codePoint <= 0x9fff)
		|| (codePoint >= 0xa000 && codePoint <= 0xa4cf)
		|| (codePoint >= 0xac00 && codePoint <= 0xd7a3)
		|| (codePoint >= 0xf900 && codePoint <= 0xfaff)
		|| (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
		|| (codePoint >= 0xff00 && codePoint <= 0xff60)
		|| (codePoint >= 0xffe0 && codePoint <= 0xffe6)
		|| (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

/** 名前の幅（全角は 2、半角は 1）。 */
export function paradisCursorLabelWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += isWide(char.codePointAt(0)!) ? 2 : 1;
	}
	return width;
}

/**
 * 名前を整えて確かめる。
 *
 * 1. NFKC で揃え（全角英数は半角、半角カナは全角）、改行・タブは空白に、続く空白は 1 つにして前後を削る
 * 2. 絵文字・制御文字・書式文字（文字の向きを変える記号・ゼロ幅の文字）・私用領域・異体字の選択子・
 *    2 つ以上続く結合文字を消す
 * 3. 空・幅 2 未満・URL・メールアドレス・6 桁以上の数字・予約語は断る
 * 4. 幅 12 を超えた分は切る
 */
export function paradisNormalizeCursorLabel(raw: string): ParadisCursorLabelResult {
	let text = raw.normalize('NFKC');
	text = text.replace(/[\t\n\r\v\f\u2028\u2029]/g, ' ');
	text = text.replace(/\p{Extended_Pictographic}|\p{Cc}|\p{Cf}|\p{Co}|[︀-️]|[\u{E0100}-\u{E01EF}]/gu, '');
	text = text.replace(/\p{M}{2,}/gu, '');
	text = text.replace(/\s+/g, ' ').trim();
	if (text.length === 0) {
		return { ok: false, rejected: 'empty' };
	}
	if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) {
		return { ok: false, rejected: 'contains an e-mail address' };
	}
	if (/\b(?:https?|ftp|file):\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|app|jp|co|ai)\b/i.test(text)) {
		return { ok: false, rejected: 'contains a URL' };
	}
	if (/\d{6,}/.test(text)) {
		return { ok: false, rejected: 'contains a long number' };
	}
	if (RESERVED.has(text.toLowerCase().replace(/\s+/g, ''))) {
		return { ok: false, rejected: 'reserved name' };
	}
	let truncated = false;
	if (paradisCursorLabelWidth(text) > PARADIS_CURSOR_LABEL_MAX_WIDTH) {
		let width = 0;
		let cut = '';
		for (const char of text) {
			const w = isWide(char.codePointAt(0)!) ? 2 : 1;
			if (width + w > PARADIS_CURSOR_LABEL_MAX_WIDTH) {
				break;
			}
			width += w;
			cut += char;
		}
		text = cut.trim();
		truncated = true;
	}
	if (paradisCursorLabelWidth(text) < PARADIS_CURSOR_LABEL_MIN_WIDTH) {
		return { ok: false, rejected: 'too short' };
	}
	return { ok: true, label: text, truncated };
}
