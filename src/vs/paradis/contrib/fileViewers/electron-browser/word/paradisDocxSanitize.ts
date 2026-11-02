/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word の単体と差分のビューアが共通で使う、同梱の docx-preview の置き場と、renderer に渡す前の消毒。

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { setTimeout0 } from '../../../../../base/common/platform.js';
import { createParadisOfficeWebArchive } from '../../browser/office/paradisOfficeWebArchive.js';
import { sanitizeOfficeDocxPackageForRenderer, type ParadisOfficeRenderablePackage } from '../../common/paradisOfficeSanitizer.js';

/** vendored docx-preview / jszip 成果物の配置ディレクトリ（AppResourcePath）。 */
export const PARADIS_DOCX_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview' as const;

/** Owns and sanitizes every package asset before docx-preview can observe the package. */
export async function sanitizeParadisDocxBytesForRenderer(bytes: Uint8Array, nodeId: string, token?: CancellationToken, imagePixelBudget?: number): Promise<ParadisOfficeRenderablePackage> {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16 * 1024 * 1024) { throw new Error('Office package exceeds renderer preprocessing limits'); }
	const owned = new Uint8Array(bytes.byteLength);
	owned.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	const archive = await createParadisOfficeWebArchive(owned);
	return sanitizeOfficeDocxPackageForRenderer({ nodeId, source: owned, archive, token, deadline: Date.now() + 10_000, scheduler: createParadisDocxSlicedScheduler(), ...(imagePixelBudget !== undefined ? { imagePixelBudget } : {}) });
}

/** 前処理が続けて走ってよい時間。これを超えたら 1 回だけ譲る（画面の操作が止まって見えない長さ）。 */
const DOCX_PREPROCESS_SLICE_MS = 12;

/**
 * 前処理（ZIP の読み直しと消毒）が描画の合間に譲るための scheduler。
 *
 * 以前は部品 1 つごとに `setTimeout(0)` で譲っていたが、ブラウザは入れ子の `setTimeout` を 4ms 以上に
 * 引き延ばすので、部品の数 × 4ms が丸ごと待ち時間になっていた（実測で、小さな文書でも 0.5 秒前後）。
 * 一定時間ぶん続けて処理してから、引き延ばされない `setTimeout0`（postMessage）で譲る。出力は変わらない。
 */
export function createParadisDocxSlicedScheduler(sliceMilliseconds = DOCX_PREPROCESS_SLICE_MS, now: () => number = () => performance.now()): () => Promise<void> {
	let sliceStart = now();
	return () => {
		if (now() - sliceStart < sliceMilliseconds) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => setTimeout0(() => {
			sliceStart = now();
			resolve();
		}));
	};
}
