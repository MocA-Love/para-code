/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { constants, inflateRawSync } from 'zlib';

/** ID を探す先頭の長さ。応答は `{"id":...` から始まるので、ここまでに必ず収まる。 */
const PREFIX_BYTES = 1024;
/** 要求 ID の長さの上限（受ける側の検査と同じ）。 */
const MAX_REQUEST_ID_LENGTH = 200;
const GZIP_JSON_HEADER_BYTES = 12;
const BINARY_FS_HEADER_BYTES = 12;
const ID_PATTERN = /^\{"id":("(?:[^"\\]|\\.){1,400}")/;

function startsWith(payload: Uint8Array, magic: readonly number[]): boolean {
	return payload.length >= magic.length && magic.every((byte, index) => payload[index] === byte);
}

function idFromJsonPrefix(text: string): string | undefined {
	const match = ID_PATTERN.exec(text);
	if (match === null) {
		return undefined;
	}
	try {
		const id = JSON.parse(match[1]) as unknown;
		return typeof id === 'string' && id.length > 0 && id.length <= MAX_REQUEST_ID_LENGTH ? id : undefined;
	} catch {
		return undefined;
	}
}

/** gzip の本体（10 バイトの見出しの後の deflate）の先頭だけを展開する。足りなければ空。 */
function inflateGzipPrefix(gzip: Uint8Array): Uint8Array {
	// FLG の拡張（FEXTRA・FNAME など）は CompressionStream も zlib も付けない。付いていれば読まない
	if (gzip.length < 10 || gzip[0] !== 0x1f || gzip[1] !== 0x8b || gzip[3] !== 0) {
		return new Uint8Array();
	}
	try {
		// 圧縮後の先頭 4KiB だけ展開する（展開後は最大でも約 4MiB。ID は先頭の数十バイトにある）
		return inflateRawSync(gzip.subarray(10, 10 + 4 * 1024), { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: 8 * 1024 * 1024 });
	} catch {
		return new Uint8Array();
	}
}

/**
 * ファイル・ソース管理の応答のバイト列から、要求の ID を読む（送信前の列が上限で応答を送れなかったとき、小さな
 * 失敗の返事を返すため）。JSON（`{"id":...`）、gzip response v1（`PCJ\x01`）、binary fs response v1（`PFB\x01`）を
 * 読む。読めなければ undefined。
 */
export function paradisMobileResponseRequestId(payload: Uint8Array): string | undefined {
	const decoder = new TextDecoder();
	if (startsWith(payload, [0x50, 0x46, 0x42, 0x01])) {
		if (payload.length < BINARY_FS_HEADER_BYTES) {
			return undefined;
		}
		const idLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(6, false);
		if (idLength === 0 || idLength > MAX_REQUEST_ID_LENGTH * 4 || payload.length < BINARY_FS_HEADER_BYTES + idLength) {
			return undefined;
		}
		const id = decoder.decode(payload.subarray(BINARY_FS_HEADER_BYTES, BINARY_FS_HEADER_BYTES + idLength));
		return id.length <= MAX_REQUEST_ID_LENGTH ? id : undefined;
	}
	if (startsWith(payload, [0x50, 0x43, 0x4a, 0x01])) {
		return idFromJsonPrefix(decoder.decode(inflateGzipPrefix(payload.subarray(GZIP_JSON_HEADER_BYTES))));
	}
	return idFromJsonPrefix(decoder.decode(payload.subarray(0, PREFIX_BYTES)));
}
