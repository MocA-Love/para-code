/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { streamToBuffer } from '../../../base/common/buffer.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { URI } from '../../../base/common/uri.js';
import type { IFileContent, IFileService, IReadFileStreamOptions } from './files.js';

/**
 * ファイルの先頭 `length` バイトだけを読む。
 *
 * `IFileService.readFile` に `length` を渡しても、`readFile` は常にバッファを使わない読み方を選ぶので、
 * 提供側からファイル全体を受け取ってから切り詰める（`fileService.ts` の `readFileUnbuffered`）。
 * 148 MB の PDF の先頭 5 バイトを確かめるだけで、全体を renderer へ運んでいた。
 * `readFileStream` はその読み方を選ばないので、`length` が提供側（手元のディスク・SSH の接続先）まで届き、
 * 先頭だけを読む。読み終えたら（失敗しても）流れを必ず閉じる。
 *
 * 戻り値は `readFile` と同じ形（stat の項目と、読めた分の `value`）。
 */
export async function readParadisFileHead(fileService: Pick<IFileService, 'readFileStream'>, resource: URI, options: IReadFileStreamOptions & { readonly length: number }, token?: CancellationToken): Promise<IFileContent> {
	const content = await fileService.readFileStream(resource, options, token);
	try {
		return { ...content, value: await streamToBuffer(content.value) };
	} finally {
		content.value.destroy();
	}
}
