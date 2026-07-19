/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_JSON_GZIP_RESPONSE_ENCODING = 'json-gzip-v1';

const HEADER_BYTES = 12;
const MIN_JSON_BYTES = 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MIN_SAVINGS_BYTES = 128;

/** Phase 9で圧縮対象にする、既知の大容量JSON成功応答だけを選ぶ。 */
export function paradisShouldCompressJsonResponse(channel: string, type: string): boolean {
	return (channel === 'scm' && (type === 'diff' || type === 'xlsxDiff'))
		|| (channel === 'fs' && (type === 'read' || type === 'xlsx'));
}

/** 従来のUTF-8 JSON bytesをgzip response v1へ可逆変換する。 */
export async function paradisEncodeGzipJsonResponse(json: Uint8Array): Promise<Uint8Array | undefined> {
	if (json.length < MIN_JSON_BYTES || json.length > MAX_JSON_BYTES) {
		return undefined;
	}
	try {
		const stream = new CompressionStream('gzip');
		const output = new Response(stream.readable).arrayBuffer();
		const writer = stream.writable.getWriter();
		await writer.write(json.slice());
		await writer.close();
		const compressed = new Uint8Array(await output);
		if (HEADER_BYTES + compressed.length > json.length - MIN_SAVINGS_BYTES) {
			return undefined;
		}
		const payload = new Uint8Array(HEADER_BYTES + compressed.length);
		payload.set([0x50, 0x43, 0x4a, 0x01, 1, 0, 0, 0], 0); // "PCJ" + wire version 1 + gzip + reserved
		new DataView(payload.buffer).setUint32(8, json.length, false);
		payload.set(compressed, HEADER_BYTES);
		return payload;
	} catch {
		return undefined;
	}
}

/** 旧MobileにはJSONを維持し、明示交渉した要求だけgzip v1を使う。 */
export function paradisEncodeNegotiatedGzipJsonResponse(encoding: unknown, json: Uint8Array): Promise<Uint8Array | undefined> {
	return encoding === PARADIS_JSON_GZIP_RESPONSE_ENCODING
		? paradisEncodeGzipJsonResponse(json)
		: Promise.resolve(undefined);
}

/** 対象4種かつ明示交渉時だけ圧縮し、それ以外・失敗時は同じJSON bytesを返す。 */
export async function paradisEncodeJsonResponsePayload(channel: string, type: string, encoding: unknown, json: Uint8Array): Promise<Uint8Array> {
	if (!paradisShouldCompressJsonResponse(channel, type)) {
		return json;
	}
	return await paradisEncodeNegotiatedGzipJsonResponse(encoding, json) ?? json;
}
