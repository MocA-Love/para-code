/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const PARADIS_COLLAPSED_REPOSITORIES_STORAGE_KEY = 'paradis.workspaceSwitch.collapsedRepositories.v1';
export const PARADIS_PINNED_WORKTREES_STORAGE_KEY = 'paradis.workspaceSwitch.pinnedWorktrees.v1';

const MAX_COLLAPSED_REPOSITORIES = 1024;
const MAX_REPOSITORY_ID_LENGTH = 512;
const MAX_COLLAPSED_REPOSITORIES_STORAGE_LENGTH = MAX_COLLAPSED_REPOSITORIES * (MAX_REPOSITORY_ID_LENGTH + 3) + 2;

/**
 * ピン留めは worktree の状態キー (`worktree:<uri>` = 絶対パスを含む) を持つため、
 * リポジトリID より長い1件あたりの上限を取る。
 */
const MAX_PINNED_WORKTREES = 512;
const MAX_PINNED_WORKTREE_KEY_LENGTH = 2048;
const MAX_PINNED_WORKTREES_STORAGE_LENGTH = MAX_PINNED_WORKTREES * (MAX_PINNED_WORKTREE_KEY_LENGTH + 3) + 2;

/** 永続化された文字列集合を防御的に読む。一部でも不正なら全体を捨てる。 */
function parseIdSet(raw: string | undefined, maxCount: number, maxIdLength: number, maxStorageLength: number): Set<string> {
	if (raw === undefined) {
		return new Set();
	}
	if (raw.length > maxStorageLength) {
		return new Set();
	}
	try {
		const value = JSON.parse(raw) as unknown;
		if (!Array.isArray(value) || value.length > maxCount) {
			return new Set();
		}
		const result = new Set<string>();
		for (const id of value) {
			if (typeof id !== 'string' || id.length === 0 || id.length > maxIdLength) {
				return new Set();
			}
			result.add(id);
		}
		return result;
	} catch {
		return new Set();
	}
}

/** reader と同じ上限を満たす snapshot だけを返す。 */
function serializeIdSet(ids: ReadonlySet<string>, maxCount: number, maxIdLength: number, maxStorageLength: number): string | undefined {
	if (ids.size > maxCount) {
		return undefined;
	}
	const sorted = [...ids].sort();
	if (sorted.some(id => id.length === 0 || id.length > maxIdLength)) {
		return undefined;
	}
	const serialized = JSON.stringify(sorted);
	return serialized.length <= maxStorageLength ? serialized : undefined;
}

/** Parse persisted view state defensively. A partially valid value is not accepted. */
export function paradisParseCollapsedRepositoryIds(raw: string | undefined): Set<string> {
	return parseIdSet(raw, MAX_COLLAPSED_REPOSITORIES, MAX_REPOSITORY_ID_LENGTH, MAX_COLLAPSED_REPOSITORIES_STORAGE_LENGTH);
}

/** ピン留めされた worktree の状態キー集合を読む (collapsed 状態と同じ防御的な読み方)。 */
export function paradisParsePinnedWorktreeKeys(raw: string | undefined): Set<string> {
	return parseIdSet(raw, MAX_PINNED_WORKTREES, MAX_PINNED_WORKTREE_KEY_LENGTH, MAX_PINNED_WORKTREES_STORAGE_LENGTH);
}

/** ピン留めの snapshot。上限を超える場合は undefined を返し、呼び出し側が既存storageを保持する。 */
export function paradisSerializePinnedWorktreeKeys(keys: ReadonlySet<string>): string | undefined {
	return serializeIdSet(keys, MAX_PINNED_WORKTREES, MAX_PINNED_WORKTREE_KEY_LENGTH, MAX_PINNED_WORKTREES_STORAGE_LENGTH);
}

export function paradisLoadCollapsedRepositoryIds(read: () => string | undefined, onReadError: () => void): Set<string> {
	try {
		return paradisParseCollapsedRepositoryIds(read());
	} catch {
		try {
			onReadError();
		} catch {
			// Diagnostics must not make the view unavailable when storage is unavailable.
		}
		return new Set();
	}
}

/** readerと同じ上限を満たすsnapshotだけを返す。拒否時は呼び出し側が既存storageを保持する。 */
export function paradisSerializeCollapsedRepositoryIds(ids: ReadonlySet<string>): string | undefined {
	return serializeIdSet(ids, MAX_COLLAPSED_REPOSITORIES, MAX_REPOSITORY_ID_LENGTH, MAX_COLLAPSED_REPOSITORIES_STORAGE_LENGTH);
}

export function paradisSetRepositoryCollapsed(ids: Set<string>, repositoryId: string, collapsed: boolean): boolean {
	if (collapsed) {
		if (ids.has(repositoryId)) {
			return false;
		}
		ids.add(repositoryId);
		return true;
	}
	return ids.delete(repositoryId);
}

/** 生きていないIDを取り除く。ストレージが到達不能なキーで肥大化するのを防ぐ。 */
export function paradisRemoveStaleIds(ids: Set<string>, liveIds: ReadonlySet<string>): boolean {
	let changed = false;
	for (const id of ids) {
		if (!liveIds.has(id)) {
			ids.delete(id);
			changed = true;
		}
	}
	return changed;
}

// --- 並び替え (「上へ移動/下へ移動」・ドラッグ&ドロップ) の純粋ロジック ----------------------------

/**
 * 配列内 index の要素を direction 方向の隣接要素と入れ替えた新しい配列を返す。
 * index が範囲外、または入れ替え先が範囲外 (先頭を上へ / 末尾を下へ) の場合は null を返し、
 * 呼び出し側が書き込みをスキップできるようにする。
 */
export function paradisSwapAdjacent<T>(items: readonly T[], index: number, direction: -1 | 1): T[] | null {
	const targetIndex = index + direction;
	if (index < 0 || targetIndex < 0 || targetIndex >= items.length) {
		return null;
	}
	const result = items.slice();
	[result[index], result[targetIndex]] = [result[targetIndex], result[index]];
	return result;
}

/**
 * ids 配列の draggedId を targetId の直前 (placeAfter=false) / 直後 (placeAfter=true) へ
 * 移動した新しい配列を返す。draggedId/targetId が未知、同一、または移動しても順序が変わらない
 * 場合は null を返す (書き込み不要)。sourcePosition < targetPosition の補正は
 * upstream の watchExpressionsView の drop と同じ。
 */
export function paradisReorderByDrop(ids: readonly string[], draggedId: string, targetId: string, placeAfter: boolean): string[] | null {
	if (draggedId === targetId) {
		return null;
	}
	const sourcePosition = ids.indexOf(draggedId);
	const targetIndex = ids.indexOf(targetId);
	if (sourcePosition < 0 || targetIndex < 0) {
		return null;
	}
	let targetPosition = placeAfter ? targetIndex + 1 : targetIndex;
	if (sourcePosition < targetPosition) {
		targetPosition--;
	}
	if (targetPosition === sourcePosition) {
		return null;
	}
	const result = ids.slice();
	result.splice(sourcePosition, 1);
	result.splice(targetPosition, 0, draggedId);
	return result;
}

/**
 * desiredOrder が指定する順に items を並べ替えた新しい配列を返す。desiredOrder に無いIDは
 * 元の相対順を保ったまま末尾に残し、desiredOrder 内の未知IDは無視する。順序が変わらない場合は
 * null を返す (書き込み不要)。
 */
export function paradisApplyDesiredOrder<T>(items: readonly T[], idOf: (item: T) => string, desiredOrder: readonly string[]): T[] | null {
	const rank = new Map(desiredOrder.map((id, index) => [id, index]));
	const decorated = items.map((item, index) => ({ item, index, rank: rank.get(idOf(item)) ?? Number.MAX_SAFE_INTEGER }));
	decorated.sort((a, b) => a.rank !== b.rank ? a.rank - b.rank : a.index - b.index);
	if (decorated.every((entry, index) => entry.index === index)) {
		return null;
	}
	return decorated.map(entry => entry.item);
}
