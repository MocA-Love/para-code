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
): T[] {
	return candidates.filter(candidate => {
		const roots = candidate.repository.rootRealPath !== undefined
			? [candidate.repository.root, candidate.repository.rootRealPath]
			: [candidate.repository.root];
		return !currentFolderPaths.some(folder => roots.some(root => isDescendant(folder, root) || isDescendant(root, folder)));
	});
}
