/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneStatus, PARADIS_AGENT_BROWSER_CHANNEL, PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_PANE_TOKEN_ENV_VAR, ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';

/** 集計時の優先度 (Superset の STATUS_PRIORITY と同じ: permission 最強) */
const STATUS_PRIORITY: Record<ParadisAgentStatus, number> = {
	permission: 3,
	working: 2,
	review: 1,
};

const POLL_INTERVAL = 2000;

/**
 * shared process の /agent-hook 通知 (ペイントークン単位の実行状態) をポーリングし、
 * トークン → ターミナルインスタンス → スコープ (状態キー) に解決して集計、
 * IParadisAgentStatusStore へ書き込む (機能1 Phase C)。
 *
 * - review 状態はアクティブスコープなら即確認遷移 (acknowledge) して表示しない
 *   (Superset の「可視なら Stop→idle、不可視なら review」と同じ挙動)
 * - スコープ内に複数エージェントが居る場合は優先度 permission > working > review で畳み込む
 */
class ParadisAgentStatusPoller extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentStatusPoller';

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisAgentStatusStore private readonly statusStore: IParadisAgentStatusStore,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this.poll(), POLL_INTERVAL);

		// 切り替え直後は即ポーリング (アクティブスコープの review を素早く確認遷移させる)
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.poll()));

		this.poll();
	}

	private async poll(): Promise<void> {
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

			if (paneStatus.status === 'review' && stateKey === activeStateKey) {
				// 見えているスコープの完了は確認済み扱い (fire-and-forget)
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
	}
}

registerWorkbenchContribution2(ParadisAgentStatusPoller.ID, ParadisAgentStatusPoller, WorkbenchPhase.AfterRestored);

// --- hooks セットアップスニペット ----------------------------------------------------------------

/** 指定イベント名を /agent-hook へ通知する hook コマンド (sh 1行) を生成する */
function hookCommand(eventName: string): string {
	// シェル側で展開させる変数参照 (${VAR:-}) を組み立てる
	const portFileRef = '${' + PARADIS_MCP_PORT_FILE_ENV_VAR + ':-}';
	const tokenRef = '${' + PARADIS_PANE_TOKEN_ENV_VAR + ':-}';
	// ポートファイル ({"port":12345,"pid":...}) から port を抜き出して curl で通知。
	// 失敗してもエージェント本体を止めない (|| true)
	const sedScript = 's/.*"port":([0-9]+).*/\\1/p';
	return `sh -c 'f="${portFileRef}"; t="${tokenRef}"; [ -n "$f" ] && [ -n "$t" ] || exit 0; p=$(sed -nE ${JSON.stringify(sedScript)} "$f" 2>/dev/null); [ -n "$p" ] && curl -fsS --max-time 2 "http://127.0.0.1:$p/agent-hook?pane=$t&event=${eventName}" >/dev/null 2>&1 || true'`;
}

class ParadisCopyAgentHooksSetupAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.copyAgentHooksSetup',
			title: localize2('paradis.workspaceSwitch.copyAgentHooksSetup', "Copy Agent Hooks Setup (Claude Code)"),
			category: localize2('paradis.category', "Paradis"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);

		// ~/.claude/settings.json の "hooks" にマージするスニペット。
		// イベント種別ごとに固定の event クエリで /agent-hook を叩く (stdin パース不要)
		const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
		const hooks: Record<string, unknown> = {};
		for (const event of events) {
			hooks[event] = [{ hooks: [{ type: 'command', command: hookCommand(event) }] }];
		}

		await clipboardService.writeText(JSON.stringify({ hooks }, undefined, 2));
		notificationService.info(localize('paradis.workspaceSwitch.hooksCopied', "Copied. Merge the snippet into ~/.claude/settings.json (\"hooks\" section) to enable agent status indicators in the Workspaces view."));
	}
}

registerAction2(ParadisCopyAgentHooksSetupAction);
