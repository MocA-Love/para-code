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
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';
import { PARADIS_DEFAULT_AGENT_COMMANDS } from '../common/paradisWorktreeCreate.js';
import { PARADIS_WORKSPACES_VIEW_ID } from '../browser/paradisWorkspacesView.js';
import { openParadisCreateWorktreeDialog } from './paradisCreateWorktreeDialog.js';

export const PARADIS_CREATE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.createWorktree';

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
			description: localize('paradis.workspaceSwitch.worktreeRoot', "「新しいスペース（worktree）を作成」で worktree を作るベースディレクトリ（絶対パス）。配下に <リポジトリ名>/<スペース名>/ が作られます。空の場合はリポジトリの隣の <リポジトリ名>-worktrees/ に作成します。")
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
