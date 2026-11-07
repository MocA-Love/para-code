/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「古い依存とビルド出力を掃除...」（Orca W3 の G-07、Orca #32331）。スペースの行の右クリックから、そのリポジトリの
// ほかのワークツリー（30 日以上使っていないもの）に残った 30 日より古い node_modules・out・dist・build を探し、何を消すかを確認に出してから消す。
// ワークツリーの削除とは別の操作（比較モックの案どおり）。探すのと消すのはリポジトリのあるマシンで行う。

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { basename } from '../../../../base/common/path.js';
import { isEqualAuthority } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';
import { IParadisFindGeneratedOutputsRequest, IParadisGeneratedOutputCandidate, IParadisRemoveGeneratedOutputsRequest, IParadisRemoveGeneratedOutputsResult, PARADIS_GENERATED_OUTPUT_MIN_AGE_DAYS } from '../common/paradisWorktreeGeneratedCleanup.js';
import { paradisWorktreeGitWriteHostResolver } from './paradisWorktreeGitChannelClient.js';

/** 「古い依存とビルド出力を掃除...」のコマンド。引数はリポジトリの ID。 */
export const PARADIS_CLEAN_GENERATED_OUTPUTS_COMMAND_ID = 'paradis.workspaceSwitch.cleanGeneratedOutputs';

/** 確認に並べる行の数の上限（超える分は件数だけ）。 */
const MAX_LISTED = 30;

/** 確認に出す 1 行（ワークツリーの名前/相対パス（何日前））。 */
export function paradisDescribeGeneratedOutput(candidate: IParadisGeneratedOutputCandidate, now: number): string {
	const days = Math.max(0, Math.floor((now - candidate.mtimeMs) / 86_400_000));
	// allow-any-unicode-next-line
	return localize('paradis.generatedCleanup.item', "{0}/{1}（{2} 日前）", basename(candidate.worktree), candidate.rel, days);
}

class ParadisCleanGeneratedOutputsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_CLEAN_GENERATED_OUTPUTS_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.generatedCleanup.command', "古い依存とビルド出力を掃除..."),
			category: localize2('paradis.category', "Para Code"),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		if (typeof repositoryId !== 'string') {
			return;
		}
		const repository = accessor.get(IParadisWorkspaceSwitchService).repositories.find(candidate => candidate.id === repositoryId);
		if (!repository) {
			return;
		}
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		// 消すのは書き込みなので、別ホスト・未接続の接続先へ流さない write resolver を使う
		const host = paradisWorktreeGitWriteHostResolver(accessor)(repository.uri);
		if (!host) {
			// allow-any-unicode-next-line
			notificationService.warn(localize('paradis.worktree.unreachableHost', "「{0}」は今つないでいる接続先にありません。このリポジトリがあるマシンへ接続してから実行してください。", repository.name));
			return;
		}
		// 今開いているスペース（同じマシンのもの）は消さない
		const excludePaths = accessor.get(IWorkspaceContextService).getWorkspace().folders
			.filter(folder => folder.uri.scheme === repository.uri.scheme && isEqualAuthority(folder.uri.authority, repository.uri.authority))
			.map(folder => host.path(folder.uri));
		const findRequest: IParadisFindGeneratedOutputsRequest = { repoPath: host.path(repository.uri), excludePaths };

		let candidates: IParadisGeneratedOutputCandidate[];
		try {
			candidates = await progressService.withProgress({
				location: ProgressLocation.Notification,
				// allow-any-unicode-next-line
				title: localize('paradis.generatedCleanup.finding', "「{0}」のワークツリーから、古い依存とビルド出力を探しています…", repository.name),
			}, () => host.channel.call<IParadisGeneratedOutputCandidate[]>('findGeneratedOutputs', [findRequest]));
		} catch (error) {
			notificationService.error(toErrorMessage(error));
			return;
		}
		if (candidates.length === 0) {
			// allow-any-unicode-next-line
			notificationService.info(localize('paradis.generatedCleanup.none', "掃除できるものはありません。「{1}」のほかのワークツリーのうち {0} 日以上使っていないものに、{0} 日より前から変わっていない node_modules・out・dist・build はありませんでした。", PARADIS_GENERATED_OUTPUT_MIN_AGE_DAYS, repository.name));
			return;
		}

		const now = Date.now();
		const lines = candidates.slice(0, MAX_LISTED).map(candidate => paradisDescribeGeneratedOutput(candidate, now));
		if (candidates.length > MAX_LISTED) {
			// allow-any-unicode-next-line
			lines.push(localize('paradis.generatedCleanup.more', "ほか {0} 件", candidates.length - MAX_LISTED));
		}
		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			// allow-any-unicode-next-line
			message: localize('paradis.generatedCleanup.confirm', "古い依存とビルド出力を {0} 件削除しますか？", candidates.length),
			// allow-any-unicode-next-line
			detail: localize('paradis.generatedCleanup.confirmDetail', "{0}\n\n{1} 日以上使っていないワークツリーの中で、{1} 日より前から変わっておらず、git が追跡していないものだけです（括弧の日数はフォルダの日付です）。元のリポジトリ・この窓で開いているスペース・ロックされたワークツリー・リンク・入れ子のリポジトリ（奥まで確かめきれないものを含む）は消しません。消したワークツリーでは、依存を入れ直すまでビルドや実行ができません。", lines.join('\n'), PARADIS_GENERATED_OUTPUT_MIN_AGE_DAYS),
			// allow-any-unicode-next-line
			primaryButton: localize('paradis.generatedCleanup.confirmAction', "削除"),
		});
		if (!confirmed) {
			return;
		}

		const removeRequest: IParadisRemoveGeneratedOutputsRequest = { ...findRequest, candidates };
		try {
			const result = await progressService.withProgress({
				location: ProgressLocation.Notification,
				// allow-any-unicode-next-line
				title: localize('paradis.generatedCleanup.removing', "古い依存とビルド出力を削除しています…"),
			}, () => host.channel.call<IParadisRemoveGeneratedOutputsResult>('removeGeneratedOutputs', [removeRequest]));
			const kept = result.changed.length + result.failed.length;
			notificationService.info(kept === 0
				// allow-any-unicode-next-line
				? localize('paradis.generatedCleanup.done', "{0} 件を削除しました。", result.removed.length)
				// allow-any-unicode-next-line
				: localize('paradis.generatedCleanup.doneWithKept', "{0} 件を削除しました。{1} 件は、確認の後に変わっていたか消せなかったため残しました。", result.removed.length, kept));
		} catch (error) {
			notificationService.error(toErrorMessage(error));
		}
	}
}

registerAction2(ParadisCleanGeneratedOutputsAction);
