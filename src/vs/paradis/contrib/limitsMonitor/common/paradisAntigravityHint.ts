/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Antigravity を自動で取りに行ってよいかの手がかり（{@link IParadisAntigravityFetchHint}）を、Para Code を起動し直しても
// 残すための台帳。手元と接続先（SSH など）ごとに分けて、レンダラーのストレージ（APPLICATION）に置く。
// macOS の agy はログインをキーチェーンに置き、token のファイルを作らないので、「前に値を取れた」ことを覚えておかないと、
// 起動のたびに自動では一度も取りに行けない。

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisAntigravityFetchHint, IParadisLimitsSnapshot } from './paradisLimitsMonitor.js';

const PARADIS_ANTIGRAVITY_HINTS_STORAGE_KEY = 'paradis.limitsMonitor.antigravityHints';

/** 台帳を読む。壊れた値は空として扱う（自動で取りに行かない側に倒れるだけ）。 */
export function paradisParseAntigravityHints(raw: string | undefined): Map<string, IParadisAntigravityFetchHint> {
	const hints = new Map<string, IParadisAntigravityFetchHint>();
	if (!raw) {
		return hints;
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
				if (!entry || typeof entry !== 'object') {
					continue;
				}
				const { seen, signedOutStamp } = entry as { seen?: unknown; signedOutStamp?: unknown };
				const hint: IParadisAntigravityFetchHint = {
					...(seen === true ? { seen: true } : {}),
					...(typeof signedOutStamp === 'string' ? { signedOutStamp } : {}),
				};
				if (hint.seen || hint.signedOutStamp !== undefined) {
					hints.set(key, hint);
				}
			}
		}
	} catch {
		// 壊れた値は無視する
	}
	return hints;
}

export function paradisReadAntigravityHints(storageService: IStorageService): Map<string, IParadisAntigravityFetchHint> {
	return paradisParseAntigravityHints(storageService.get(PARADIS_ANTIGRAVITY_HINTS_STORAGE_KEY, StorageScope.APPLICATION));
}

export function paradisStoreAntigravityHints(storageService: IStorageService, hints: ReadonlyMap<string, IParadisAntigravityFetchHint>): void {
	// マシンごとの状態なので、設定の同期には載せない
	storageService.store(PARADIS_ANTIGRAVITY_HINTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(hints)), StorageScope.APPLICATION, StorageTarget.MACHINE);
}

/**
 * スナップショットを受け取った後の手がかり。
 * - agy が「サインインしていない」と答えた: 「前に取れた」を外し、そのときの印を覚える（印が変わるまで自動では起こさせない）
 * - 値が取れた: 「前に取れた」を付け、サインインしていない印は外す
 * - それ以外（agy が無い・一時的な失敗・起こさなかった）: そのまま
 */
export function paradisAntigravityHintAfter(before: IParadisAntigravityFetchHint | undefined, snapshot: Pick<IParadisLimitsSnapshot, 'antigravity' | 'antigravitySignedOut'>): IParadisAntigravityFetchHint | undefined {
	if (snapshot.antigravitySignedOut) {
		return { signedOutStamp: snapshot.antigravitySignedOut.stamp };
	}
	if (snapshot.antigravity?.accounts.some(account => account.status === 'ok')) {
		return { seen: true };
	}
	return before;
}
