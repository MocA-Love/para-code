/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { PASTED_IMAGE_DIR, paradisWritePastedImageFile } from '../../terminalImagePaste/browser/paradisTerminalImagePaste.js';
import { IParadisWorktreeImage, paradisWorktreeImageFileName } from '../common/paradisWorktreeImageAttach.js';

/** 添えた画像を書いた結果。 */
export type ParadisWorktreeImageWriteResult =
	/** 書けた。`paths` は作業フォルダからの相対パス（起動コマンドへそのまま入れる）。 */
	| { readonly kind: 'written'; readonly paths: readonly string[] }
	/** 1 枚でも書けなかった。エージェントは画像なしで起動する。 */
	| { readonly kind: 'failed' };

/**
 * 「新しいスペース」の指示に添えた画像を、作ったスペースの `.para-code/pasted-images/` へ書く。
 * スペースの URI が SSH 先（vscode-remote:）なら SSH 先へ写る。名前は `<時刻>-<順番>.<拡張子>`。
 * 一部だけ渡すと指示と食い違うので、1 枚でも書けなければ全部を渡さない（書けた分はそのまま残る）。
 */
export async function paradisWriteWorktreeImages(fileService: IFileService, worktreeUri: URI, images: readonly IParadisWorktreeImage[], now: number = Date.now()): Promise<ParadisWorktreeImageWriteResult> {
	const directory = URI.joinPath(worktreeUri, PASTED_IMAGE_DIR);
	const paths: string[] = [];
	for (let index = 0; index < images.length; index++) {
		const image = images[index];
		const fileName = paradisWorktreeImageFileName(now, index, image.mime);
		const written = await paradisWritePastedImageFile(fileService, directory, fileName, image.data);
		if (!written) {
			return { kind: 'failed' };
		}
		paths.push(`${PASTED_IMAGE_DIR}/${fileName}`);
	}
	return { kind: 'written', paths };
}
