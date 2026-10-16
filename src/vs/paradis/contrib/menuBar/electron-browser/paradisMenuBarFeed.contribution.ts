/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// メニューバーのアイコン（main が持つ）へ、このウィンドウから中身を送る係。
//
// - 通知の台帳から読んだ要対応の一覧（全ウィンドウ共通。台帳の番号で main が新しい方を使う）
// - このウィンドウのペインのうち作業中の数（main がウィンドウごとに足す）
// - このウィンドウが取った使用量と今日のコスト（手元のウィンドウは手元、SSH のウィンドウは接続先の値）
//
// 使用量は使用量パネルと同じクライアントで取る。取得は shared process（SSH なら接続先）が間隔と
// キャッシュを持つので、ここから聞いても API を呼ぶ回数は増えない。アイコンを出していない間・横にも
// メニューにも使用量を出さない間は何も送らず、取りにも行かない。

import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { ParadisCcusageClient } from '../../ccusage/electron-browser/paradisCcusageClient.js';
import { paradisSelectedCodexHome } from '../../codexAccounts/common/paradisCodexAccounts.js';
import { ParadisCodexAccountsClient } from '../../codexAccounts/electron-browser/paradisCodexAccountsClient.js';
import { PARADIS_LIMITS_OPEN_PANEL_COMMAND_ID, ParadisLimitsMonitorClient } from '../../limitsMonitor/electron-browser/paradisLimitsMonitorClient.js';
import { IParadisNotificationInboxService } from '../../notificationInbox/common/paradisNotificationInbox.js';
import { PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID } from '../../paradisSettings/electron-browser/paradisSettingsDialog.contribution.js';
import { PARADIS_USAGE_DASHBOARD_COMMAND_ID } from '../../usageDashboard/electron-browser/paradisUsageDashboard.contribution.js';
import {
	IParadisMenuBarCost,
	IParadisMenuBarReport,
	IParadisMenuBarUsageSource,
	PARADIS_MENU_BAR_CHANNEL,
	PARADIS_MENU_BAR_ICON_SETTING,
	PARADIS_MENU_BAR_SETTINGS_SECTION_ID,
	ParadisMenuBarRequest,
	paradisMenuBarInboxFromSnapshot,
	paradisMenuBarNeedsUsage,
	paradisReadMenuBarSettings,
} from '../common/paradisMenuBar.js';
import { paradisMenuBarAccountsFromLimits } from '../common/paradisMenuBarUsage.js';

/** 中身の変化をまとめて送る間隔。 */
const SEND_DELAY = 300;
/** 使用量を聞き直す間隔（取得そのものの間隔は shared process・接続先が決める）。 */
const USAGE_INTERVAL = 150_000;
/** 今日のコストを聞き直す間隔（ステータスバーと同じ。ccusage は会話ログを全部読むので控えめに）。 */
const COST_INTERVAL = 10 * 60_000;
/** 失敗が続いたときに伸ばす上限（10 分 → 20 分 → 40 分 → 80 分）。 */
const COST_MAX_BACKOFF_STEPS = 3;

class ParadisMenuBarFeed extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisMenuBarFeed';

	private readonly channel: IChannel;
	private readonly limitsClient: ParadisLimitsMonitorClient;
	private readonly codexClient: ParadisCodexAccountsClient;
	private readonly ccusageClient: ParadisCcusageClient;
	private readonly sendScheduler = this._register(new RunOnceScheduler(() => this.send(), SEND_DELAY));
	private readonly usageTimer = this._register(new MutableDisposable<IntervalTimer>());
	private readonly costTimer = this._register(new MutableDisposable<RunOnceScheduler>());

	private working = 0;
	private usage: IParadisMenuBarUsageSource | undefined;
	private cost: IParadisMenuBarCost | undefined;
	private fetchingUsage = false;
	private fetchingCost = false;
	private costFailures = 0;
	private lastSignature = '';

	constructor(
		@IParadisNotificationInboxService private readonly inboxService: IParadisNotificationInboxService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ILabelService private readonly labelService: ILabelService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = mainProcessService.getChannel(PARADIS_MENU_BAR_CHANNEL);
		this.limitsClient = instantiationService.createInstance(ParadisLimitsMonitorClient);
		this.codexClient = instantiationService.createInstance(ParadisCodexAccountsClient);
		this.ccusageClient = instantiationService.createInstance(ParadisCcusageClient);

		this._register(this.inboxService.onDidChange(() => this.sendScheduler.schedule()));
		this._register(snapshotService.subscribe(outcome => {
			if (outcome.snapshot === undefined) {
				return;
			}
			const owned = new Set(this.paneTokenService.listPaneTokens().map(entry => entry.token));
			const working = outcome.snapshot.paneStatuses.filter(status => status.status === 'working' && owned.has(status.token)).length;
			if (working !== this.working) {
				this.working = working;
				this.sendScheduler.schedule();
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_MENU_BAR_ICON_SETTING) || e.affectsConfiguration('paradis.menuBar')) {
				this.lastSignature = '';
				this.updateTimers();
				this.sendScheduler.schedule();
			}
		}));
		this._register(this.channel.listen<ParadisMenuBarRequest>('onDidRequest')(request => this.handleRequest(request)));
		this.updateTimers();
		this.sendScheduler.schedule();
	}

	private settings() {
		return paradisReadMenuBarSettings(this.configurationService.getValue<boolean>(PARADIS_MENU_BAR_ICON_SETTING) === true, key => this.configurationService.getValue(key));
	}

	/** 使用量とコストを取りに行くかを、設定に合わせて切り替える。 */
	private updateTimers(): void {
		const settings = this.settings();
		const needsUsage = paradisMenuBarNeedsUsage(settings);
		if (needsUsage && !this.usageTimer.value) {
			const timer = new IntervalTimer();
			timer.cancelAndSet(() => void this.fetchUsage(), USAGE_INTERVAL);
			this.usageTimer.value = timer;
			void this.fetchUsage();
		} else if (!needsUsage) {
			this.usageTimer.clear();
		}
		// コストはメニューの中にだけ出す
		const needsCost = needsUsage && settings.menuUsage;
		if (needsCost && !this.costTimer.value) {
			this.costTimer.value = new RunOnceScheduler(() => void this.fetchCost(), COST_INTERVAL);
			void this.fetchCost();
		} else if (!needsCost) {
			this.costTimer.clear();
		}
	}

	/** このウィンドウの出どころ（手元か、接続先の authority）。 */
	private source(): { readonly key: string; readonly label?: string; readonly remote: boolean } {
		const connection = this.remoteAgentService.getConnection();
		if (!connection) {
			return { key: 'local', remote: false };
		}
		const label = this.labelService.getHostLabel(Schemas.vscodeRemote, connection.remoteAuthority);
		return { key: connection.remoteAuthority, ...(label ? { label } : {}), remote: true };
	}

	private async fetchUsage(): Promise<void> {
		if (this.fetchingUsage) {
			return;
		}
		this.fetchingUsage = true;
		try {
			const source = this.source();
			// SSH のウィンドウの Claude は、接続先でいまログインしているアカウントだけ（スマホと同じ）
			const [snapshot, codexState] = await Promise.all([
				this.limitsClient.getSnapshot(false, false, source.remote),
				this.codexClient.getState().catch(() => undefined),
			]);
			const selectedCodexHome = codexState ? paradisSelectedCodexHome(codexState)?.homePath : undefined;
			this.usage = {
				...source,
				fetchedAt: Date.now(),
				accounts: paradisMenuBarAccountsFromLimits(snapshot, source.key, source.remote, selectedCodexHome),
			};
			this.sendScheduler.schedule();
		} catch (error) {
			// shared process・接続先の一時的な不通。前の値を残し、次の周回で取り直す
			this.logService.trace('[paradisMenuBar] failed to read the usage', String(error));
		} finally {
			this.fetchingUsage = false;
		}
	}

	private async fetchCost(): Promise<void> {
		if (this.fetchingCost) {
			return;
		}
		this.fetchingCost = true;
		try {
			const usd = await this.ccusageClient.fetchTodayCost();
			this.costFailures = 0;
			if (usd !== undefined) {
				const source = this.source();
				this.cost = { sourceKey: source.key, ...(source.label ? { label: source.label } : {}), remote: source.remote, usd, fetchedAt: Date.now() };
				this.sendScheduler.schedule();
			}
		} catch (error) {
			// ccusage が無い・時間切れ。ステータスバーと同じく間隔を伸ばす
			this.costFailures++;
			this.logService.trace('[paradisMenuBar] failed to read today\'s cost', String(error));
		} finally {
			this.fetchingCost = false;
			this.costTimer.value?.schedule(COST_INTERVAL * Math.pow(2, Math.min(this.costFailures, COST_MAX_BACKOFF_STEPS)));
		}
	}

	private send(): void {
		// アイコンを出していない間は送らない（設定をオンにした瞬間に設定の購読から送り直す）
		const settings = this.settings();
		if (!settings.iconEnabled) {
			return;
		}
		const needsUsage = paradisMenuBarNeedsUsage(settings);
		const report: IParadisMenuBarReport = {
			inbox: paradisMenuBarInboxFromSnapshot(this.inboxService.snapshot),
			working: this.working,
			...(needsUsage && this.usage ? { usage: this.usage } : {}),
			...(needsUsage && settings.menuUsage && this.cost ? { cost: this.cost } : {}),
		};
		const signature = JSON.stringify(report);
		if (signature === this.lastSignature) {
			return;
		}
		this.lastSignature = signature;
		this.channel.call<{ readonly request?: Exclude<ParadisMenuBarRequest['type'], 'reveal'> } | undefined>('update', [report]).then(result => {
			// ウィンドウが無い間にメニューで押された操作
			if (result?.request) {
				this.handleRequest({ type: result.request, windowId: this.nativeHostService.windowId });
			}
		}, error => this.logService.trace('[paradisMenuBar] update failed', String(error)));
	}

	private handleRequest(request: ParadisMenuBarRequest): void {
		if (request.windowId !== this.nativeHostService.windowId) {
			return; // 別のウィンドウ宛て
		}
		switch (request.type) {
			case 'reveal': {
				const entry = this.inboxService.snapshot.entries.find(candidate => candidate.id === request.entryId);
				if (entry) {
					void this.inboxService.reveal(entry);
				}
				break;
			}
			case 'openUsagePanel':
				void this.commandService.executeCommand(PARADIS_LIMITS_OPEN_PANEL_COMMAND_ID);
				break;
			case 'openCostDashboard':
				void this.commandService.executeCommand(PARADIS_USAGE_DASHBOARD_COMMAND_ID, 'ccusage');
				break;
			case 'openSettings':
				void this.commandService.executeCommand(PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID, PARADIS_MENU_BAR_SETTINGS_SECTION_ID);
				break;
		}
	}
}

registerWorkbenchContribution2(ParadisMenuBarFeed.ID, ParadisMenuBarFeed, WorkbenchPhase.AfterRestored);
