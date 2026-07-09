/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいスペース（worktree）を作成」コマンドの登録（Workspaces ビューのタイトルボタン +
// コマンドパレット）と、関連設定の登録。ダイアログ本体は paradisCreateWorktreeDialog.ts。
// git 実行（shared process チャネル）と Electron 依存があるため electron-browser 層に置く。

import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { IParadisRemoveWorktreeRequest, PARADIS_DEFAULT_AGENT_COMMANDS, PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';
import { PARADIS_WORKSPACES_VIEW_ID } from '../browser/paradisWorkspacesView.js';
import { openParadisCreateWorktreeDialog } from './paradisCreateWorktreeDialog.js';

export const PARADIS_CREATE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.createWorktree';
export const PARADIS_REMOVE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.removeWorktree';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		'paradis.workspaceSwitch.worktreeRoot': {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.workspaceSwitch.worktreeRoot', "「新しいスペース（worktree）を作成」で worktree を作るベースディレクトリ（絶対パス）。配下に <リポジトリ名>/<ブランチ由来ディレクトリ名>/ が作られます。空の場合はリポジトリの隣の <リポジトリ名>-worktrees/ に作成します。")
		},
		'paradis.workspaceSwitch.agents': {
			type: 'array',
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.workspaceSwitch.agents', "「新しいスペース（worktree）を作成」で選択できるエージェント CLI の一覧。command 内の {prompt} がシェルエスケープ済みのプロンプトに置換されます（無い場合は末尾に追加）。"),
			items: {
				type: 'object',
				required: ['id', 'command'],
				properties: {
					id: { type: 'string', description: localize('paradis.workspaceSwitch.agents.id', "エージェントの識別子。") },
					label: { type: 'string', description: localize('paradis.workspaceSwitch.agents.label', "選択肢として表示する名前。") },
					command: { type: 'string', description: localize('paradis.workspaceSwitch.agents.command', "ターミナルで実行するコマンド。例: claude {prompt}") }
				}
			},
			default: PARADIS_DEFAULT_AGENT_COMMANDS.map(agent => ({ ...agent }))
		}
	}
});

class ParadisCreateWorktreeAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_CREATE_WORKTREE_COMMAND_ID,
			title: localize2('paradis.workspaceSwitch.createWorktree', "New Worktree Space..."),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
			icon: Codicon.sparkle
		});
	}

	async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		const contextService = accessor.get(IWorkspaceContextService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const switchService = accessor.get(IParadisWorkspaceSwitchService);

		// 切り替え機能と同じくマルチルートワークスペースが前提
		if (contextService.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
			notificationService.prompt(
				Severity.Warning,
				localize('paradis.createWorktree.requiresWorkspace', "Para Code worktree creation requires a multi-root workspace. Initialize the Para Code workspace first."),
				[{
					label: localize('paradis.createWorktree.initializeAction', "Initialize Workspace"),
					run: () => commandService.executeCommand('paradis.workspaceSwitch.initialize')
				}]
			);
			return;
		}
		if (switchService.repositories.length === 0) {
			notificationService.prompt(
				Severity.Info,
				localize('paradis.createWorktree.noRepositories', "No repositories are registered yet."),
				[{
					label: localize('paradis.createWorktree.addRepositoryAction', "Add Repository"),
					run: () => commandService.executeCommand('paradis.workspaceSwitch.addRepository')
				}]
			);
			return;
		}

		openParadisCreateWorktreeDialog(accessor, typeof repositoryId === 'string' ? repositoryId : undefined);
	}
}

registerAction2(ParadisCreateWorktreeAction);

/**
 * ワークツリー（スペース）をディスクごと削除するコマンド。Workspaces ビューの worktree 行の
 * コンテキストメニューから、対象の IParadisWorktree を引数に呼ばれる（browser 層のビューは
 * ID 経由でこのコマンドを実行する。git 実行と shared process チャネル依存があるため
 * electron-browser 層に置く）。
 */
class ParadisRemoveWorktreeAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_REMOVE_WORKTREE_COMMAND_ID,
			title: localize2('paradis.workspaceSwitch.removeWorktree', "Remove Worktree"),
			category: localize2('paradis.category', "Para Code"),
			f1: false
		});
	}

	async run(accessor: ServicesAccessor, worktree?: IParadisWorktree): Promise<void> {
		if (!worktree) {
			return;
		}
		const dialogService = accessor.get(IDialogService);
		const switchService = accessor.get(IParadisWorkspaceSwitchService);
		const worktreeService = accessor.get(IParadisWorktreeService);
		const sharedProcessService = accessor.get(ISharedProcessService);
		const logService = accessor.get(ILogService);

		// executeCommand 経由で渡ってくる URI が復元済みでない可能性に備えて revive する
		const uri = URI.isUri(worktree.uri) ? worktree.uri : URI.revive(worktree.uri);

		const repository = switchService.repositories.find(candidate => candidate.id === worktree.repositoryId);
		if (!repository) {
			return;
		}

		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			// allow-any-unicode-next-line
			message: localize('paradis.workspaceSwitch.removeWorktreeConfirm', "ワークツリー「{0}」を削除しますか？", worktree.name),
			// allow-any-unicode-next-line
			detail: localize('paradis.workspaceSwitch.removeWorktreeDetail', "パス: {0}\n\nディスク上の作業ツリーを削除します。未コミットの変更は失われます。", uri.fsPath),
			// allow-any-unicode-next-line
			primaryButton: localize('paradis.workspaceSwitch.removeWorktreeConfirmAction', "削除")
		});
		if (!confirmed) {
			return;
		}

		// 削除対象が現在アクティブなワークスペースの場合、先に親リポジトリへ切り替えてから削除する
		// （削除後に存在しないフォルダを開いたままにしないため）
		if (switchService.activeStateKey === paradisWorktreeStateKey(uri)) {
			try {
				await switchService.switchRepository(worktree.repositoryId);
			} catch (error) {
				logService.warn('[ParadisRemoveWorktree] switch to parent repository before removal failed', error);
			}
		}

		const channel = sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL);
		const removeRequest: IParadisRemoveWorktreeRequest = {
			repoPath: repository.uri.fsPath,
			worktreePath: uri.fsPath,
			force: false
		};

		try {
			await channel.call('removeWorktree', [removeRequest]);
		} catch (error) {
			// 未コミット変更・未追跡ファイルがあると force なしでは失敗する。強制削除を追加確認する
			const { confirmed: forceConfirmed } = await dialogService.confirm({
				type: 'warning',
				// allow-any-unicode-next-line
				message: localize('paradis.workspaceSwitch.removeWorktreeForceConfirm', "ワークツリーを削除できませんでした。強制削除しますか？"),
				detail: `${error instanceof Error ? error.message : String(error)}\n\n`
					// allow-any-unicode-next-line
					+ localize('paradis.workspaceSwitch.removeWorktreeForceDetail', "--force で強制削除します。未コミットの変更や未追跡ファイルは完全に失われます。"),
				// allow-any-unicode-next-line
				primaryButton: localize('paradis.workspaceSwitch.removeWorktreeForceAction', "強制削除")
			});
			if (!forceConfirmed) {
				return;
			}
			try {
				await channel.call('removeWorktree', [{ ...removeRequest, force: true }]);
			} catch (forceError) {
				logService.error('[ParadisRemoveWorktree] force removal failed', forceError);
				await dialogService.error(
					// allow-any-unicode-next-line
					localize('paradis.workspaceSwitch.removeWorktreeFailed', "ワークツリーの削除に失敗しました。"),
					forceError instanceof Error ? forceError.message : String(forceError)
				);
				return;
			}
		}

		// git worktree remove は .git/worktrees/<name> のメタデータも消すため watcher 経由で
		// いずれ一覧が更新されるが、既知リストから即座に外して反映を早める
		worktreeService.removeKnownWorktree({ ...worktree, uri });
	}
}

registerAction2(ParadisRemoveWorktreeAction);

// Workspaces ビュータイトルのボタン（「+」ボタンの左に配置）
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: {
		id: PARADIS_CREATE_WORKTREE_COMMAND_ID,
		title: localize2('paradis.workspaceSwitch.createWorktreeMenu', "New Worktree Space..."),
		icon: Codicon.sparkle
	},
	when: ContextKeyExpr.equals('view', PARADIS_WORKSPACES_VIEW_ID),
	group: 'navigation',
	order: 0
});
