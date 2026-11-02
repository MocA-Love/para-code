/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * HTTP の応答の本文を読みながら上限で打ち切る。超えた時点で読むのをやめ（読み切ってから測らない）、本文を取り消して
 * `tooLargeMessage` の Error を投げる。CDP の上流の JSON（shared process）と `/json/list`（main）が使う。
 */
export async function paradisReadBoundedBody(body: ReadableStream<Uint8Array>, maxBytes: number, tooLargeMessage: string): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error(tooLargeMessage);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return paradisConcatBytes(chunks, total);
}

/** 読んだ断片を 1 つのバイト列につなぐ。 */
function paradisConcatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}
