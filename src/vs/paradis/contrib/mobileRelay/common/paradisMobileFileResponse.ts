/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_FS_BINARY_RESPONSE_ENCODING = 'fs-binary-v1';

export type ParadisBinaryFsResponseType = 'pdf' | 'docx' | 'media';

const HEADER_BYTES = 12;
const encoder = new TextEncoder();

/**
 * ファイル成功応答をbinary fs response v1へ可逆変換する。
 * wire metadataに安全に収まらない場合は、呼び出し側が従来JSONへ戻せるようundefinedを返す。
 */
export function paradisEncodeBinaryFsResponse(type: ParadisBinaryFsResponseType, id: string, size: number, data: Uint8Array): Uint8Array | undefined {
	const kind = type === 'pdf' ? 1 : type === 'docx' ? 2 : 3;
	if (typeof id !== 'string' || !Number.isInteger(size) || size < 0 || size > 0xffffffff) {
		return undefined;
	}
	const idBytes = encoder.encode(id);
	if (idBytes.length === 0 || idBytes.length > 0xffff) {
		return undefined;
	}
	const payload = new Uint8Array(HEADER_BYTES + idBytes.length + data.length);
	payload.set([0x50, 0x46, 0x42, 0x01, kind, 0], 0); // "PFB" + wire version 1 + kind + reserved
	const view = new DataView(payload.buffer);
	view.setUint16(6, idBytes.length, false);
	view.setUint32(8, size, false);
	payload.set(idBytes, HEADER_BYTES);
	payload.set(data, HEADER_BYTES + idBytes.length);
	return payload;
}

/** 旧MobileにはJSONを維持し、明示交渉したMobileだけbinary v1を使う。 */
export function paradisEncodeNegotiatedBinaryFsResponse(responseEncoding: unknown, type: ParadisBinaryFsResponseType, id: string, size: number, data: Uint8Array): Uint8Array | undefined {
	return responseEncoding === PARADIS_FS_BINARY_RESPONSE_ENCODING
		? paradisEncodeBinaryFsResponse(type, id, size, data)
		: undefined;
}
