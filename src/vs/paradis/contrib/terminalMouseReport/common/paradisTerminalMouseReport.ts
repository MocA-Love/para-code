/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ILogService } from '../../../../platform/log/common/log.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** 座標が数値でない値 (`NaN` / `Infinity` / `-Infinity` / 空) */
const NON_FINITE = '(?:NaN|-?Infinity)?';

/**
 * 壊れたマウス報告だけに一致する正規表現。
 * SGR: x が数値でない (y は何でも)、または x が数値で y が数値でない。
 * X10: 2 つの座標のどちらかが NUL。
 */
const BROKEN_MOUSE_REPORT = new RegExp(
	`\\x1b\\[<\\d+;(?:${NON_FINITE};(?:${NON_FINITE}|\\d+)|\\d+;${NON_FINITE})[Mm]`
	+ '|\\x1b\\[M[\\s\\S](?:\\x00[\\s\\S]|[\\s\\S]\\x00)',
	'g'
);

/**
 * xterm.js が座標を数値にできないまま組み立てたマウス報告を、端末への入力から取り除く。
 *
 * マウス報告が有効な端末でボタンを押し、離す前に端末が DOM から外れると、xterm.js が
 * `document` に残した mouseup の受け口が座標を NaN で計算し、`\x1b[<0;NaN;NaNm` を PTY へ
 * 送る。Claude Code などは `\x1b[<0;N` までを 1 つのシーケンスとして読むため、残りの
 * `aN;NaNm` が文字として入力欄に入る。
 *
 * 取り除く対象は次の 2 つで、それ以外 (ふつうの文字・正しいマウス報告) はそのまま残す。
 * - SGR 形式 (`SGR` / `SGR_PIXELS`) `\x1b[<b;x;yM|m` のうち、x か y が `NaN` / `Infinity` /
 *   `-Infinity` / 空のもの
 * - X10 形式 (`DEFAULT`) `\x1b[M` + 3 文字 のうち、座標の文字が NUL のもの
 *   (`String.fromCharCode(NaN + 32)` は NUL になる。正しい座標は 1 始まり + 32 なので NUL にならない)
 *
 * ブラケットペースト (`\x1b[200~` から `\x1b[201~` まで) の中身は、たまたま同じ並びを
 * 含んでいてもユーザーが貼った文字列なので触らない。
 */
export function paradisDropNonFiniteMouseReports(data: string): { readonly data: string; readonly droppedReports: number } {
	if (data.indexOf('\x1b[<') === -1 && data.indexOf('\x1b[M') === -1) {
		return { data, droppedReports: 0 };
	}
	let result = '';
	let droppedReports = 0;
	let index = 0;
	while (index < data.length) {
		const pasteStart = data.indexOf(PASTE_START, index);
		const plainEnd = pasteStart === -1 ? data.length : pasteStart;
		result += data.slice(index, plainEnd).replace(BROKEN_MOUSE_REPORT, () => {
			droppedReports++;
			return '';
		});
		if (pasteStart === -1) {
			break;
		}
		const pasteEnd = data.indexOf(PASTE_END, pasteStart + PASTE_START.length);
		const pasteStop = pasteEnd === -1 ? data.length : pasteEnd + PASTE_END.length;
		result += data.slice(pasteStart, pasteStop);
		index = pasteStop;
	}
	return { data: result, droppedReports };
}

/**
 * {@link paradisDropNonFiniteMouseReports} を通し、捨てた件数を trace に残す。
 * 入力の中身はログに出さない (パスワードなどが混ざりうるため)。
 */
export function paradisSanitizeTerminalInput(data: string, logService: ILogService): string {
	const { data: sanitized, droppedReports } = paradisDropNonFiniteMouseReports(data);
	if (droppedReports > 0) {
		logService.trace(`[paradis] dropped ${droppedReports} mouse report(s) with non-finite coordinates from terminal input`);
	}
	return sanitized;
}
