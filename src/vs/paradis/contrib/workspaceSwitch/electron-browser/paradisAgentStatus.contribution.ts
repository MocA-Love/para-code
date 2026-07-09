/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { sep } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneStatus, PARADIS_AGENT_BROWSER_CHANNEL, ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { PARADIS_CLAUDE_HOOK_EVENTS, paradisManagedAgentHookCommandWindows, paradisManagedHookDefinition } from '../../agentBrowser/common/paradisAgentHooks.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';

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

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisAgentStatusStore private readonly statusStore: IParadisAgentStatusStore,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this.poll(), POLL_INTERVAL);

		// 切り替え直後は即ポーリング (アクティブスコープの review を素早く確認遷移させる)
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.poll()));

		this.poll();
	}

	/**
	 * hookが報告したcwdからスコープ (stateKey) を引くフォールバック。登録リポジトリと
	 * その worktree のルートに対する最長一致で決める。トークンがこのウィンドウのどの
	 * インスタンスにも解決できないケース (ウィンドウリロード後、park中のエディタターミナルが
	 * まだ実体化していない等) でも、エージェントの実行状態を正しいスコープへ表示するために使う。
	 */
	private resolveStateKeyByCwd(cwd: string | undefined): string | undefined {
		if (cwd === undefined || cwd.length === 0) {
			return undefined;
		}
		let best: { root: string; stateKey: string } | undefined;
		const consider = (uri: URI, stateKey: string) => {
			if (uri.scheme !== 'file') {
				return;
			}
			const root = uri.fsPath;
			if ((cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep)) && (best === undefined || root.length > best.root.length)) {
				best = { root, stateKey };
			}
		};
		for (const repository of this.workspaceSwitchService.repositories) {
			consider(repository.uri, repository.id);
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				consider(worktree.uri, paradisWorktreeStateKey(worktree.uri));
			}
		}
		return best?.stateKey;
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
			// 第一解決: トークン → このウィンドウのターミナルインスタンス → 所属スコープ
			const instanceId = this.paneTokenService.getInstanceForToken(paneStatus.token);
			const resolvedViaInstance = instanceId !== undefined;
			let stateKey = instanceId !== undefined ? this.terminalScopeService.getStateKeyForInstance(instanceId) : undefined;
			// 第二解決: hookが報告したcwd → リポジトリ/worktreeルートの最長一致。
			// インスタンス未解決 (リロード後の未復元park等) でも「そのリポジトリでエージェントが
			// 動いている」事実は変わらないため、スコープ表示としてはこれで正しい。
			if (stateKey === undefined) {
				stateKey = this.resolveStateKeyByCwd(paneStatus.cwd);
			}
			if (stateKey === undefined) {
				continue; // どの解決経路でもスコープ不明 (登録外フォルダ等)
			}

			if (paneStatus.status === 'review' && stateKey === activeStateKey && resolvedViaInstance && !document.hidden && this.hostService.hasFocus) {
				// 見えているスコープの完了は、ウィンドウが可視かつフォーカス中の場合のみ確認済み扱い
				// (fire-and-forget)。非フォーカス時は review を維持し、ParadisNotificationTrigger
				// の完了通知に先食いされないようにする。cwdフォールバックで解決したペインは
				// 「このウィンドウで見えている」保証が無いため確認遷移させない (別ウィンドウの
				// ペインを勝手に既読へ落とさない)。
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
