/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const PARADIS_COLLAPSED_REPOSITORIES_STORAGE_KEY = 'paradis.workspaceSwitch.collapsedRepositories.v1';

const MAX_COLLAPSED_REPOSITORIES = 1024;
const MAX_REPOSITORY_ID_LENGTH = 512;
const MAX_COLLAPSED_REPOSITORIES_STORAGE_LENGTH = MAX_COLLAPSED_REPOSITORIES * (MAX_REPOSITORY_ID_LENGTH + 3) + 2;

/** Parse persisted view state defensively. A partially valid value is not accepted. */
export function paradisParseCollapsedRepositoryIds(raw: string | undefined): Set<string> {
	if (raw === undefined) {
		return new Set();
	}
	if (raw.length > MAX_COLLAPSED_REPOSITORIES_STORAGE_LENGTH) {
		return new Set();
	}
	try {
		const value = JSON.parse(raw) as unknown;
		if (!Array.isArray(value) || value.length > MAX_COLLAPSED_REPOSITORIES) {
			return new Set();
		}
		const result = new Set<string>();
		for (const id of value) {
			if (typeof id !== 'string' || id.length === 0 || id.length > MAX_REPOSITORY_ID_LENGTH) {
				return new Set();
			}
			result.add(id);
		}
		return result;
	} catch {
		return new Set();
	}
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
	if (ids.size > MAX_COLLAPSED_REPOSITORIES) {
		return undefined;
	}
	const sorted = [...ids].sort();
	if (sorted.some(id => id.length === 0 || id.length > MAX_REPOSITORY_ID_LENGTH)) {
		return undefined;
	}
	const serialized = JSON.stringify(sorted);
	return serialized.length <= MAX_COLLAPSED_REPOSITORIES_STORAGE_LENGTH ? serialized : undefined;
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

export function paradisRemoveStaleCollapsedRepositoryIds(ids: Set<string>, liveRepositoryIds: ReadonlySet<string>): boolean {
	let changed = false;
	for (const id of ids) {
		if (!liveRepositoryIds.has(id)) {
			ids.delete(id);
			changed = true;
		}
	}
	return changed;
}
