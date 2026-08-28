/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// .docx から「描画対象の抽出に必要な XML パートだけ」を取り出す。
// zip 展開はブラウザ層の実装(DecompressionStream)で行うため、workbench 側だけで完結し
// shared process との往復が要らない。バイナリ(media/embeddings)は読まない。

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { createParadisOfficeWebArchive } from '../office/paradisOfficeWebArchive.js';

/** 1 パートあたりの上限。これを超えるパートは読まずに捨てる。 */
const MAX_PART_BYTES = 8 * 1024 * 1024;
/** 読み込むパート数の上限。 */
const MAX_PARTS = 512;
/** 全パート合計の上限。 */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** 抽出に要るのは document/header/footer と chart/diagram、そしてそれらの rels だけ。 */
function isWantedPart(name: string): boolean {
	if (name.endsWith('.rels')) {
		return true;
	}
	if (!name.endsWith('.xml')) {
		return false;
	}
	return /^word\/(document\d*\.xml|header\d*\.xml|footer\d*\.xml|charts\/.+\.xml|diagrams\/.+\.xml)$/.test(name);
}

/** パッケージ内の名前を、リレーションシップ解決で使う絶対パート URI へ揃える。 */
export function canonicalWordPartUri(name: string): string {
	return name.startsWith('/') ? name : `/${name}`;
}

/**
 * .docx のバイト列から、描画対象の抽出に使う XML パートを読み出す。
 * 壊れた/大きすぎるパートは黙って落とし、読めた分だけを返す。
 */
export async function readWordRenderablePackageParts(bytes: Uint8Array, token?: CancellationToken): Promise<ReadonlyMap<string, string>> {
	const archive = await createParadisOfficeWebArchive(bytes);
	const parts = new Map<string, string>();
	const decoder = new TextDecoder('utf-8', { fatal: false });
	let totalBytes = 0;
	try {
		for await (const entry of archive.entries(token)) {
			if (parts.size >= MAX_PARTS || totalBytes >= MAX_TOTAL_BYTES) {
				break;
			}
			const name = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
			if (!isWantedPart(name)) {
				continue;
			}
			const chunks: Uint8Array[] = [];
			let size = 0;
			let oversized = false;
			for await (const chunk of archive.read(entry, token)) {
				size += chunk.byteLength;
				if (size > MAX_PART_BYTES) {
					oversized = true;
					break;
				}
				chunks.push(chunk);
			}
			if (oversized) {
				continue;
			}
			const joined = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				joined.set(chunk, offset);
				offset += chunk.byteLength;
			}
			totalBytes += size;
			parts.set(canonicalWordPartUri(name), decoder.decode(joined));
		}
	} catch (error) {
		// パッケージが壊れている場合は「描ける対象なし」として扱う(本文表示は docx-preview が担う)。
		if (!(error instanceof ParadisOfficePackageError)) {
			throw error;
		}
		return new Map();
	} finally {
		archive.dispose();
	}
	return parts;
}
