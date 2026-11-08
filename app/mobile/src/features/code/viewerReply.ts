// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { FsReadResult, FsXlsxResult } from '../../store.js';

/**
 * ビューアが PC の応答を使う前に形を確かめる（`useFileContent.ts`）。応答が無い・形が違うときに、
 * 「Cannot read property 'htmlImages' of undefined」のような JS の中の言葉で落とさず、ふつうの文で「開けませんでした」を出す。
 * 古い PC・壊れた応答・開発の見本の差し替え漏れで起きうる。
 */

/** 形の違う応答を受けたときに「ファイルを開けませんでした」の下に出す文。 */
export const VIEWER_BAD_REPLY_MESSAGE = 'PC から届いた中身を読めませんでした。もう一度開いてください';

function badReply(): Error {
	return new Error(VIEWER_BAD_REPLY_MESSAGE);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `fsRead` の応答。本文が文字でなければ断る。HTML の画像の取り寄せ口は形が合うときだけ残す。 */
export function textReplyOf(value: unknown): FsReadResult {
	if (!isRecord(value) || typeof value.content !== 'string') {
		throw badReply();
	}
	const reply = value as unknown as FsReadResult;
	const images: unknown = value.htmlImages;
	if (images === undefined || (isRecord(images) && typeof images.token === 'string' && typeof images.count === 'number' && Number.isFinite(images.count))) {
		return reply;
	}
	const { htmlImages: _dropped, ...rest } = reply;
	return rest;
}

/** `fsPdf` / `fsDocx` / `fsMedia` の応答の本体（base64）。 */
export function binaryReplyOf(value: unknown): string {
	if (!isRecord(value) || typeof value.data !== 'string') {
		throw badReply();
	}
	return value.data;
}

/** `fsXlsx` の応答。 */
export function xlsxReplyOf(value: unknown): FsXlsxResult {
	if (!isRecord(value) || typeof value.html !== 'string') {
		throw badReply();
	}
	return value as unknown as FsXlsxResult;
}
