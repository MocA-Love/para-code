/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 古い依存とビルド出力の掃除（Orca W3 の G-07、Orca #32331）の、画面とリポジトリのあるマシンで共有する型と決まり。

/** 消す候補のフォルダの名前（Orca と同じ）。 */
export const PARADIS_GENERATED_OUTPUT_NAMES: readonly string[] = ['node_modules', 'out', 'dist', 'build'];

/** この日数より前から変わっていないものだけを候補にする（Orca の既定と同じ 30 日）。 */
export const PARADIS_GENERATED_OUTPUT_MIN_AGE_DAYS = 30;

/** 消す候補 1 つ。消す直前に、探したときと同じフォルダかを `dev`・`ino` で確かめる。 */
export interface IParadisGeneratedOutputCandidate {
	/** git の一覧にあるワークツリーのパス（リポジトリのあるマシンでの綴り）。 */
	readonly worktree: string;
	/** ワークツリーのルートからの相対パス（`/` 区切り）。 */
	readonly rel: string;
	readonly dev: number;
	readonly ino: number;
	readonly mtimeMs: number;
}

/** 探す依頼。`excludePaths` は消さないワークツリー（今開いているスペースなど）。 */
export interface IParadisFindGeneratedOutputsRequest<TPath extends string = string> {
	readonly repoPath: TPath;
	readonly excludePaths: readonly TPath[];
}

/** 消す依頼。受け側はワークツリーの一覧を読み直し、候補を測り直してから消す。 */
export interface IParadisRemoveGeneratedOutputsRequest<TPath extends string = string> extends IParadisFindGeneratedOutputsRequest<TPath> {
	readonly candidates: readonly IParadisGeneratedOutputCandidate[];
}

/** 消した結果（パスはリポジトリのあるマシンでの綴り）。`changed` は測り直して変わっていたので消さなかったもの。 */
export interface IParadisRemoveGeneratedOutputsResult {
	readonly removed: readonly string[];
	readonly changed: readonly string[];
	readonly failed: readonly string[];
}
