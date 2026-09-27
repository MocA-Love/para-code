/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペースごとのシェル履歴。
//
// ターミナルを作る直前に、そのターミナルが属するスペースの履歴フォルダを環境変数で渡す。
// HISTFILE を直接渡さないのは、ユーザーの ~/.zshrc が後から上書きするため（切り替えはシェル統合
// スクリプトが rc の後で行う。`shellIntegration-rc.zsh` / `-bash.sh` / `.fish` の PARA-PATCH）。
// スペースを削除したら、そのスペースの履歴も消す。下部パネルの共通ターミナルは通常の履歴のまま。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isWindows, OperatingSystem } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { paradisGetTerminalCreationScopeLease } from '../../../../workbench/contrib/terminal/browser/paradisTerminalCreationScope.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisIsSharedPanelShell, paradisSharedPanelEnabledAtStartup } from '../../terminalSharedPanel/common/paradisTerminalSharedPanel.js';
import { paradisRegisterTerminalLaunchPreparer } from '../../workspaceSwitch/common/paradisTerminalLaunchPreparers.js';
import { IParadisTerminalScopeRoot, paradisResolveInitialCwdScope } from '../../workspaceSwitch/common/paradisTerminalProcessScope.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisScopeRootPath, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisSpaceHistoryInstance, PARADIS_SPACE_HISTORY_DIR_ENV, PARADIS_SPACE_HISTORY_FOLDER, PARADIS_SPACE_HISTORY_ID_ENV, PARADIS_TERMINAL_SPACE_HISTORY_ENABLED, paradisFishHistoryFileName, paradisParseCreatedHistoryIds, paradisRegisterSpaceHistoryFileResolver, paradisSpaceHistoryDirectory, paradisSpaceHistoryId } from '../common/paradisTerminalSpaceHistory.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis.terminal',
	order: 100,
	type: 'object',
	title: localize('paradis.terminal.title', "Para Code Terminal"),
	properties: {
		[PARADIS_TERMINAL_SPACE_HISTORY_ENABLED]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('paradis.terminal.historyPerSpace.enabled', "ターミナルで ↑ キーを押したときに出るシェルの履歴を、スペースごとに分けます。新しいスペースでは履歴が空から始まり、スペースを削除するとその履歴も消えます（消せなかった分は次に起動したときに片付けます）。下部パネルの共通ターミナルは通常の履歴のままです。\n\nzsh・bash・fish で、シェル統合が有効なときに効きます。fish の履歴は fish のデータフォルダ（通常は `~/.local/share/fish`）に置かれ、`XDG_DATA_HOME` を変えている場合はスペースを削除しても消えません。Windows に SSH で接続しているウィンドウでは使いません。変更は新しく開いたターミナルから反映されます。"),
		},
	},
});

/** 「このスペース専用の履歴になりました」を1度だけ出したかどうか。 */
const NOTICE_SHOWN_STORAGE_KEY = 'paradis.terminal.historyPerSpace.noticeShown';

/**
 * 削除の2回目までの待ち時間。スペースの削除ではそのスペースのターミナルも同時に閉じられ、
 * シェルが終了時に履歴を書き戻して、消したばかりのファイルを作り直すことがある。
 */
const SECOND_DELETE_DELAY_MS = 10_000;

/**
 * このワークスペースで作った履歴フォルダ（historyId → stateKey）。起動時にどのスペースにも
 * 対応しなくなったものを消すために使う。userData は全ワークスペースで共有しているので、
 * 自分が作ったもの以外（他のワークスペースのスペースの履歴）には手を出さない。
 */
const CREATED_HISTORY_IDS_STORAGE_KEY = 'paradis.terminal.historyPerSpace.createdIds';
const CREATED_HISTORY_IDS_MAX = 1_000;

class ParadisTerminalSpaceHistoryContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalSpaceHistory';

	private readonly _sharedPanel: boolean;
	private readonly _pendingDeletes = this._register(new DisposableMap<string, RunOnceScheduler>());
	/** 接続先の OS。解決するまで（と接続先が無いとき）は undefined。 */
	private _remoteOs: OperatingSystem | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IPathService private readonly pathService: IPathService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		// 共通ターミナルかどうかの判定は、所属の判定側と同じく起動時の値で揃える。
		this._sharedPanel = paradisSharedPanelEnabledAtStartup(this.configurationService);
		if (this.environmentService.remoteAuthority !== undefined) {
			this.remoteAgentService.getEnvironment().then(environment => { this._remoteOs = environment?.os; }, () => { /* 分からなければ使わない */ });
		}
		this._register(paradisRegisterTerminalLaunchPreparer((shellLaunchConfig, target) => this.prepare(shellLaunchConfig, target)));
		this._register(paradisRegisterSpaceHistoryFileResolver((instance, shell) => this.resolveHistoryFile(instance, shell)));
		this._register(this.workspaceSwitchService.onDidRetireScope(stateKey => this.deleteHistory(stateKey)));
		// スペースの削除を受け損ねた（別のウィンドウで消した、接続先を切断中に消した）履歴を片付ける。
		// スペースの一覧が確定してから（worktree の列挙が終わってから）でないと、生きているスペースの
		// 履歴を消してしまう。
		this.worktreeService.initializationBarrier.then(() => {
			if (!this._store.isDisposed) {
				this.cleanupOrphanedHistory();
			}
		}, error => this.logService.trace('[paradisTerminalSpaceHistory] skipped the orphan cleanup', error));
	}

	private prepare(shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation): void {
		// 復元したシェルは起動済みで、環境変数を変えても届かない。
		if (shellLaunchConfig.attachPersistentProcess !== undefined || shellLaunchConfig.customPtyImplementation !== undefined) {
			return;
		}
		const directory = this.resolveHistoryDirectory(shellLaunchConfig, target);
		if (directory !== undefined) {
			// 同じスペース（同じ worktree のパス）をすぐ作り直した場合、直前の削除の2回目が新しい
			// 履歴を消さないようにする。
			this._pendingDeletes.deleteAndDispose(directory.stateKey);
			this.recordCreatedHistoryId(directory.historyId, directory.stateKey);
		}
		shellLaunchConfig.env = {
			...shellLaunchConfig.env,
			// 使わないターミナルでは明示的に消す（null は upstream の「この変数を消す」）。親の
			// 環境（このアプリを別のターミナルから起動した場合など）から紛れ込んだ値で、別の
			// スペースの履歴を読まないようにするため。
			[PARADIS_SPACE_HISTORY_DIR_ENV]: directory?.path ?? null,
			[PARADIS_SPACE_HISTORY_ID_ENV]: directory?.historyId ?? null,
		};
		if (directory !== undefined) {
			this.showNoticeOnce();
		}
	}

	private resolveHistoryDirectory(shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation): { readonly path: string; readonly historyId: string; readonly stateKey: string } | undefined {
		if (!this.isEnabled()
			|| (this._sharedPanel && target === TerminalLocation.Panel && paradisIsSharedPanelShell(shellLaunchConfig))
			|| shellLaunchConfig.type === 'Task') {
			return undefined;
		}
		const stateKey = this.resolveStateKey(shellLaunchConfig);
		return stateKey === undefined ? undefined : this.historyDirectoryFor(stateKey);
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue(PARADIS_TERMINAL_SPACE_HISTORY_ENABLED) !== false
			&& this.workspaceSwitchService.isManagedWorkspaceWindow;
	}

	private historyDirectoryFor(stateKey: string): { readonly path: string; readonly historyId: string; readonly stateKey: string } | undefined {
		const base = this.historyBase();
		if (base === undefined) {
			return undefined;
		}
		const historyId = paradisSpaceHistoryId(stateKey);
		return { path: paradisSpaceHistoryDirectory(base, historyId), historyId, stateKey };
	}

	/**
	 * 補完候補（↓ のサジェスト）が読む、そのターミナルのスペースの履歴ファイル。
	 * 起動時に渡したフォルダがあればそれ。復元したエディタのターミナル（起動設定に環境変数が
	 * 残っていない）は、今のスペースのもの（エディタのターミナルはスペースごとに入れ替わるので、
	 * 入力中のターミナルは今のスペースに居る）。
	 */
	private resolveHistoryFile(instance: IParadisSpaceHistoryInstance, shell: 'zsh' | 'bash'): string | undefined {
		if (!this.isEnabled()) {
			return undefined;
		}
		const fromEnv = instance.shellLaunchConfig.env?.[PARADIS_SPACE_HISTORY_DIR_ENV];
		let directory = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
		if (directory === undefined && instance.shellLaunchConfig.attachPersistentProcess !== undefined && instance.target === TerminalLocation.Editor) {
			const stateKey = this.workspaceSwitchService.activeStateKey;
			directory = stateKey === undefined ? undefined : this.historyDirectoryFor(stateKey)?.path;
		}
		return directory === undefined ? undefined : `${directory}/${shell}_history`;
	}

	/**
	 * ターミナルが属するスペース。
	 *
	 * 開始フォルダがどれかのスペースの中ならそれを採る（モバイルや再開の操作は、今表示していない
	 * スペースのフォルダを指定してターミナルを作り、後から所属を付け替えるため）。フォルダの指定が
	 * 無ければ、作られた場所（補助ウィンドウならそのウィンドウのスペース）、最後に今のスペース。
	 */
	private resolveStateKey(shellLaunchConfig: IShellLaunchConfig): string | undefined {
		const connectedAuthority = this.remoteAgentService.getConnection()?.remoteAuthority;
		const cwd = shellLaunchConfig.cwd;
		const cwdPath = URI.isUri(cwd) ? paradisScopeRootPath(cwd, connectedAuthority) : cwd;
		if (cwdPath !== undefined && cwdPath.length > 0) {
			const roots: IParadisTerminalScopeRoot[] = [];
			for (const repository of this.workspaceSwitchService.repositories) {
				const repositoryRoot = paradisScopeRootPath(repository.uri, connectedAuthority);
				if (repositoryRoot !== undefined) {
					roots.push({ root: repositoryRoot, stateKey: repository.id });
				}
				for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
					const worktreeRoot = worktree.missing ? undefined : paradisScopeRootPath(worktree.uri, connectedAuthority);
					if (worktreeRoot !== undefined) {
						roots.push({ root: worktreeRoot, stateKey: paradisWorktreeStateKey(worktree.uri) });
					}
				}
			}
			const fromCwd = paradisResolveInitialCwdScope(cwdPath, roots);
			if (fromCwd !== undefined) {
				return fromCwd;
			}
		}
		return paradisGetTerminalCreationScopeLease(shellLaunchConfig) ?? this.workspaceSwitchService.activeStateKey;
	}

	/**
	 * 履歴フォルダの親。ローカルは userData の下、SSH の接続先は接続先の `~/.para-code` の下
	 * （シェルは接続先で動くので、接続先のパスでなければ書けない）。
	 */
	private historyBase(): string | undefined {
		if (this.environmentService.remoteAuthority !== undefined) {
			// 接続先が Windows だとパスが `/C:/Users/...` の形になり、シェルへそのまま渡せない。
			// 接続先の OS が分かるまでと、Windows のときは使わない。
			const remoteHome = this.pathService.resolvedUserHome;
			if (this._remoteOs === undefined || this._remoteOs === OperatingSystem.Windows
				|| remoteHome === undefined || remoteHome.scheme !== Schemas.vscodeRemote) {
				return undefined;
			}
			return `${remoteHome.path.replace(/\/+$/, '')}/.para-code/${PARADIS_SPACE_HISTORY_FOLDER}`;
		}
		// INativeWorkbenchEnvironmentService（electron-browser）を型 import すると layer 違反になるため、
		// デスクトップでのみ存在する userDataPath をプロパティの有無で判定する（paradisPaneTokenService.ts と同じ）。
		const userDataPath = (this.environmentService as IWorkbenchEnvironmentService & { readonly userDataPath?: string }).userDataPath;
		if (typeof userDataPath !== 'string' || userDataPath.length === 0) {
			return undefined;
		}
		// Windows でも区切りは `/` にする（Git Bash などへ渡すため。`C:/Users/...` の形は通る）。
		const base = isWindows ? userDataPath.replace(/\\/g, '/') : userDataPath;
		return `${base.replace(/\/+$/, '')}/${PARADIS_SPACE_HISTORY_FOLDER}`;
	}

	private historyBaseUri(): URI | undefined {
		const base = this.historyBase();
		if (base === undefined) {
			return undefined;
		}
		if (this.environmentService.remoteAuthority !== undefined) {
			return URI.from({ scheme: Schemas.vscodeRemote, authority: this.environmentService.remoteAuthority, path: base });
		}
		return URI.file(base);
	}

	/** スペースを削除したら、そのスペースの履歴も消す。 */
	private deleteHistory(stateKey: string): void {
		const historyId = paradisSpaceHistoryId(stateKey);
		this.forgetCreatedHistoryId(historyId);
		this.deleteHistoryFiles(stateKey, historyId, true);
	}

	private deleteHistoryFiles(pendingKey: string, historyId: string, retryLater: boolean): void {
		const targets: URI[] = [];
		const base = this.historyBaseUri();
		if (base !== undefined) {
			targets.push(joinPath(base, historyId));
		}
		// fish は履歴の置き場所を変えられず、fish のデータフォルダに書く。XDG_DATA_HOME を変えている
		// 環境は拾えない（renderer からはシェルの環境が見えない）。
		const home = this.pathService.resolvedUserHome;
		if (home !== undefined) {
			targets.push(joinPath(home, '.local', 'share', 'fish', paradisFishHistoryFileName(historyId)));
		}
		if (targets.length === 0) {
			return;
		}
		const run = () => {
			for (const target of targets) {
				this.fileService.del(target, { recursive: true, useTrash: false }).catch(() => {
					// 無い（そもそも履歴を作っていない）のが普通なので、失敗は記録だけにする。
					this.logService.trace(`[paradisTerminalSpaceHistory] nothing to delete at ${target.toString()}`);
				});
			}
		};
		run();
		if (!retryLater) {
			return;
		}
		// スペースの削除と同時に閉じられたシェルが、終了時の書き戻しでファイルを作り直すことがある。
		// 少し待ってもう1度消す。
		const scheduler = new RunOnceScheduler(() => {
			run();
			this._pendingDeletes.deleteAndDispose(pendingKey);
		}, SECOND_DELETE_DELAY_MS);
		this._pendingDeletes.set(pendingKey, scheduler);
		scheduler.schedule();
	}

	private readCreatedHistoryIds(): Map<string, string> {
		return paradisParseCreatedHistoryIds(this.storageService.get(CREATED_HISTORY_IDS_STORAGE_KEY, StorageScope.WORKSPACE));
	}

	private writeCreatedHistoryIds(ids: ReadonlyMap<string, string>): void {
		const entries = [...ids].slice(-CREATED_HISTORY_IDS_MAX);
		this.storageService.store(CREATED_HISTORY_IDS_STORAGE_KEY, JSON.stringify(entries), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private recordCreatedHistoryId(historyId: string, stateKey: string): void {
		const ids = this.readCreatedHistoryIds();
		if (ids.get(historyId) === stateKey) {
			return;
		}
		ids.set(historyId, stateKey);
		this.writeCreatedHistoryIds(ids);
	}

	private forgetCreatedHistoryId(historyId: string): void {
		const ids = this.readCreatedHistoryIds();
		if (ids.delete(historyId)) {
			this.writeCreatedHistoryIds(ids);
		}
	}

	/** このワークスペースで作った履歴のうち、もうどのスペースにも対応しないものを消す。 */
	private cleanupOrphanedHistory(): void {
		const known = new Set<string>();
		for (const repository of this.workspaceSwitchService.repositories) {
			known.add(repository.id);
			// 実体が消えた worktree も一覧に残っている間は消さない（戻ってくることがある）。
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				known.add(paradisWorktreeStateKey(worktree.uri));
			}
		}
		const ids = this.readCreatedHistoryIds();
		let changed = false;
		for (const [historyId, stateKey] of ids) {
			if (known.has(stateKey)) {
				continue;
			}
			this.deleteHistoryFiles(`orphan:${historyId}`, historyId, false);
			ids.delete(historyId);
			changed = true;
		}
		if (changed) {
			this.writeCreatedHistoryIds(ids);
		}
	}

	/** 初めてスペース専用の履歴で開いたときに、1度だけ知らせる。 */
	private showNoticeOnce(): void {
		if (this.storageService.getBoolean(NOTICE_SHOWN_STORAGE_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		this.storageService.store(NOTICE_SHOWN_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		this.notificationService.prompt(
			Severity.Info,
			localize('paradis.terminal.historyPerSpace.notice', "ターミナルの履歴（↑ キー）はスペースごとに分かれるようになりました。新しいスペースでは空から始まります。"),
			[{
				label: localize('paradis.terminal.historyPerSpace.openSetting', "設定を開く"),
				run: () => this.commandService.executeCommand('workbench.action.openSettings', `@id:${PARADIS_TERMINAL_SPACE_HISTORY_ENABLED}`),
			}],
		);
	}
}

registerWorkbenchContribution2(ParadisTerminalSpaceHistoryContribution.ID, ParadisTerminalSpaceHistoryContribution, WorkbenchPhase.BlockRestore);
