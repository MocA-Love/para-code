/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, DisposableMap, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILifecycleService, ShutdownReason } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { PARADIS_CLAUDE_HOOK_EVENTS, paradisManagedAgentHookCommandWindows, paradisManagedHookDefinition } from '../../agentBrowser/common/paradisAgentHooks.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../common/paradisWorkspaceSwitch.js';
import { paradisIsWorkbenchWindowFocused } from '../browser/paradisWindowFocus.js';
import { ParadisAgentStatusSnapshotConsumer } from './paradisAgentStatusSnapshotConsumer.js';

/**
 * shared process の /agent-hook 通知 (ペイントークン単位の実行状態) をポーリングし、
 * トークン → ターミナルインスタンス → スコープ (状態キー) に解決して集計、
 * IParadisAgentStatusStore へ書き込む (機能1 Phase C)。
 *
 * - review 状態は「アクティブスコープ かつ ウィンドウが可視+フォーカス中」の場合のみ
 *   即確認遷移 (acknowledge) して表示しない (Superset の「可視なら Stop→idle、不可視なら
 *   review 維持」と同じ挙動)。非フォーカス時に acknowledge すると ParadisNotificationTrigger
 *   の遷移検知 (音+OS通知+Aivis) を先食いして握り潰してしまうため
 * - スコープ内に複数エージェントが居る場合も畳み込まず、内訳をそのまま書き込む。
 *   代表値 (行の左アイコン) はストア側が優先度 permission > question > working > review で導く。
 *   畳み込んだ値だけを持つと「1体終わっても他が動いている限り完了が表示から消える」ため
 */
export class ParadisAgentStatusPoller extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentStatusPoller';

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisAgentStatusStore private readonly statusStore: IParadisAgentStatusStore,
		@ILogService private readonly logService: ILogService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
	) {
		super();

		// シェルプロセスの終了 (instance.onExit) を shared process へ通知する。エージェントCLIは
		// クラッシュ・端末の強制クローズでは Stop/SessionEnd hook を発火できず、実行状態と
		// モバイルの「考え中」表示が永久に残るため、プロセス消滅を唯一確実な解除点として使う。
		// ウィンドウリロードでは onExit は発火しない (永続ターミナルはプロセスが生き続ける) ので、
		// 動作中のエージェントを誤って解除することはない。
		for (const instance of this.terminalService.instances) {
			this.watchInstanceExit(instance);
		}
		this._register(terminalInstanceService.onDidCreateInstance(instance => this.watchInstanceExit(instance)));
		this._register(lifecycleService.onWillShutdown(event => this.preserveTerminalsForReload = event.reason === ShutdownReason.RELOAD));

		this.statusSnapshotConsumer = this._register(new ParadisAgentStatusSnapshotConsumer({
			snapshotService,
			paneTokenService: this.paneTokenService,
			terminalScopeService: this.terminalScopeService,
			workspaceSwitchService: this.workspaceSwitchService,
			worktreeService: this.worktreeService,
			remoteAgentService: this.remoteAgentService,
			statusStore: this.statusStore,
			acknowledgePaneStatus: token => {
				this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
					.call('acknowledgePaneStatus', [token])
					.then(undefined, () => { /* ignore */ });
			},
			logPollFailure: error => this.logService.trace('[ParadisAgentStatus] poll failed', String(error)),
			isWindowFocused: paradisIsWorkbenchWindowFocused,
		}));
	}

	private readonly exitListeners = this._register(new DisposableMap<number, IDisposable>());
	private readonly statusSnapshotConsumer: ParadisAgentStatusSnapshotConsumer;
	private preserveTerminalsForReload = false;

	private watchInstanceExit(instance: ITerminalInstance): void {
		if (this.exitListeners.has(instance.instanceId)) {
			return;
		}
		const listeners = new DisposableStore();
		let token = this.paneTokenService.getTokenForInstance(instance.instanceId);
		let notified = false;
		const notify = () => {
			if (notified || token === undefined) {
				return;
			}
			notified = true;
			this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
				.call('notifyTerminalExit', [token])
				.then(() => this.statusSnapshotConsumer.requestRefresh(), () => { /* shared process 未起動時は次のポーリングで整合する */ });
			this.exitListeners.deleteAndDispose(instance.instanceId);
		};
		// token serviceとpollerのcreate listener順に依存しないよう、未解決なら割当変更時に補完する。
		listeners.add(this.paneTokenService.onDidChange(() => token ??= this.paneTokenService.getTokenForInstance(instance.instanceId)));
		listeners.add(instance.onExit(notify));
		listeners.add(instance.onDisposed(() => {
			if (!this.preserveTerminalsForReload) {
				notify();
			}
		}));
		this.exitListeners.set(instance.instanceId, listeners);
	}
}

registerWorkbenchContribution2(ParadisAgentStatusPoller.ID, ParadisAgentStatusPoller, WorkbenchPhase.AfterRestored);

// --- hooks セットアップスニペット ----------------------------------------------------------------

class ParadisCopyAgentHooksSetupAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.copyAgentHooksSetup',
			title: localize2('paradis.workspaceSwitch.copyAgentHooksSetup', "Copy Agent Hooks Setup (Claude Code)"),
			category: localize2('paradis.category', "Para Code"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		const pathService = accessor.get(IPathService);

		// ~/.claude/settings.json の "hooks" にマージするスニペット。通常は shared process 起動時に
		// 自動マージされる (agentBrowser/node/paradisAgentHooksSetup.ts) ため、このアクションは
		// 自動設置が使えない環境向けの手動フォールバック。POSIXは
		// ~/.para-code/hooks/notify.sh、Windowsは notify.ps1 を参照する。CLIバージョンを
		// 判定できない手動スニペットには、旧版が拒否し得るMessageDisplayを含めない。
		let command: string | undefined;
		if (isWindows) {
			const userHome = await pathService.userHome();
			command = paradisManagedAgentHookCommandWindows(userHome.fsPath);
		}
		const hooks: Record<string, unknown> = {};
		for (const event of PARADIS_CLAUDE_HOOK_EVENTS) {
			hooks[event.eventName] = [paradisManagedHookDefinition(event, command)];
		}

		await clipboardService.writeText(JSON.stringify({ hooks }, undefined, 2));
		notificationService.info(localize('paradis.workspaceSwitch.hooksCopied', "Copied. Merge the snippet into ~/.claude/settings.json (\"hooks\" section) to enable agent status indicators in the Workspaces view."));
	}
}

registerAction2(ParadisCopyAgentHooksSetupAction);
