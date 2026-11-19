/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのライブウィンドウとブラウザのライブウィンドウで同じだった、覚えたウィンドウの位置の読み戻し。

import { IStorageService, StorageScope } from '../../platform/storage/common/storage.js';

export interface IParadisSerializedWindowBounds {
	readonly x?: number;
	readonly y?: number;
	readonly width?: number;
	readonly height?: number;
}

/** ワークスペースごとに覚えたウィンドウの位置を読む。無い・壊れている・数でない値が混じるときは undefined（既定の位置で開く）。 */
export function paradisRestoreLiveWindowBounds(storageService: IStorageService, storageKey: string): IParadisSerializedWindowBounds | undefined {
	const raw = storageService.get(storageKey, StorageScope.WORKSPACE);
	if (!raw) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object') {
			const bounds = parsed as IParadisSerializedWindowBounds;
			const isFinite = (value: number | undefined): boolean => value === undefined || Number.isFinite(value);
			if (isFinite(bounds.x) && isFinite(bounds.y) && isFinite(bounds.width) && isFinite(bounds.height)) {
				return bounds;
			}
		}
	} catch {
		// 壊れた値は捨てて既定の位置で開く。
	}
	return undefined;
}
