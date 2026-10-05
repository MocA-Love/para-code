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
/**
 * 圧縮後（ヘッダー込み）が元のこの割合を超えるなら圧縮せずに送る。モバイルは gzip の展開を
 * JS（fflate）で行い、21 MB で約 1.6 秒かかる（2026-10-02 の Sentry 実測）。縮み方が 2 割に
 * 満たないと、減る転送と復号の手間より展開の手間の方が大きくなりやすい。
 */
const MAX_COMPRESSED_RATIO = 0.8;


/** Phase 9で圧縮対象にする、既知の大容量JSON成功応答だけを選ぶ。 */
export function paradisShouldCompressJsonResponse(channel: string, type: string): boolean {
	return (channel === 'scm' && (type === 'diff' || type === 'xlsxDiff'))
		|| (channel === 'fs' && (type === 'read' || type === 'xlsx'));
}

/** 圧縮して縮んだ量が、展開の手間に見合うか（元の大きさと、ヘッダー込みの圧縮後の大きさ）。 */
export function paradisIsGzipWorthwhile(rawBytes: number, compressedBytes: number): boolean {
	return compressedBytes <= rawBytes - MIN_SAVINGS_BYTES && compressedBytes <= rawBytes * MAX_COMPRESSED_RATIO;
}

/** 従来のUTF-8 JSON bytesをgzip response v1へ可逆変換する。縮み方が足りなければ undefined。 */
export async function paradisEncodeGzipJsonResponse(json: Uint8Array): Promise<Uint8Array | undefined> {
	if (!paradisIsGzipJsonCandidate(json.length)) {
		return undefined;
	}
	try {
		const stream = new CompressionStream('gzip');
		const output = new Response(stream.readable).arrayBuffer();
		const writer = stream.writable.getWriter();
		await writer.write(json.slice());
		await writer.close();
		return paradisFrameGzipJsonResponse(json.length, new Uint8Array(await output));
	} catch {
		return undefined;
	}
}

/** 元の JSON の大きさが gzip v1 の対象の範囲か（小さすぎると展開の手間の方が高く、大きすぎるとモバイルが受けない）。 */
export function paradisIsGzipJsonCandidate(rawBytes: number): boolean {
	return rawBytes >= MIN_JSON_BYTES && rawBytes <= MAX_JSON_BYTES;
}

/**
 * gzip で縮めたバイト列に gzip response v1 の見出しを付ける。縮み方が足りなければ undefined。
 * 圧縮そのものは呼び出し側が持つ（shared process は zlib の同期版で、送る順を崩さずに縮める）。
 */
export function paradisFrameGzipJsonResponse(rawBytes: number, compressed: Uint8Array): Uint8Array | undefined {
	if (!paradisIsGzipJsonCandidate(rawBytes) || !paradisIsGzipWorthwhile(rawBytes, HEADER_BYTES + compressed.length)) {
		return undefined;
	}
	const payload = new Uint8Array(HEADER_BYTES + compressed.length);
	payload.set([0x50, 0x43, 0x4a, 0x01, 1, 0, 0, 0], 0); // "PCJ" + wire version 1 + gzip + reserved
	new DataView(payload.buffer).setUint32(8, rawBytes, false);
	payload.set(compressed, HEADER_BYTES);
	return payload;
}

/** 旧MobileにはJSONを維持し、明示交渉した要求だけgzip v1を使う。 */
export function paradisEncodeNegotiatedGzipJsonResponse(encoding: unknown, json: Uint8Array): Promise<Uint8Array | undefined> {
	return encoding === PARADIS_JSON_GZIP_RESPONSE_ENCODING
		? paradisEncodeGzipJsonResponse(json)
		: Promise.resolve(undefined);
}

/**
 * 対象4種かつ明示交渉時だけ圧縮し、それ以外・失敗時は同じJSON bytesを返す。
 * モバイルは magic の無い応答を従来の JSON として読むので、圧縮しない応答に印は要らない。
 * 拡張子では判定しない。`read` に届くバイナリ（zip 等をテキストとして開いたもの）の JSON は
 * U+FFFD と `\u00XX` だらけでよく縮み、省くと転送量が増えて上限を超えることがあるため。
 */
export async function paradisEncodeJsonResponsePayload(channel: string, type: string, encoding: unknown, json: Uint8Array): Promise<Uint8Array> {
	if (!paradisShouldCompressJsonResponse(channel, type)) {
		return json;
	}
	return await paradisEncodeNegotiatedGzipJsonResponse(encoding, json) ?? json;
}
