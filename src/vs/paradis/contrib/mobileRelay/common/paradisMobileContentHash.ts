/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** MobileがFS表示結果のSHA-256条件付き応答を明示交渉するencoding名。 */
export const PARADIS_CONTENT_HASH_ENCODING = 'content-hash-v1';

/** exact negotiationに応じて選択される全量またはnot-modified応答。 */
export type ParadisContentHashResponse<T extends { readonly t: string }> =
	| T
	| (T & { readonly contentHash: string })
	| { readonly t: T['t']; readonly notModified: true; readonly contentHash: string };

const encoder = new TextEncoder();
const SHA256_HEX = /^[a-f0-9]{64}$/;

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource));
	let result = '';
	for (const byte of digest) {
		result += byte.toString(16).padStart(2, '0');
	}
	return result;
}

/**
 * exact negotiationの場合だけ応答body全体をSHA-256化する。
 * 旧Mobileには参照同一の従来bodyを返し、追加CPUコストもかけない。
 */
export async function paradisContentHashResponse<T extends { readonly t: string }>(
	cacheEncoding: unknown,
	ifContentHash: unknown,
	body: T,
): Promise<ParadisContentHashResponse<T>> {
	if (cacheEncoding !== PARADIS_CONTENT_HASH_ENCODING) {
		return body;
	}
	const contentHash = await sha256Hex(encoder.encode(JSON.stringify(body)));
	if (typeof ifContentHash === 'string' && SHA256_HEX.test(ifContentHash) && ifContentHash === contentHash) {
		return { t: body.t, notModified: true, contentHash };
	}
	return { ...body, contentHash };
}
