/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナル出力の末尾で閉じていない制御シーケンス（ESC / CSI / OSC / DCS など）を取り出す（Orca W2-18 の縮小版）。
 *
 * モバイルへ画面の snapshot を送るとき、直前に PC の xterm が読んだチャンクが `\x1b[3` のように
 * シーケンスの途中で終わっていると、PC の xterm は解析の途中状態を持っているのに snapshot には
 * それが載らない。モバイルの xterm は snapshot を受けて reset した状態から次のチャンク `1mRED` を
 * 読むので、「1mRED」という文字がそのまま画面に出る。provider はここで求めた断片を覚えておき、
 * snapshot の後の最初のチャンクの前に付けて送る。
 *
 * 扱うのは 7 ビットの ESC で始まるものだけ（8 ビットの C1 制御文字は、今の端末ではほぼ使われないので対象外）。
 * 断片が {@link PARADIS_TERMINAL_ESCAPE_TAIL_MAX_CHARS} を超えたら諦めて空にする（画像を運ぶ長い DCS などで
 * メモリを食い続けないため。そのときは従来どおり、続きの文字が一度だけ画面に出うる）。
 */

/** 覚えておく断片の上限（文字数）。 */
export const PARADIS_TERMINAL_ESCAPE_TAIL_MAX_CHARS = 4096;

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;

/**
 * これまでの断片 `previousTail` に今回のチャンク `data` を続けたとき、末尾に残る閉じていない
 * シーケンスを返す（無ければ空文字）。
 *
 * 毎チャンク呼ばれるので、断片が無いときは `lastIndexOf` 1 回で済ませる。最後の ESC より後ろに
 * 別の ESC は無いので、そこから読み始めれば足りる（シーケンスの途中の ESC は、VT の解析でも
 * 前のシーケンスを打ち切って新しい ESC として扱われる）。
 */
export function paradisTerminalEscapeTail(previousTail: string, data: string): string {
	const text = previousTail.length === 0 ? data : previousTail + data;
	const start = text.lastIndexOf('\x1b');
	if (start === -1) {
		return '';
	}
	if (isComplete(text, start)) {
		return '';
	}
	const tail = start === 0 ? text : text.slice(start);
	return tail.length > PARADIS_TERMINAL_ESCAPE_TAIL_MAX_CHARS ? '' : tail;
}

/** `text[start]` の ESC から始まるシーケンスが、`text` の終わりまでに閉じているか（または打ち切られたか）。 */
function isComplete(text: string, start: number): boolean {
	let index = start + 1;
	if (index >= text.length) {
		return false;
	}
	const introducer = text.charCodeAt(index);
	switch (introducer) {
		case 0x5b: // [ = CSI
			return isCsiComplete(text, index + 1);
		case 0x5d: // ] = OSC（BEL か ST で閉じる。ST の ESC はこれより後ろに無いので BEL だけを探す）
			return findStringTerminator(text, index + 1, true);
		case 0x50: // P = DCS
		case 0x58: // X = SOS
		case 0x5e: // ^ = PM
		case 0x5f: // _ = APC（どれも ST でしか閉じない）
			return findStringTerminator(text, index + 1, false);
		default:
			break;
	}
	// ESC の後に中間文字（0x20-0x2f）が続き、最後に終端文字（0x30-0x7e）で閉じる（例 `ESC ( B`）。
	for (; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === CAN || code === SUB) {
			return true;
		}
		if (code >= 0x20 && code <= 0x2f) {
			continue;
		}
		if (code < 0x20) {
			// 途中の C0 制御文字はその場で実行され、シーケンスは続く。
			continue;
		}
		return true;
	}
	return false;
}

function isCsiComplete(text: string, from: number): boolean {
	for (let index = from; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === CAN || code === SUB) {
			return true;
		}
		if (code >= 0x40 && code <= 0x7e) {
			return true;
		}
		if (code < 0x40) {
			// 引数（0x30-0x3f）・中間文字（0x20-0x2f）・途中で実行される C0 制御文字。
			continue;
		}
		// DEL や 0x80 以上は、解析器が引数として受けないので、ここで途切れたものとして扱う。
		return true;
	}
	return false;
}

function findStringTerminator(text: string, from: number, belTerminates: boolean): boolean {
	for (let index = from; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === CAN || code === SUB || (belTerminates && code === BEL) || code === ESC) {
			return true;
		}
	}
	return false;
}
