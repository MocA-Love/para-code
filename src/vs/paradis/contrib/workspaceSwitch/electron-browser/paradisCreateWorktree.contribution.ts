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
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { IParadisDiffStat, IParadisPrStatus, IParadisRemoveWorktreeRequest, IParadisWorktreeLockInfo, IParadisWorktreeLockQuery, paradisFormatWorktreeLockReason, PARADIS_DEFAULT_AGENT_COMMANDS } from '../common/paradisWorktreeCreate.js';
import { IParadisIssueStatus, IParadisIssueStatusesResult } from '../../../common/paradisIssueDetection.js';
import { PARADIS_WORKSPACES_VIEW_ID } from '../browser/paradisWorkspacesView.js';
import { openParadisCreateWorktreeDialog } from './paradisCreateWorktreeDialog.js';
import { paradisRunWorkspaceLifecycleScript } from './paradisWorkspaceLifecycleService.js';
import { IParadisWorktreeGitHost, paradisWorktreeGitHostResolver, paradisWorktreeGitWriteHostResolver } from './paradisWorktreeGitChannelClient.js';
import { openParadisWorkspaceLifecycleDialog } from './paradisWorkspaceLifecycleDialog.js';
import { IParadisWorktreeCreateQueueService, ParadisWorktreeCreateQueueService } from './paradisWorktreeCreateQueue.js';
import { IParadisHeadlessWorktreeRequest } from './paradisWorktreeHeadlessCreate.js';

// バックグラウンド作成キュー（ダイアログの「作成」が投入し、進行状況を通知/ステータスバー/ビューへ流す）
registerSingleton(IParadisWorktreeCreateQueueService, ParadisWorktreeCreateQueueService, InstantiationType.Delayed);

export const PARADIS_CREATE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.createWorktree';
export const PARADIS_REMOVE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.removeWorktree';
export const PARADIS_CONFIGURE_LIFECYCLE_SCRIPTS_COMMAND_ID = 'paradis.workspaceSwitch.configureLifecycleScripts';
export const PARADIS_GET_DIFF_STATS_COMMAND_ID = 'paradis.workspaceSwitch.getDiffStats';
export const PARADIS_GET_PR_STATUSES_COMMAND_ID = 'paradis.workspaceSwitch.getPrStatuses';
export const PARADIS_GET_ISSUE_STATUSES_COMMAND_ID = 'paradis.workspaceSwitch.getIssueStatuses';

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
					command: { type: 'string', description: localize('paradis.workspaceSwitch.agents.command', "ターミナルで実行するコマンド。{prompt} に加えて {model} / {effort} / {permission} プレースホルダも使えます（省略時は選択されたフラグをプロンプト直前へ挿入）。例: claude {prompt}") },
					models: {
						type: 'array',
						description: localize('paradis.workspaceSwitch.agents.models', "モデルの選択肢。未定義ならモデル欄を表示しません。"),
						items: {
							type: 'object',
							required: ['id', 'flag'],
							properties: {
								id: { type: 'string' },
								label: { type: 'string' },
								flag: { type: 'string', description: localize('paradis.workspaceSwitch.agents.models.flag', "選択時にコマンドへ付与するフラグ。例: --model opus") },
								efforts: { type: 'array', items: { type: 'string' }, description: localize('paradis.workspaceSwitch.agents.models.efforts', "このモデルで選べるエフォート id。空配列でエフォート非対応、未定義で全エフォートを許可。") },
								defaultEffort: { type: 'string', description: localize('paradis.workspaceSwitch.agents.models.defaultEffort', "「既定」選択時の表示に添える実際の既定エフォート。") }
							}
						}
					},
					efforts: {
						type: 'array',
						description: localize('paradis.workspaceSwitch.agents.efforts', "エフォートの語彙（id とフラグ）。未定義ならエフォート欄を表示しません。"),
						items: {
							type: 'object',
							required: ['id', 'flag'],
							properties: {
								id: { type: 'string' },
								flag: { type: 'string', description: localize('paradis.workspaceSwitch.agents.efforts.flag', "選択時にコマンドへ付与するフラグ。例: --effort high") }
							}
						}
					},
					permissions: {
						type: 'array',
						description: localize('paradis.workspaceSwitch.agents.permissions', "権限モードの選択肢。先頭要素が既定（通常はフラグなし）。未定義なら権限欄を表示しません。"),
						items: {
							type: 'object',
							required: ['id', 'label', 'flag'],
							properties: {
								id: { type: 'string' },
								label: { type: 'string' },
								flag: { type: 'string', description: localize('paradis.workspaceSwitch.agents.permissions.flag', "選択時にコマンドへ付与するフラグ。例: --dangerously-skip-permissions") },
								danger: { type: 'boolean', description: localize('paradis.workspaceSwitch.agents.permissions.danger', "true なら危険な選択肢として赤系ハイライト＋警告表示にします。") },
								hint: { type: 'string', description: localize('paradis.workspaceSwitch.agents.permissions.hint', "選択時に表示する補足説明。") }
							}
						}
					}
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

	async run(accessor: ServicesAccessor, repositoryId?: string, prefill?: IParadisHeadlessWorktreeRequest): Promise<void> {
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

		// prefill はバックグラウンド作成の失敗通知「ダイアログを再表示」から渡される入力値の復元用
		openParadisCreateWorktreeDialog(accessor, typeof repositoryId === 'string' ? repositoryId : undefined, prefill);
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
/**
 * スクリプトの失敗をダイアログに載せられる長さにする。
 * 失敗の理由には子プロセスの stderr がそのまま入っており、上限は 16MB ある。
 * 全部を載せるとダイアログがボタンごと画面外へ流れ、選べなくなる。
 */
const TEARDOWN_FAILURE_DETAIL_MAX_LENGTH = 2000;

function paradisSummarizeScriptFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > TEARDOWN_FAILURE_DETAIL_MAX_LENGTH
		// allow-any-unicode-next-line
		? `${message.slice(0, TEARDOWN_FAILURE_DETAIL_MAX_LENGTH)}…（以降は省略。全文は出力ログを参照）`
		: message;
}

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
	/** リポジトリ定義の teardownScript を実行する。 */
	runTeardown(): Promise<void>;
	/**
	 * teardown が失敗（タイムアウト含む）したときに、それでも削除を続けるかを尋ねる。
	 * true を返したときだけ後続（切り替え・削除）へ進む。省略時は従来どおり打ち切る。
	 */
	confirmTeardownFailure?(error: unknown): Promise<boolean>;
	/** 削除対象が現在アクティブなら親リポジトリへ切り替える。失敗したら削除を実行しない。 */
	switchToParent(): Promise<void>;
	/** git worktree remove（force 再試行込み）を実行する。 */
	remove(): Promise<void>;
}

/**
 * teardown → 親への切り替え → 削除、の順で実行する。
 *
 * teardown の失敗で削除まで止めるのは、後片付けを飛ばしたことに気づかないまま作業ツリーが
 * 消えるのを防ぐため。ただしそれを唯一の答えにすると、失敗し続けるスクリプト（時間のかかる
 * `docker compose down --rmi all --volumes` がタイムアウトする等）が書かれている限り
 * **その worktree を二度と消せなくなる**。続行するかどうかはユーザーに決めさせる。
 */
export async function paradisRemoveWorktreeSequence(actions: IParadisRemoveWorktreeActions): Promise<void> {
	try {
		await actions.runTeardown();
	} catch (error) {
		if (!actions.confirmTeardownFailure || !await actions.confirmTeardownFailure(error)) {
			throw error;
		}
	}
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
		// worktree の削除 (git worktree remove --force 等) は書き込みなので、別ホスト/未接続の
		// vscode-remote へフォールバックしない write resolver を使う（手元へ流すと、絶対パスが
		// 一致する無関係な手元のディレクトリを削除してしまう）。
		const resolveGitHost = paradisWorktreeGitWriteHostResolver(accessor);
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
		// 後片付けが実際に走ったか。削除を中止した場合の案内で「後片付けだけ済んでいる」かどうかを
		// 正しく伝えるために持つ（失敗を承知で飛ばしたときに「実行済みです」と言わないため）。
		let teardownRan = false;
		try {
			await paradisRemoveWorktreeSequence({
				runTeardown: async () => {
					// リポジトリ定義の teardownScript。失敗したら続行するかを尋ねる（confirmTeardownFailure）
					try {
						teardownRan = await instantiationService.invokeFunction(paradisRunWorkspaceLifecycleScript, 'teardown', repository, uri);
					} catch (error) {
						throw new ParadisTeardownFailedError(error);
					}
				},
				confirmTeardownFailure: async error => {
					logService.error('[ParadisRemoveWorktree] teardown failed', error instanceof ParadisTeardownFailedError ? error.reason : error);
					const { confirmed } = await dialogService.confirm({
						type: 'warning',
						// allow-any-unicode-next-line
						message: localize('paradis.workspaceSwitch.removeWorktreeTeardownFailedConfirm', "セットアップ解除スクリプトが失敗しました。それでもワークツリーを削除しますか？"),
						// allow-any-unicode-next-line
						detail: localize('paradis.workspaceSwitch.removeWorktreeTeardownFailedDetail', "{0}\n\n削除を続けると、このスクリプトが行うはずだった後片付け（コンテナ・ボリューム・生成物の削除など）は行われません。中止した場合、ワークツリーは残ります。", paradisSummarizeScriptFailure(error)),
						// allow-any-unicode-next-line
						primaryButton: localize('paradis.workspaceSwitch.removeWorktreeTeardownFailedAction', "それでも削除")
					});
					return confirmed;
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
					// git はこのリポジトリがあるマシンで動かす（作業ツリーも同じマシンにある）
					const host = resolveGitHost(repository.uri);
					if (!host) {
						// allow-any-unicode-next-line
						throw new Error(localize('paradis.worktree.unreachableHost', "「{0}」は今つないでいる接続先にありません。このリポジトリがあるマシンへ接続してから実行してください。", repository.name));
					}
					const { channel, path } = host;
					const removeRequest: IParadisRemoveWorktreeRequest = {
						repoPath: path(repository.uri),
						worktreePath: path(uri),
						force: false
					};

					let removedFromDisk = false;
					try {
						await channel.call('removeWorktree', [removeRequest]);
						removedFromDisk = true;
					} catch (error) {
						// 失敗の理由は2種類あり、求めるべき同意も違う。
						//  - 未コミット変更・未追跡ファイル → --force で消せる（失うのは自分の編集だけ）
						//  - ロック済み → git は -f を2つ要求する。ロックは「いまこの作業ツリーを使っている人が
						//    いる」という主張なので、2段目を黙って付けず、誰が掴んでいるのかを見せたうえで
						//    unlock の同意を取る
						// ロックの判定に git のエラー文言を使わないのは、それが翻訳対象で環境依存のため。
						const lockQuery: IParadisWorktreeLockQuery = { repoPath: removeRequest.repoPath, worktreePath: removeRequest.worktreePath };
						const lock = await channel.call<IParadisWorktreeLockInfo>('readWorktreeLock', [lockQuery])
							.catch(() => ({ locked: false, reason: '' }));
						// ロックが理由とは限らない（掴んでいるプロセス、権限、ネットワークボリューム等）。
						// locked 側はダイアログに元のエラーを載せないので、調査できるようログへ残す。
						// 未コミット変更があるだけの失敗は「強制削除するか聞く」正常系なので warn に留める。
						if (lock.locked) {
							logService.error('[ParadisRemoveWorktree] removal failed on a locked worktree', error);
						} else {
							logService.warn('[ParadisRemoveWorktree] removal failed, asking to force', error);
						}
						const lockReason = paradisFormatWorktreeLockReason(lock.reason);
						const { confirmed: forceConfirmed } = await dialogService.confirm({
							type: 'warning',
							message: lock.locked
								// allow-any-unicode-next-line
								? localize('paradis.workspaceSwitch.removeWorktreeLockedConfirm', "このワークツリーは使用中としてロックされています。ロックを解除して削除しますか？")
								// allow-any-unicode-next-line
								: localize('paradis.workspaceSwitch.removeWorktreeForceConfirm', "ワークツリーを削除できませんでした。強制削除しますか？"),
							detail: lock.locked
								? (lockReason
									// allow-any-unicode-next-line
									? localize('paradis.workspaceSwitch.removeWorktreeLockedDetailWithReason', "ロックの理由: {0}\n\nロックを解除してから強制削除します。このワークツリーで作業中のセッションがあれば、その作業ごと失われます。未コミットの変更や未追跡ファイルも完全に失われます。", lockReason)
									// allow-any-unicode-next-line
									: localize('paradis.workspaceSwitch.removeWorktreeLockedDetail', "ロックを解除してから強制削除します。このワークツリーで作業中のセッションがあれば、その作業ごと失われます。未コミットの変更や未追跡ファイルも完全に失われます。"))
								// allow-any-unicode-next-line
								: localize('paradis.workspaceSwitch.removeWorktreeForceDetail', "{0}\n\n--force で強制削除します。未コミットの変更や未追跡ファイルは完全に失われます。", error instanceof Error ? error.message : String(error)),
							primaryButton: lock.locked
								// allow-any-unicode-next-line
								? localize('paradis.workspaceSwitch.removeWorktreeUnlockAction', "ロックを解除して削除")
								// allow-any-unicode-next-line
								: localize('paradis.workspaceSwitch.removeWorktreeForceAction', "強制削除")
						});
						if (!forceConfirmed) {
							return;
						}
						try {
							await channel.call('removeWorktree', [{ ...removeRequest, force: true, unlock: lock.locked }]);
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
				// 失敗の内容と「それでも削除するか」は confirmTeardownFailure で既に見せている
				// （ログもそこで残している）。ここまで来たのはユーザーが中止を選んだときだけなので、
				// 同じことをもう一度ダイアログで言わない。
				return;
			}
			if (error instanceof ParadisSwitchToParentFailedError) {
				logService.error('[ParadisRemoveWorktree] switch to parent repository before removal failed', error.reason);
				await dialogService.error(
					teardownRan
						// allow-any-unicode-next-line
						? localize('paradis.workspaceSwitch.removeWorktreeSwitchFailed', "親リポジトリへの切り替えに失敗したため、削除を中止しました。ワークツリーは削除されていません（設定されているセットアップ解除スクリプトは実行済みです）。")
						// allow-any-unicode-next-line
						: localize('paradis.workspaceSwitch.removeWorktreeSwitchFailedNoTeardown', "親リポジトリへの切り替えに失敗したため、削除を中止しました。ワークツリーは削除されていません。"),
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
				await switchService.cancelScopeRetirement(stateKey);
			}
		}
	}
}

registerAction2(ParadisRemoveWorktreeAction);

/**
 * ビューから渡された URI 群に対し、それぞれのリポジトリがあるマシンで `command` を実行する。
 * 結果は URI ではなく `fsPath` をキーに返す（ビュー側が fsPath で引くため）。
 *
 * パス文字列だけを受け取って接続の有無で送り先を決めると、手元と接続先に同じ絶対パスがある構成で
 * 別マシンの値を拾って平然と表示してしまう。どのマシンのものかは URI にしか書かれていない。
 */
async function collectPerWorktree<T>(accessor: ServicesAccessor, resources: UriComponents[], command: string): Promise<Record<string, T>> {
	const resolveGitHost = paradisWorktreeGitHostResolver(accessor);
	const result: Record<string, T> = {};
	await Promise.all(resources.map(async component => {
		const resource = URI.revive(component);
		const host = resolveGitHost(resource);
		try {
			const value = await host.channel.call<T | undefined>(command, [host.path(resource)]);
			if (value !== undefined) {
				result[resource.fsPath] = value;
			}
		} catch {
			// 個々のパスの失敗 (worktree が消えた等) は無視し、他のパスの結果は返す
		}
	}));
	return result;
}

/**
 * 各作業ツリーの未コミット差分 (+/-行数) をまとめて返すコマンド。
 * Workspaces ビュー (browser 層) がポーリングで ID 経由で呼ぶ。git 実行は worktree git
 * チャネルに委譲する (web ビルドでは未登録のため呼び出し側で安全に無効化される)。
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

	async run(accessor: ServicesAccessor, resources?: UriComponents[]): Promise<Record<string, IParadisDiffStat>> {
		if (!Array.isArray(resources) || resources.length === 0) {
			return {};
		}
		return collectPerWorktree<IParadisDiffStat>(accessor, resources, 'getDiffStat');
	}
}

registerAction2(ParadisGetDiffStatsAction);

/**
 * 各作業ツリーの現在ブランチに紐づく GitHub PR の状態をまとめて返すコマンド。
 * Workspaces ビュー (browser 層) がポーリングで ID 経由で呼ぶ。gh CLI の実行は worktree git
 * チャネルに委譲する (web ビルドでは未登録のため呼び出し側で安全に無効化される)。
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

	async run(accessor: ServicesAccessor, resources?: UriComponents[]): Promise<Record<string, IParadisPrStatus>> {
		if (!Array.isArray(resources) || resources.length === 0) {
			return {};
		}
		// git と同じ理由で、そのリポジトリがあるマシンの gh を使う
		return collectPerWorktree<IParadisPrStatus>(accessor, resources, 'getPrStatus');
	}
}

registerAction2(ParadisGetPrStatusesAction);

/** 1つの作業ツリーで検出済みの Issue URL 一覧。ビュー側が更新のたびに組み立てて渡す。 */
interface IParadisGetIssueStatusesRequest {
	readonly resource: UriComponents;
	readonly issueUrls: readonly string[];
}

/**
 * 各作業ツリーで検出済みの GitHub Issue URL をまとめて番号・タイトル・状態へ解決するコマンド。
 * collectPerWorktree と違い worktree ごとに引数 (issueUrls) が異なるため専用に組み立てる。
 * 同じ Issue が複数のスペースから参照されていても、ホスト単位で URL を集合化してから
 * 1回だけ gh へ問い合わせる (worktreeごとに重複してspawnしない)。`resolved`/`attempted` は
 * 全ホストぶんを併合して返す。gh CLI の実行は worktree git チャネルに委譲する
 * (web ビルドでは未登録のため呼び出し側で安全に無効化される)。
 */
class ParadisGetIssueStatusesAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_GET_ISSUE_STATUSES_COMMAND_ID,
			title: localize2('paradis.workspaceSwitch.getIssueStatuses', "Get Worktree Issue Statuses"),
			category: localize2('paradis.category', "Para Code"),
			f1: false
		});
	}

	async run(accessor: ServicesAccessor, requests?: IParadisGetIssueStatusesRequest[]): Promise<IParadisIssueStatusesResult> {
		if (!Array.isArray(requests) || requests.length === 0) {
			return { resolved: {}, attempted: [] };
		}
		const resolveGitHost = paradisWorktreeGitHostResolver(accessor);
		// 同じ Issue が複数のスペースから参照されていても gh 呼び出しは1回で済ませる。
		// --repo を明示するため cwd はどの worktree のものでも構わない設計 (paradisWorktreeGitChannel.ts
		// の getIssueStatuses 参照) なので、ホスト (手元 / 接続先) ごとに URL を集合化してから
		// そのホストにつき1回だけ解決する。手元と接続先を同じ回に混ぜていても、
		// paradisWorktreeGitHostResolver は解決先ごとに同じホストオブジェクトを返すため、
		// Map のキーとしてそのまま使える。
		const byHost = new Map<IParadisWorktreeGitHost, { anchor: URI; issueUrls: Set<string> }>();
		for (const request of requests) {
			if (!Array.isArray(request.issueUrls) || request.issueUrls.length === 0) {
				continue;
			}
			const resource = URI.revive(request.resource);
			const host = resolveGitHost(resource);
			const entry = byHost.get(host);
			if (entry === undefined) {
				byHost.set(host, { anchor: resource, issueUrls: new Set(request.issueUrls) });
			} else {
				for (const url of request.issueUrls) {
					entry.issueUrls.add(url);
				}
			}
		}
		const resolved: Record<string, IParadisIssueStatus> = {};
		const attempted: string[] = [];
		await Promise.all([...byHost.entries()].map(async ([host, entry]) => {
			try {
				const hostResult = await host.channel.call<IParadisIssueStatusesResult>('getIssueStatuses', [host.path(entry.anchor), [...entry.issueUrls]]);
				Object.assign(resolved, hostResult.resolved);
				attempted.push(...hostResult.attempted);
			} catch {
				// そのホストの失敗 (消えた・gh不在等) は無視し、他ホストの結果は返す。
				// attempted に入れない = 呼び出し側 (Workspaces ビュー) は「試行できなかった」として
				// 扱い、無限に即時再試行しない程度には抑えつつ、ホストが復旧したら再試行できる。
			}
		}));
		return { resolved, attempted };
	}
}

registerAction2(ParadisGetIssueStatusesAction);

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
