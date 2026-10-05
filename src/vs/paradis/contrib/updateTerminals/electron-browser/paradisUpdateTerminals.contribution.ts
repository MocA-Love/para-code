/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 更新の前に、接続先とこの PC の常駐に残したターミナルを終わらせる（ウィンドウ側）。
//
// main の関門（`electron-main/paradisUpdateTerminalsMain.ts`）から呼ばれて、
//  - このウィンドウで取り残されるターミナルを答える（`collect`）
//  - まとめた確認を出す（`confirm`、前面のウィンドウだけが呼ばれる）
//  - 「終わらせて更新」なら、この PC が残したものだけを止め、合図が届くのを待って返す（`stopForUpdate`）
//
// 加えて、更新が用意できた時点で「次に終了すると…のターミナルは終わります」と知らせ、Ready のまま
// 普通に終了したとき（macOS では更新が当たる）は、終了の途中で尋ねずに止める。
//
// 止める合図は `onWillShutdown` の dispose 任せにしない。そちらは送りっぱなしで、ウィンドウが閉じる
// 前に接続先へ届く保証が無い。ここでは `$shutdown` の返事を待つ。

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProcessDetails } from '../../../../platform/terminal/common/terminalProcess.js';
import { IUpdateService, State as UpdateState, StateType } from '../../../../platform/update/common/update.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { REMOTE_TERMINAL_CHANNEL_NAME, RemoteTerminalChannelRequest } from '../../../../workbench/contrib/terminal/common/remote/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ILifecycleService, ShutdownReason } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { ParadisKeepTerminalsChoice, paradisDaemonHandlesTerminal, paradisParseKeepTerminalsChoice, paradisRemoteHandlesTerminal } from '../../../common/paradisTerminalKeepPlan.js';
import { paradisCollectAllTerminalInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshot } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { IParadisPtyDaemonStatusService, PARADIS_PTY_DAEMON_CHANNEL } from '../../ptyDaemon/common/paradisPtyDaemonStatus.js';
import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../../ptyDaemon/common/paradisPtyDaemonSettingKey.js';
import { PARADIS_KEEP_REMOTE_TERMINALS_KEY, paradisKeptPaneTokensStorageKey } from '../../remoteTerminals/common/paradisRemoteTerminalShutdown.js';
import {
	IParadisUpdateTerminal,
	IParadisUpdateTerminalSummary,
	IParadisUpdateTerminalsMainService,
	IParadisUpdateTerminalsWindowService,
	IParadisUpdateWindowReport,
	PARADIS_UPDATE_CONFIRM_TIMEOUT_MS,
	PARADIS_UPDATE_LOCAL_HOST_KEY,
	PARADIS_UPDATE_TERMINALS_MAIN_CHANNEL,
	PARADIS_UPDATE_TERMINALS_WINDOW_CHANNEL,
	ParadisTerminalsAcrossUpdate,
	ParadisUpdateConfirmAnswer,
	paradisClearUpdateQuitApproved,
	paradisGetRemoteTerminalsAcrossUpdate,
	paradisLocalTerminalsAcrossUpdate,
	paradisMarkUpdateQuitApproved,
	paradisParseKeptPaneTokens,
	paradisResolveUpdateConfirmAnswer,
	paradisSelectOwnOrphans,
	paradisSetRemoteTerminalsAcrossUpdate,
	paradisShouldNoticeCancelledUpdate,
	paradisStopsRemoteForUpdate,
	paradisShouldNoticeReadyUpdate,
	paradisUpdateAppliesOnQuitHere,
	paradisUpdateQuitEndsTerminals,
} from '../common/paradisUpdateTerminals.js';
import { IParadisUpdateTerminalsDialog, paradisShowUpdateTerminalsDialog } from './paradisUpdateTerminalsDialog.js';

/** 接続先へ聞くときの上限。 */
const REMOTE_TIMEOUT_MS = 4_000;
/** 終了の途中で止める合図を待つ上限（Ready のまま終了したとき）。閉じる処理を長く止めない。 */
const QUIT_STOP_TIMEOUT_MS = 6_000;

function noticedStorageKey(hostKey: string): string {
	return `paradis.updateTerminals.noticedVersion.${hostKey}`;
}

class ParadisUpdateTerminalsWindow extends Disposable implements IWorkbenchContribution, IParadisUpdateTerminalsWindowService {

	static readonly ID = 'paradis.updateTerminalsWindow';

	private readonly main: IParadisUpdateTerminalsMainService;
	private latestSnapshot: IParadisAgentStatusSnapshot | undefined;
	/** 「終わらせて更新」で既に止めたか。止めたら終了の途中では止め直さない。 */
	private stoppedForUpdate = false;
	/** 「終わらせて更新」で実際に止めた本数。取り消されたときに知らせるかはこれで決める。 */
	private endedForUpdate = 0;
	private dialog: IParadisUpdateTerminalsDialog | undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisAgentStatusSnapshotService agentStatusService: IParadisAgentStatusSnapshotService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IStorageService private readonly storageService: IStorageService,
		@ILabelService private readonly labelService: ILabelService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@INotificationService private readonly notificationService: INotificationService,
		@IUpdateService private readonly updateService: IUpdateService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.main = ProxyChannel.toService<IParadisUpdateTerminalsMainService>(mainProcessService.getChannel(PARADIS_UPDATE_TERMINALS_MAIN_CHANNEL));

		const channelStore = this._register(new DisposableStore());
		const surface: IParadisUpdateTerminalsWindowService = {
			collect: () => this.collect(),
			confirm: summary => this.confirm(summary),
			stopForUpdate: () => this.stopForUpdate(),
			cancelUpdateQuit: () => this.cancelUpdateQuit(),
		};
		mainProcessService.registerChannel(PARADIS_UPDATE_TERMINALS_WINDOW_CHANNEL, ProxyChannel.fromService<string>(surface, channelStore));

		this._register(agentStatusService.subscribe(outcome => {
			if (outcome.snapshot) {
				this.latestSnapshot = outcome.snapshot;
			}
		}));

		// 閉じるのが取り消されたら、「終わらせて更新」の合図も取り消す（取り消した後の普通の終了で、
		// 尋ねずに終わらせないため）。
		this._register(lifecycleService.onShutdownVeto(() => {
			// 止めた後の取り消しは main が全ウィンドウへ知らせる（`cancelUpdateQuit`）。ここでは合図だけ消す。
			paradisClearUpdateQuitApproved();
		}));

		// Ready のまま普通に終了したとき（macOS では更新が当たる）。終了の途中では確認を出せないので、
		// 用意できた時点で知らせてあり、ここでは尋ねずに止める。止めるのは残すはずだったものだけ
		// （`never` の設定のものは今までどおり閉じる処理が終わらせる）。
		// この PC の常駐は main が終了処理の中で止める（先に止めると pty host が起こし直すため）。
		this._register(lifecycleService.onWillShutdown(event => {
			const authority = this.environmentService.remoteAuthority;
			if (authority === undefined || event.reason !== ShutdownReason.QUIT || this.stoppedForUpdate) {
				return;
			}
			const ends = paradisUpdateQuitEndsTerminals({
				stateType: this.updateService.state.type,
				appliesOnQuit: paradisUpdateAppliesOnQuitHere(),
				approved: false,
				acrossUpdate: this.acrossUpdateHere(),
			});
			if (!ends || this.keepChoice() === 'never') {
				return;
			}
			event.join(this.stopOnQuit(authority), { id: 'paradis.updateTerminals', label: localize('paradis.updateTerminals.joinLabel', "残したターミナルを終了しています") });
		}));

		if (this.environmentService.remoteAuthority !== undefined) {
			void this.refreshRemoteAcrossUpdate();
		}
		this._register(this.updateService.onStateChange(state => void this.maybeNoticeReady(state)));
		void this.maybeNoticeReady(this.updateService.state);
	}

	// --- main からの問い合わせ -------------------------------------------------------------------

	async collect(): Promise<IParadisUpdateWindowReport | undefined> {
		const authority = this.environmentService.remoteAuthority;
		if (authority !== undefined) {
			const acrossUpdate = await this.refreshRemoteAcrossUpdate();
			const live = this.liveTerminals();
			const orphans = await this.ownRemoteOrphans(authority, new Set(live.map(instance => instance.persistentProcessId).filter((id): id is number => id !== undefined)));
			return {
				hostKey: authority,
				hostLabel: this.hostLabel(authority),
				isRemote: true,
				choice: this.keepChoice(),
				// 答えが無かったときは「取り残される」側で並べる。確認を出して、ユーザーが選ぶ。
				acrossUpdate: acrossUpdate === 'unknown' ? 'stranded' : acrossUpdate,
				terminals: [...live.map(instance => this.describeInstance(instance)), ...orphans.map(details => this.describeProcess(details))],
			};
		}
		return {
			hostKey: PARADIS_UPDATE_LOCAL_HOST_KEY,
			hostLabel: localize('paradis.updateTerminals.localHost', "この PC の常駐"),
			isRemote: false,
			choice: this.keepChoice(),
			acrossUpdate: this.acrossUpdateHere(),
			terminals: this.liveTerminals().map(instance => this.describeInstance(instance)),
		};
	}

	async confirm(summary: IParadisUpdateTerminalSummary): Promise<ParadisUpdateConfirmAnswer> {
		this.dialog?.close();
		const dialog = paradisShowUpdateTerminalsDialog(this.layoutService.activeContainer, summary);
		this.dialog = dialog;
		// 30 秒答えが無ければ畳んで「あとで更新」にする（勝手に止めない）。
		const answer = await raceTimeout(dialog.answer, PARADIS_UPDATE_CONFIRM_TIMEOUT_MS, () => dialog.close());
		if (this.dialog === dialog) {
			this.dialog = undefined;
		}
		return paradisResolveUpdateConfirmAnswer(answer);
	}

	async stopForUpdate(): Promise<void> {
		paradisMarkUpdateQuitApproved(Date.now());
		this.stoppedForUpdate = true;
		const authority = this.environmentService.remoteAuthority;
		this.endedForUpdate = 0;
		// この PC の常駐は main が止める。ここで止めるのは接続先のものだけ。
		if (authority === undefined || !paradisStopsRemoteForUpdate({ isRemote: true, choice: this.keepChoice(), acrossUpdate: paradisGetRemoteTerminalsAcrossUpdate() })) {
			return;
		}
		this.endedForUpdate = await this.stopRemoteTerminals(authority);
	}

	// --- 止める -----------------------------------------------------------------------------------

	async cancelUpdateQuit(): Promise<void> {
		paradisClearUpdateQuitApproved();
		const ended = this.endedForUpdate;
		this.stoppedForUpdate = false;
		this.endedForUpdate = 0;
		if (paradisShouldNoticeCancelledUpdate(ended)) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('paradis.updateTerminals.cancelled', "更新のために、残したターミナルを終わらせましたが、更新は行われませんでした。終わらせたターミナルは戻りません。"),
			});
		}
	}

	private async stopOnQuit(authority: string): Promise<void> {
		const stopping = this.stopRemoteTerminals(authority);
		const done = await raceTimeout(stopping.then(() => true, () => true), QUIT_STOP_TIMEOUT_MS);
		if (!done) {
			this.logService.warn('[paradisUpdateTerminals] could not finish ending the kept terminals before quitting to update');
		}
	}

	/**
	 * 接続先で、このウィンドウのものと、この PC が前に残したものを止める。返事を待つ。
	 *
	 * 1本の失敗で残りを見捨てない（止めている間にシェルが終わったものは「そんな pty は無い」で
	 * 失敗する）。
	 */
	/** 止めた本数（返事が来たもの）を返す。 */
	private async stopRemoteTerminals(authority: string): Promise<number> {
		const channel = this.remoteAgentService.getConnection()?.getChannel(REMOTE_TERMINAL_CHANNEL_NAME);
		if (!channel) {
			return 0;
		}
		const live = this.liveTerminals();
		const liveIds = live.map(instance => instance.persistentProcessId).filter((id): id is number => id !== undefined);
		const orphans = await this.ownRemoteOrphans(authority, new Set(liveIds));
		const ids = [...new Set([...liveIds, ...orphans.map(details => details.id)])];
		if (ids.length === 0) {
			return 0;
		}
		const results = await Promise.allSettled(ids.map(id => channel.call(RemoteTerminalChannelRequest.Shutdown, [id, true])));
		const failed = results.filter(result => result.status === 'rejected').length;
		this.logService.info(`[paradisUpdateTerminals] ended ${ids.length - failed} terminal(s) on the remote before updating${failed > 0 ? ` (${failed} were already gone or could not be reached)` : ''}`);
		return ids.length - failed;
	}

	// --- 集める -----------------------------------------------------------------------------------

	/** 残すはずのターミナル（このウィンドウの担当のもの）。 */
	private liveTerminals(): ITerminalInstance[] {
		const isRemoteWindow = this.environmentService.remoteAuthority !== undefined;
		return paradisCollectAllTerminalInstances(this.terminalService, this.terminalGroupService)
			.filter(instance => isRemoteWindow ? paradisRemoteHandlesTerminal(true, instance) : paradisDaemonHandlesTerminal(false, instance));
	}

	/** 接続先の pty host に残っているもののうち、この PC が残したもの。 */
	private async ownRemoteOrphans(authority: string, liveIds: ReadonlySet<number>): Promise<IProcessDetails[]> {
		const tokens = new Set(paradisParseKeptPaneTokens(this.storageService.get(paradisKeptPaneTokensStorageKey(authority), StorageScope.APPLICATION)));
		if (tokens.size === 0) {
			return [];
		}
		const channel = this.remoteAgentService.getConnection()?.getChannel(REMOTE_TERMINAL_CHANNEL_NAME);
		if (!channel) {
			return [];
		}
		try {
			const processes = await raceTimeout(channel.call<IProcessDetails[]>(RemoteTerminalChannelRequest.ListProcesses), REMOTE_TIMEOUT_MS);
			return paradisSelectOwnOrphans(processes ?? [], tokens, liveIds);
		} catch (error) {
			this.logService.trace('[paradisUpdateTerminals] could not list the terminals left on the remote', error);
			return [];
		}
	}

	private describeInstance(instance: ITerminalInstance): IParadisUpdateTerminal {
		return {
			// 番号がまだ無い（起動の途中）ものは、重ならない負の数で数えておく。
			id: instance.persistentProcessId ?? -instance.instanceId,
			title: instance.title,
			busy: instance.hasChildProcesses,
			...this.agentOf(this.paneTokenService.getTokenForInstance(instance.instanceId)),
		};
	}

	private describeProcess(details: IProcessDetails): IParadisUpdateTerminal {
		return {
			id: details.id,
			title: details.title,
			busy: details.hasChildProcesses,
			...this.agentOf(details.paradisPaneToken),
		};
	}

	private agentOf(token: string | undefined): Pick<IParadisUpdateTerminal, 'agent' | 'agentState'> {
		const snapshot = this.latestSnapshot;
		if (token === undefined || snapshot === undefined) {
			return {};
		}
		const agent = snapshot.paneSessions?.find(session => session.token === token)?.agent;
		const agentState = snapshot.paneStatuses.find(status => status.token === token)?.status;
		return { ...(agent !== undefined ? { agent } : {}), ...(agentState !== undefined ? { agentState } : {}) };
	}

	private keepChoice(): ParadisKeepTerminalsChoice {
		const key = this.environmentService.remoteAuthority !== undefined ? PARADIS_KEEP_REMOTE_TERMINALS_KEY : PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE;
		return paradisParseKeepTerminalsChoice(this.configurationService.getValue(key));
	}

	private acrossUpdateHere(): ParadisTerminalsAcrossUpdate {
		if (this.environmentService.remoteAuthority !== undefined) {
			return paradisGetRemoteTerminalsAcrossUpdate();
		}
		return paradisLocalTerminalsAcrossUpdate(
			this.configurationService.getValue(PARADIS_PTY_DAEMON_ENABLED) === true,
			this.configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) === true,
		);
	}

	/**
	 * 接続先のターミナルが更新をまたげるか（接続先の常駐の中に居るか）を聞き直して控える。
	 * 答えが無ければ前に分かっていた値のまま。
	 */
	private async refreshRemoteAcrossUpdate(): Promise<ParadisTerminalsAcrossUpdate> {
		const connection = this.remoteAgentService.getConnection();
		if (!connection) {
			return paradisGetRemoteTerminalsAcrossUpdate();
		}
		try {
			const status = await raceTimeout(ProxyChannel.toService<IParadisPtyDaemonStatusService>(connection.getChannel(PARADIS_PTY_DAEMON_CHANNEL)).getStatus(), REMOTE_TIMEOUT_MS);
			if (status) {
				paradisSetRemoteTerminalsAcrossUpdate(status.enabled && status.running ? 'survives' : 'stranded');
			}
		} catch (error) {
			this.logService.trace('[paradisUpdateTerminals] could not ask whether the remote keeps terminals across updates', error);
		}
		return paradisGetRemoteTerminalsAcrossUpdate();
	}

	private hostLabel(authority: string): string {
		return this.labelService.getHostLabel(Schemas.vscodeRemote, authority) || authority;
	}

	// --- 用意できた時点のお知らせ -----------------------------------------------------------------

	private async maybeNoticeReady(state: UpdateState): Promise<void> {
		if (state.type !== StateType.Ready || !paradisUpdateAppliesOnQuitHere()) {
			return;
		}
		const updateVersion = state.update.productVersion ?? state.update.version;
		const authority = this.environmentService.remoteAuthority;
		let hostKey: string;
		let terminalCount: number;
		let acrossUpdate: ParadisTerminalsAcrossUpdate;
		let choice: ParadisKeepTerminalsChoice;
		let message: string;
		if (authority !== undefined) {
			acrossUpdate = await this.refreshRemoteAcrossUpdate();
			const live = this.liveTerminals();
			const orphans = await this.ownRemoteOrphans(authority, new Set(live.map(instance => instance.persistentProcessId).filter((id): id is number => id !== undefined)));
			hostKey = authority;
			terminalCount = live.length + orphans.length;
			choice = this.keepChoice();
			message = localize('paradis.updateTerminals.ready.remote', "更新の準備ができました。次に Para Code を終了すると更新されます。そのとき、接続先（{0}）のターミナル {1} 個は終わります。", this.hostLabel(authority), terminalCount);
		} else {
			const daemon = await this.main.getLocalDaemon().catch(() => undefined);
			if (!daemon) {
				return;
			}
			hostKey = PARADIS_UPDATE_LOCAL_HOST_KEY;
			terminalCount = daemon.terminalCount ?? 0;
			acrossUpdate = daemon.stranded ? 'stranded' : 'survives';
			choice = daemon.choice;
			message = localize('paradis.updateTerminals.ready.local', "更新の準備ができました。次に Para Code を終了すると更新されます。そのとき、この PC の常駐のターミナル {0} 個は終わります。", terminalCount);
		}
		const key = noticedStorageKey(hostKey);
		// 待っている間に状態が変わっていたら出さない。
		if (this.updateService.state.type !== StateType.Ready || !paradisShouldNoticeReadyUpdate({
			stateType: StateType.Ready,
			appliesOnQuit: true,
			choice,
			acrossUpdate,
			terminalCount,
			updateVersion,
			noticedVersion: this.storageService.get(key, StorageScope.APPLICATION),
		})) {
			return;
		}
		// 同じ接続先のウィンドウが複数あっても1回だけ出す。保存（次の起動のため）だけでは、同時に
		// 動いたウィンドウどうしで間に合わないので、main に先着を決めてもらう。
		if (updateVersion !== undefined) {
			const claimed = await this.main.claimReadyNotice(hostKey, updateVersion).catch(() => true);
			if (!claimed) {
				return;
			}
			this.storageService.store(key, updateVersion, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		this.notificationService.prompt(Severity.Info, message, [
			{ label: localize('paradis.updateTerminals.ready.restart', "今すぐ再起動して更新"), run: () => void this.updateService.quitAndInstall() },
			{ label: localize('paradis.updateTerminals.ready.later', "あとで"), run: () => { } },
		]);
	}
}

registerWorkbenchContribution2(ParadisUpdateTerminalsWindow.ID, ParadisUpdateTerminalsWindow, WorkbenchPhase.AfterRestored);
