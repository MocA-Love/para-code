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
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { IParadisDiffStat, IParadisPrStatus, IParadisRemoveWorktreeRequest, PARADIS_DEFAULT_AGENT_COMMANDS, PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';
import { PARADIS_WORKSPACES_VIEW_ID } from '../browser/paradisWorkspacesView.js';
import { openParadisCreateWorktreeDialog } from './paradisCreateWorktreeDialog.js';
import { paradisRunWorkspaceLifecycleScript } from './paradisWorkspaceLifecycleService.js';
import { openParadisWorkspaceLifecycleDialog } from './paradisWorkspaceLifecycleDialog.js';

export const PARADIS_CREATE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.createWorktree';
export const PARADIS_REMOVE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.removeWorktree';
export const PARADIS_CONFIGURE_LIFECYCLE_SCRIPTS_COMMAND_ID = 'paradis.workspaceSwitch.configureLifecycleScripts';
export const PARADIS_GET_DIFF_STATS_COMMAND_ID = 'paradis.workspaceSwitch.getDiffStats';
export const PARADIS_GET_PR_STATUSES_COMMAND_ID = 'paradis.workspaceSwitch.getPrStatuses';

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
					id: { type: 'string', not: { const: 'none' }, description: localize('paradis.workspaceSwitch.agents.id', "エージェントの識別子。'none' は「実行しない」の予約識別子のため使用不可。") },
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
/**
 * teardown スクリプト起因の失敗を、削除フロー内の他の想定外エラーと区別するためのマーカー。
 * これで包まれていないエラーに「セットアップ解除スクリプトが失敗した」と誤って案内しないために使う。
 */
class ParadisTeardownFailedError extends Error {
	constructor(readonly reason: unknown) {
		super(reason instanceof Error ? reason.message : String(reason));
	}
}

/**
 * 親リポジトリへの切り替え失敗を、削除フロー内の他の想定外エラーと区別するためのマーカー。
 * switchToParent の唯一の目的は「削除後に存在しないフォルダを開いたままにしない」ことなので、
 * 失敗したまま削除を続行すると、開いているフォルダがディスクから消えてウィンドウが
 * ゴースト状態になる。teardown 失敗と同様に削除を中止するために使う。
 */
class ParadisSwitchToParentFailedError extends Error {
	constructor(readonly reason: unknown) {
		super(reason instanceof Error ? reason.message : String(reason));
	}
}

/** worktree 削除前後の一連のアクション（順序・失敗時の打ち切りをテストしやすいよう分離）。 */
export interface IParadisRemoveWorktreeActions {
	/** リポジトリ定義の teardownScript を実行する。失敗したら後続（切り替え・削除）を一切実行しない。 */
	runTeardown(): Promise<void>;
	/** 削除対象が現在アクティブなら親リポジトリへ切り替える。失敗したら削除を実行しない。 */
	switchToParent(): Promise<void>;
	/** git worktree remove（force 再試行込み）を実行する。 */
	remove(): Promise<void>;
}

/** teardown → 親への切り替え → 削除、の順で実行する。 */
export async function paradisRemoveWorktreeSequence(actions: IParadisRemoveWorktreeActions): Promise<void> {
	await actions.runTeardown();
	await actions.switchToParent();
	await actions.remove();
}

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
		// アクセサは同期実行中しか有効でないため、await をまたぐ teardown 実行用に
		// instantiationService だけ取り出しておき、実行時は invokeFunction で新しいアクセサを作る
		const instantiationService = accessor.get(IInstantiationService);

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
		const stateKey = paradisWorktreeStateKey(uri);
		if (!await switchService.prepareScopeRetirement(stateKey)) {
			return;
		}

		let scopeRetired = false;
		try {
			await paradisRemoveWorktreeSequence({
				runTeardown: async () => {
					// リポジトリ定義の teardownScript。失敗したら切り替え・削除を一切行わない
					try {
						await instantiationService.invokeFunction(paradisRunWorkspaceLifecycleScript, 'teardown', repository, uri);
					} catch (error) {
						throw new ParadisTeardownFailedError(error);
					}
				},
				switchToParent: async () => {
					// 削除対象が現在アクティブなワークスペースの場合、先に親リポジトリへ切り替えてから削除する
					// （削除後に存在しないフォルダを開いたままにしないため）。切り替えに失敗したまま
					// 削除を続行すると、開いているフォルダがディスクから消えてウィンドウが壊れるため中止する
					if (switchService.activeStateKey !== paradisWorktreeStateKey(uri)) {
						return;
					}
					try {
						await switchService.switchRepository(worktree.repositoryId);
					} catch (error) {
						throw new ParadisSwitchToParentFailedError(error);
					}
				},
				remove: async () => {
					const channel = sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL);
					const removeRequest: IParadisRemoveWorktreeRequest = {
						repoPath: repository.uri.fsPath,
						worktreePath: uri.fsPath,
						force: false
					};

					let removedFromDisk = false;
					try {
						await channel.call('removeWorktree', [removeRequest]);
						removedFromDisk = true;
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
							removedFromDisk = true;
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
					if (!removedFromDisk) {
						return;
					}

					// git worktree remove は .git/worktrees/<name> のメタデータも消すため watcher 経由で
					// いずれ一覧が更新されるが、既知リストから即座に外して反映を早める
					scopeRetired = await worktreeService.removeKnownWorktree({ ...worktree, uri });
				},
			});
		} catch (error) {
			if (error instanceof ParadisTeardownFailedError) {
				logService.error('[ParadisRemoveWorktree] teardown failed', error.reason);
				await dialogService.error(
					// allow-any-unicode-next-line
					localize('paradis.workspaceSwitch.removeWorktreeTeardownFailed', "セットアップ解除スクリプトが失敗したため、削除を中止しました。"),
					error.message
				);
				return;
			}
			if (error instanceof ParadisSwitchToParentFailedError) {
				logService.error('[ParadisRemoveWorktree] switch to parent repository before removal failed', error.reason);
				await dialogService.error(
					// allow-any-unicode-next-line
					localize('paradis.workspaceSwitch.removeWorktreeSwitchFailed', "親リポジトリへの切り替えに失敗したため、削除を中止しました。ワークツリーは削除されていません（設定されているセットアップ解除スクリプトは実行済みです）。"),
					error.message
				);
				return;
			}
			logService.error('[ParadisRemoveWorktree] removal failed', error);
			await dialogService.error(
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.removeWorktreeUnexpectedFailed', "ワークツリーの削除中に予期しないエラーが発生しました。"),
				error instanceof Error ? error.message : String(error)
			);
		} finally {
			if (!scopeRetired) {
				switchService.cancelScopeRetirement(stateKey);
			}
		}
	}
}

registerAction2(ParadisRemoveWorktreeAction);

/**
 * 各作業ツリーの未コミット差分 (+/-行数) をまとめて返すコマンド。
 * Workspaces ビュー (browser 層) がポーリングで ID 経由で呼ぶ。git 実行は shared process の
 * worktree git チャネルに委譲する (web ビルドでは未登録のため呼び出し側で安全に無効化される)。
 */
class ParadisGetDiffStatsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_GET_DIFF_STATS_COMMAND_ID,
			title: localize2('paradis.workspaceSwitch.getDiffStats', "Get Worktree Diff Stats"),
			category: localize2('paradis.category', "Para Code"),
			f1: false
		});
	}

	async run(accessor: ServicesAccessor, paths?: string[]): Promise<Record<string, IParadisDiffStat>> {
		if (!Array.isArray(paths) || paths.length === 0) {
			return {};
		}
		const sharedProcessService = accessor.get(ISharedProcessService);
		const channel = sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL);
		const result: Record<string, IParadisDiffStat> = {};
		await Promise.all(paths.map(async path => {
			try {
				result[path] = await channel.call<IParadisDiffStat>('getDiffStat', [path]);
			} catch {
				// 個々のパスの失敗 (worktree が消えた等) は無視し、他のパスの結果は返す
			}
		}));
		return result;
	}
}

registerAction2(ParadisGetDiffStatsAction);

/**
 * 各作業ツリーの現在ブランチに紐づく GitHub PR の状態をまとめて返すコマンド。
 * Workspaces ビュー (browser 層) がポーリングで ID 経由で呼ぶ。gh CLI の実行は shared process の
 * worktree git チャネルに委譲する (web ビルドでは未登録のため呼び出し側で安全に無効化される)。
 */
class ParadisGetPrStatusesAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_GET_PR_STATUSES_COMMAND_ID,
			title: localize2('paradis.workspaceSwitch.getPrStatuses', "Get Worktree Pull Request Statuses"),
			category: localize2('paradis.category', "Para Code"),
			f1: false
		});
	}

	async run(accessor: ServicesAccessor, paths?: string[]): Promise<Record<string, IParadisPrStatus>> {
		if (!Array.isArray(paths) || paths.length === 0) {
			return {};
		}
		const sharedProcessService = accessor.get(ISharedProcessService);
		const channel = sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL);
		const result: Record<string, IParadisPrStatus> = {};
		await Promise.all(paths.map(async path => {
			try {
				const status = await channel.call<IParadisPrStatus | undefined>('getPrStatus', [path]);
				if (status) {
					result[path] = status;
				}
			} catch {
				// 個々のパスの失敗 (worktree が消えた等) は無視し、他のパスの結果は返す
			}
		}));
		return result;
	}
}

registerAction2(ParadisGetPrStatusesAction);

/**
 * リポジトリの Setup/Teardown スクリプト（.paracode.json）を編集するダイアログを開くコマンド。
 * Workspaces ビューのリポジトリ行コンテキストメニューから ID 経由で呼ぶ。
 */
class ParadisConfigureLifecycleScriptsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_CONFIGURE_LIFECYCLE_SCRIPTS_COMMAND_ID,
			title: localize2('paradis.workspaceSwitch.configureLifecycleScripts', "Setup/Teardown Scripts..."),
			category: localize2('paradis.category', "Para Code"),
			f1: false
		});
	}

	run(accessor: ServicesAccessor, repositoryId?: string): void {
		if (typeof repositoryId !== 'string') {
			return;
		}
		const switchService = accessor.get(IParadisWorkspaceSwitchService);
		const repository = switchService.repositories.find(candidate => candidate.id === repositoryId);
		if (!repository) {
			return;
		}
		openParadisWorkspaceLifecycleDialog(accessor, repository);
	}
}

registerAction2(ParadisConfigureLifecycleScriptsAction);

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
