/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Kept free of any `vscode` import (unlike paradisRepositoryPark.ts) so selectUnaccountedForParking
// can be unit tested outside the extension host.

/** {@link selectUnaccountedForParking} が判定に必要とする最小限の形。 */
export interface IParadisUnaccountedCandidate {
	readonly repository: {
		readonly root: string;
		readonly rootRealPath?: string;
	};
}

/** workspace 変更の最後に一度だけ parking を決めるための、VS Code 非依存 snapshot。 */
export interface IParadisParkingSnapshot<T extends IParadisUnaccountedCandidate> {
	readonly currentFolderPaths: readonly string[];
	readonly removedRepositories: readonly (T | undefined)[];
	readonly openRepositories: readonly T[];
	readonly activeRepositories: ReadonlySet<T['repository']>;
}

/** realpath 待機後の handler が commit まで完了したかを表す。 */
export type ParadisParkingCoordinatorResult<T> =
	| { readonly kind: 'stale' }
	| { readonly kind: 'committed'; readonly skippedParking: boolean; readonly commitResult: T };

/**
 * 現在のワークスペースフォルダのどれにも属さない（＝自動検出で開かれたまま取り残された）
 * 候補だけを選り分ける。`Model.onDidChangeWorkspaceFolders` から抽出した純粋な判定ロジック。
 *
 * `unparkForFolder`（`paradisRepositoryPark.ts`）と同じ双方向の包含チェック（フォルダがリポジトリの
 * 中にある／リポジトリがフォルダの中にある、のどちらでも一致とみなす）を使う。`rootRealPath` が
 * あればそれも候補に含め、シンボリックリンク越しの一致も見逃さない。
 */
export function selectUnaccountedForParking<T extends IParadisUnaccountedCandidate>(
	candidates: readonly T[],
	currentFolderPaths: readonly string[],
	isDescendant: (parent: string, descendant: string) => boolean,
	pathEquals: (a: string, b: string) => boolean = (a, b) => a === b,
): T[] {
	return candidates.filter(candidate => {
		const roots = candidate.repository.rootRealPath !== undefined
			? [candidate.repository.root, candidate.repository.rootRealPath]
			: [candidate.repository.root];
		return !currentFolderPaths.some(folder => roots.some(root => pathEquals(folder, root) || isDescendant(folder, root) || isDescendant(root, folder)));
	});
}

/**
 * removed-folder と全 open repository から候補を一度だけ収集し、現在のフォルダに属する
 * repository と表示中 editor の repository を除外する。repository object の同一性で重複を
 * 除き、最初に見つかった順序を維持する。
 */
export function selectRepositoriesForUnifiedParking<T extends IParadisUnaccountedCandidate>(
	removed: readonly (T | undefined)[],
	open: readonly T[],
	activeRepositories: ReadonlySet<T['repository']>,
	currentFolderPaths: readonly string[],
	isDescendant: (parent: string, descendant: string) => boolean,
	pathEquals: (a: string, b: string) => boolean = (a, b) => a === b,
): T[] {
	const seen = new Set<T['repository']>();
	const candidates: T[] = [];

	for (const candidate of [...removed, ...open]) {
		if (!candidate || activeRepositories.has(candidate.repository) || seen.has(candidate.repository)) {
			continue;
		}

		seen.add(candidate.repository);
		candidates.push(candidate);
	}

	return selectUnaccountedForParking(candidates, currentFolderPaths, isDescendant, pathEquals);
}

function currentFoldersMatch(
	initialPaths: readonly string[],
	latestPaths: readonly string[],
	pathEquals: (a: string, b: string) => boolean,
): boolean {
	if (initialPaths.length !== latestPaths.length) {
		return false;
	}

	const matched = new Set<number>();
	return initialPaths.every(initialPath => {
		const index = latestPaths.findIndex((latestPath, index) => !matched.has(index) && pathEquals(initialPath, latestPath));
		if (index === -1) {
			return false;
		}

		matched.add(index);
		return true;
	});
}

/**
 * current folder の logical path から realpath を安全に解決し、その待機中に workspace が
 * 切り替わっていないことを確認してから最新 snapshot で parking 候補を選ぶ。最終世代確認、
 * selection、同期 commit は同じ Promise continuation 内で完結させ、stale な候補を caller が
 * 後から mutate できないようにする。realpath を一つでも確定できない回は parking を見送るが、
 * commit callback に最新 folder を渡すので added-folder open は継続できる。callback の戻り値は
 * commit 後に await できるよう result へそのまま返す。
 */
export async function commitRepositoriesForParking<T extends IParadisUnaccountedCandidate, R>(
	getSnapshot: () => IParadisParkingSnapshot<T>,
	isCurrent: () => boolean,
	resolveRealPath: (folderPath: string) => Promise<string | undefined>,
	isDescendant: (parent: string, descendant: string) => boolean,
	pathEquals: (a: string, b: string) => boolean,
	commit: (repositoriesToPark: readonly T[], currentFolderPaths: readonly string[]) => R,
): Promise<ParadisParkingCoordinatorResult<R>> {
	const initialSnapshot = getSnapshot();
	const realPaths = await Promise.all(initialSnapshot.currentFolderPaths.map(async folderPath => {
		try {
			return await resolveRealPath(folderPath);
		} catch {
			return undefined;
		}
	}));

	const latestSnapshot = getSnapshot();
	if (!isCurrent() || !currentFoldersMatch(initialSnapshot.currentFolderPaths, latestSnapshot.currentFolderPaths, pathEquals)) {
		return { kind: 'stale' };
	}

	const skippedParking = realPaths.some(realPath => realPath === undefined);
	const resolvedRealPaths = realPaths.filter((realPath): realPath is string => realPath !== undefined);
	const repositoriesToPark = skippedParking ? [] : selectRepositoriesForUnifiedParking(
			latestSnapshot.removedRepositories,
			latestSnapshot.openRepositories,
			latestSnapshot.activeRepositories,
			[...latestSnapshot.currentFolderPaths, ...resolvedRealPaths],
			isDescendant,
			pathEquals,
		);

	const commitResult = commit(repositoriesToPark, latestSnapshot.currentFolderPaths);
	return { kind: 'committed', skippedParking, commitResult };
}
