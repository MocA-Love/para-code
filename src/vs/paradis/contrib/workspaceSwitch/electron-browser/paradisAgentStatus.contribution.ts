/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneStatus, PARADIS_AGENT_BROWSER_CHANNEL, ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { PARADIS_CLAUDE_HOOK_EVENTS, paradisManagedAgentHookCommandWindows, paradisManagedHookDefinition } from '../../agentBrowser/common/paradisAgentHooks.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';

/** 集計時の優先度 (Superset の STATUS_PRIORITY と同方針: 要対応が最強) */
const STATUS_PRIORITY: Record<ParadisAgentStatus, number> = {
	permission: 4,
	question: 3,
	working: 2,
	review: 1,
};

const POLL_INTERVAL = 2000;

/**
 * shared process の /agent-hook 通知 (ペイントークン単位の実行状態) をポーリングし、
 * トークン → ターミナルインスタンス → スコープ (状態キー) に解決して集計、
 * IParadisAgentStatusStore へ書き込む (機能1 Phase C)。
 *
 * - review 状態は「アクティブスコープ かつ ウィンドウが可視+フォーカス中」の場合のみ
 *   即確認遷移 (acknowledge) して表示しない (Superset の「可視なら Stop→idle、不可視なら
 *   review 維持」と同じ挙動)。非フォーカス時に acknowledge すると ParadisNotificationTrigger
 *   の遷移検知 (音+OS通知+Aivis) を先食いして握り潰してしまうため
 * - スコープ内に複数エージェントが居る場合は優先度 permission > working > review で畳み込む
 */
class ParadisAgentStatusPoller extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentStatusPoller';

	/**
	 * このポーラーが statusStore へ最後に書き込んだ内容が空だったか。setScopeStatuses は
	 * 「ポーラー専用」なので、この局所フラグが store の空/非空をそのまま反映する。
	 * トークン0のときの「一度だけ空へ収束させてから IPC を休止する」判定に使う。
	 */
	private _lastWroteEmpty = true;

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisAgentStatusStore private readonly statusStore: IParadisAgentStatusStore,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();

		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this.poll(), POLL_INTERVAL);

		// 切り替え直後は即ポーリング (アクティブスコープの review を素早く確認遷移させる)
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.poll()));

		this.poll();
	}

	/** このウィンドウのターミナルペインにトークンが1本でも割り当てられているか（renderer内で同期判定）。 */
	private hasAnyPaneToken(): boolean {
		for (const instance of this.terminalService.instances) {
			if (this.paneTokenService.getTokenForInstance(instance.instanceId) !== undefined) {
				return true;
			}
		}
		return false;
	}

	private async poll(): Promise<void> {
		// トークンが1本も無ければ listPaneStatuses は突合対象が無く結果は必ず全て捨てられる。
		// 直前に書いた状態が残っていることがあるので、store が非空なら一度だけ空へ収束させ、
		// 以降（トークン0のまま）は IPC をスキップする。トークンが1本でも生えれば次の tick で
		// hasAnyPaneToken が true になり即座にポーリングを再開する（IntervalTimer は止めない）。
		if (!this.hasAnyPaneToken()) {
			if (!this._lastWroteEmpty) {
				this.statusStore.setScopeStatuses(new Map());
				this._lastWroteEmpty = true;
			}
			return;
		}

		let statuses: IParadisAgentPaneStatus[];
		try {
			const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
			statuses = await channel.call<IParadisAgentPaneStatus[]>('listPaneStatuses');
		} catch (error) {
			this.logService.trace('[ParadisAgentStatus] poll failed', String(error));
			return; // shared process 未起動 (起動直後の20〜30秒) は静かにスキップ
		}

		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		const scopeStatuses = new Map<string, ParadisAgentStatus>();

		for (const paneStatus of statuses) {
			const instanceId = this.paneTokenService.getInstanceForToken(paneStatus.token);
			if (instanceId === undefined) {
				continue; // ペインが存在しない (別ウィンドウ or 終了済み)
			}

			const stateKey = this.terminalScopeService.getStateKeyForInstance(instanceId);
			if (stateKey === undefined) {
				continue; // スコープ外のターミナル
			}

			if (paneStatus.status === 'review' && stateKey === activeStateKey && !document.hidden && this.hostService.hasFocus) {
				// 見えているスコープの完了は、ウィンドウが可視かつフォーカス中の場合のみ確認済み扱い
				// (fire-and-forget)。非フォーカス時は review を維持し、ParadisNotificationTrigger
				// の完了通知に先食いされないようにする
				this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
					.call('acknowledgePaneStatus', [paneStatus.token])
					.then(undefined, () => { /* ignore */ });
				continue;
			}

			const previous = scopeStatuses.get(stateKey);
			if (!previous || STATUS_PRIORITY[paneStatus.status] > STATUS_PRIORITY[previous]) {
				scopeStatuses.set(stateKey, paneStatus.status);
			}
		}

		this.statusStore.setScopeStatuses(scopeStatuses);
		this._lastWroteEmpty = scopeStatuses.size === 0;
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
		// 自動設置が使えない環境向けの手動フォールバック。イベント一覧・コマンドは自動設置と
		// 完全に同一 (POSIXは ~/.para-code/hooks/notify.sh 参照、Windowsは notify.ps1 の
		// powershell 直接起動。PreToolUse は誤通知源になるため登録しない)。
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
