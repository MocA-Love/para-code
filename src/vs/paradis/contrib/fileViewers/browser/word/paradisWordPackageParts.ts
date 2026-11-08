/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// .docx から「描画対象の抽出に必要な XML パートだけ」を、ブラウザ層の zip 展開(DecompressionStream)で取り出す。
// shared process の Word の worker を使えないときの renderer での抽出に使う（読み方は common の
// readParadisWordRenderableParts が持つ）。

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { readParadisWordRenderableParts } from '../../common/word/paradisWordRenderableParts.js';
import { createParadisOfficeWebArchive } from '../office/paradisOfficeWebArchive.js';

export { canonicalWordPartUri } from '../../common/word/paradisWordRenderableParts.js';

/**
 * .docx のバイト列から、描画対象の抽出に使う XML パートを読み出す。
 * 壊れた/大きすぎるパートは黙って落とし、読めた分だけを返す。
 */
export async function readWordRenderablePackageParts(bytes: Uint8Array, token?: CancellationToken): Promise<ReadonlyMap<string, string>> {
	return readParadisWordRenderableParts(await createParadisOfficeWebArchive(bytes), token);
}
