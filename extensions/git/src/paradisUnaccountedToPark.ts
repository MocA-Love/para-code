/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// Kept free of any `vscode` import (unlike paradisRepositoryPark.ts) so selectUnaccountedForParking
// can be unit tested outside the extension host.

/** {@link paradisRepositoryBelongsToFolder} が判定に使うリポジトリの形。 */
export interface IParadisRepositoryLocation {
	readonly root: string;
	readonly rootRealPath?: string;
	/** `Repository.kind`。`'worktree'` はリンクされたワークツリー（`git worktree add` で作ったもの）。 */
	readonly kind?: string;
}

/** {@link selectUnaccountedForParking} が判定に必要とする最小限の形。 */
export interface IParadisUnaccountedCandidate {
	readonly repository: IParadisRepositoryLocation;
}

/**
 * `outerRoot` の中にある `folder` について、`folder` 自身か、`outerRoot` より下のその祖先に別の
 * 作業ツリー（`.git` を持つフォルダ。入れ子のワークツリー・サブモジュール・独立したリポジトリ）があるか。
 * `folder` と `outerRoot` が同じなら false。`includeOuter` なら範囲を 1 段上へずらし、`outerRoot`
 * 自身を含めて `folder` 自身を含めない（フォルダの中のワークツリーより上に作業ツリーがあるか、を見る）。
 */
export type ParadisWorkingTreeBetween = (outerRoot: string, folder: string, includeOuter?: boolean) => boolean;

/**
 * {@link ParadisWorkingTreeBetween} を作る。`hasDotGit` はそのフォルダの直下に `.git`（ディレクトリでも
 * ファイルでも）があるか。`folder` から `outerRoot` の手前まで親へたどって確かめる。
 */
export function paradisHasWorkingTreeBetween(
	hasDotGit: (folder: string) => boolean,
	dirname: (path: string) => string,
	isDescendant: (parent: string, descendant: string) => boolean,
	pathEquals: (a: string, b: string) => boolean,
): ParadisWorkingTreeBetween {
	return (outerRoot, folder, includeOuter = false) => {
		if (pathEquals(folder, outerRoot) || !isDescendant(outerRoot, folder)) {
			return false;
		}
		let current = includeOuter ? dirname(folder) : folder;
		while (isDescendant(outerRoot, current)) {
			const atOuter = pathEquals(current, outerRoot);
			if (atOuter && !includeOuter) {
				break;
			}
			if (hasDotGit(current)) {
				return true;
			}
			const parent = dirname(current);
			if (atOuter || parent === current) {
				break;
			}
			current = parent;
		}
		return false;
	};
}

/**
 * リポジトリがワークスペースフォルダ（＝今のスペース）に属するか。git の「いちばん近い `.git` が持ち主」
 * という規則に揃える。待避の判定（{@link selectUnaccountedForParking}・`ParadisRepositoryParkingLot.unparkForFolder`）
 * と、SCM ビューの絞り込み（`src/vs/paradis/contrib/workspaceSwitch/common/paradisScmScope.ts` の
 * `paradisIsScmRootInScope`）は同じ規則にする（別のビルド単位なので関数は共有できない。片方を変えたら
 * もう片方も変えること）。
 *
 * - ルートとフォルダが同じ: 属する
 * - フォルダがリポジトリの中にある（リポジトリ内のサブフォルダをスペースとして開いている）: 属する。
 *   ただし、その間に別の作業ツリーがあれば（入れ子のワークツリーのスペース等）、外側のリポジトリは属さない
 * - リポジトリがフォルダの中にある（入れ子のリポジトリ）: 属する。ただしリンクされたワークツリーは、
 *   フォルダからワークツリーまでの間に別の作業ツリー（メイン）があれば、それ自体が別のスペースなので属さない
 *   （入れ子のサブモジュール・独立したリポジトリ、リポジトリでないフォルダの中のワークツリーは今までどおり属する）
 */
export function paradisRepositoryBelongsToFolder(
	repository: IParadisRepositoryLocation,
	folder: string,
	isDescendant: (parent: string, descendant: string) => boolean,
	pathEquals: (a: string, b: string) => boolean,
	hasWorkingTreeBetween: ParadisWorkingTreeBetween = () => false,
): boolean {
	const roots = repository.rootRealPath !== undefined ? [repository.root, repository.rootRealPath] : [repository.root];
	return roots.some(root => pathEquals(folder, root)
		|| (isDescendant(root, folder) && !hasWorkingTreeBetween(root, folder))
		|| (isDescendant(folder, root) && !(repository.kind === 'worktree' && hasWorkingTreeBetween(folder, root, true))));
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
 * 属するかは {@link paradisRepositoryBelongsToFolder}（`unparkForFolder` と同じ規則）で決める。
 * `rootRealPath` があればそれも照合し、シンボリックリンク越しの一致も見逃さない。
 */
export function selectUnaccountedForParking<T extends IParadisUnaccountedCandidate>(
	candidates: readonly T[],
	currentFolderPaths: readonly string[],
	isDescendant: (parent: string, descendant: string) => boolean,
	pathEquals: (a: string, b: string) => boolean = (a, b) => a === b,
	hasWorkingTreeBetween: ParadisWorkingTreeBetween = () => false,
): T[] {
	return candidates.filter(candidate => !currentFolderPaths.some(folder => paradisRepositoryBelongsToFolder(candidate.repository, folder, isDescendant, pathEquals, hasWorkingTreeBetween)));
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
	hasWorkingTreeBetween: ParadisWorkingTreeBetween = () => false,
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

	return selectUnaccountedForParking(candidates, currentFolderPaths, isDescendant, pathEquals, hasWorkingTreeBetween);
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
	hasWorkingTreeBetween: ParadisWorkingTreeBetween = () => false,
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
		hasWorkingTreeBetween,
	);

	const commitResult = commit(repositoriesToPark, latestSnapshot.currentFolderPaths);
	return { kind: 'committed', skippedParking, commitResult };
}
