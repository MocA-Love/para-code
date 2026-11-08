/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードが作るワークツリーにも、スペースの作成と同じ持ち込み（G-06。`.paracode.json` の `worktree` と
// `.worktreeinclude`）を行う（762-RES）。手元のボードは接続口（shared process）から、SSH のボードは接続先の REH から呼ぶ。
// 中身はスペースの作成と同じ ParadisWorktreeGitService の口を使う（規則・リンクの記録・WSL の扱いを二重に持たない）。

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisSummarizeWorktreeIncludeFailure, paradisSummarizeWorktreeIncludeSkips } from '../../workspaceSwitch/common/paradisWorktreeInclude.js';
import { ParadisWorktreeGitService } from '../../workspaceSwitch/node/paradisWorktreeGitChannel.js';
import { IParadisWorktreeLinkRecord, paradisReadWorktreeIncludeDeclarations } from '../../workspaceSwitch/node/paradisWorktreeIncludeCopy.js';

/** 返却の結果。`dirty` は未コミットの変更があって残した、`failed` は git が断った（どちらもリンクは作り直してある）。 */
export type ParadisTaskBoardWorktreeReleaseResult = 'removed' | 'dirty' | 'failed';

/** タスクボードのワークツリーへの持ち込みと、その片付け。 */
export interface IParadisTaskBoardWorktreeIncludes {
	/** 作った直後に持ち込む。持ち込めなかったものがあれば、画面に出す 1 行。宣言が無ければ何もせず undefined。 */
	copy(repoPath: string, worktreePath: string): Promise<string | undefined>;
	/** 持ち込みで作り、今も残っているリンクの相対パス（未コミットの変更の確かめから外す）。 */
	linkPaths(worktreePath: string): Promise<string[]>;
	/** 削除の前にリンクを外す。外したものを返す。 */
	unlink(worktreePath: string): Promise<IParadisWorktreeLinkRecord[]>;
	/** 削除が断られたときに、外したリンクを作り直す。 */
	restore(worktreePath: string, records: readonly IParadisWorktreeLinkRecord[]): Promise<void>;
	/** リンクを外す → 未コミットの変更が無ければ `--force` 無しで消す → 残すときはリンクを作り直す。 */
	release(repoPath: string, worktreePath: string): Promise<ParadisTaskBoardWorktreeReleaseResult>;
}

/** {@link IParadisTaskBoardWorktreeIncludes} を ParadisWorktreeGitService で作る。 */
export function paradisTaskBoardWorktreeIncludes(git: ParadisWorktreeGitService, logService: ILogService): IParadisTaskBoardWorktreeIncludes {
	return {
		copy: async (repoPath, worktreePath) => {
			try {
				return paradisSummarizeWorktreeIncludeSkips(await git.copyWorktreeIncludes({ repoPath, worktreePath }));
			} catch (error) {
				logService.warn('[ParadisTaskBoard] copying the declared files into a task board worktree failed', toErrorMessage(error));
				// 宣言の無いリポジトリでは、失敗を知らせない（スペースの作成と同じ）
				const declarations = await paradisReadWorktreeIncludeDeclarations(repoPath).catch(() => undefined);
				return declarations && (declarations.include.length > 0 || declarations.sharedDirectories.length > 0) ? paradisSummarizeWorktreeIncludeFailure(toErrorMessage(error)) : undefined;
			}
		},
		linkPaths: worktreePath => git.worktreeIncludeLinkPaths(worktreePath),
		unlink: worktreePath => git.unlinkWorktreeIncludeLinks(worktreePath),
		restore: (worktreePath, records) => git.restoreWorktreeIncludeLinks(worktreePath, records),
		release: (repoPath, worktreePath) => git.releaseCleanWorktree({ repoPath, worktreePath }),
	};
}
