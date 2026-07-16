/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize, localize2 } from '../../../../nls.js';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWebviewWorkbenchService } from '../../../../workbench/contrib/webviewPanel/browser/webviewWorkbenchService.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ACTIVE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisTerminalIdentityService } from '../browser/paradisTerminalIdentityService.js';
import { encodeQrCode, qrToSvg } from '../common/paradisQrCode.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisMobileRelayService,
	IParadisMobileStatus,
	PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY,
	PARADIS_MOBILE_ENABLED_KEY,
	PARADIS_MOBILE_RELAY_CHANNEL,
	PARADIS_MOBILE_RELAY_URL_KEY,
	paradisMobileWindowRoute,
} from '../common/paradisMobileRelay.js';
import { ParadisMobileWorkspaceProvider } from './paradisMobileWorkspaceProvider.js';
import { ParadisMobileWebrtcStreamer } from './paradisMobileWebrtcStreamer.js';
import { ParadisAgentTerminalHintParser, paradisShouldAcceptAgentTerminalHint } from '../common/paradisAgentTerminalHints.js';
import { Channels } from '../common/paradisMobileProtocol.js';
import { paradisInteractiveAgentCommand, paradisResolveRunningAgentCommand } from '../common/paradisAgentCliCommand.js';
import { ParadisCcusageClient } from '../../ccusage/electron-browser/paradisCcusageClient.js';
import { paradisCreateWorktreeHeadless, paradisGetWorktreeCreateForm } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { PARADIS_GET_PR_STATUSES_COMMAND_ID } from '../../workspaceSwitch/electron-browser/paradisCreateWorktree.contribution.js';
import { IParadisPrStatus } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { IParadisMobileWindowLease, PARADIS_MOBILE_WINDOW_LEASE_CHANNEL, ParadisMobileWindowLeaseClient } from '../common/paradisMobileWindowLease.js';
import { ParadisAgentCommandDeliveryCoordinator, paradisShouldRetireAgentToken } from '../common/paradisAgentCommandLifecycle.js';
import { ParadisAgentTerminalRecoveryTracker } from '../common/paradisAgentTerminalRecovery.js';
import { IParadisAgentTerminalHintConsumer, paradisCreateAgentTerminalHintConsumer, paradisCreateTerminalOutputConsumer } from '../common/paradisTerminalOutputHotPath.js';

const STATUSBAR_ID = 'paradis.mobile.relay';
const PAIR_COMMAND = 'paradis.mobile.connectDevice';
const MENU_COMMAND = 'paradis.mobile.showMenu';
/** PCフォーカス状態のハートビート間隔。shared process側のTTL（WINDOW_FOCUS_TTL_MS=90秒）より十分短く保つ。 */
const PC_FOCUS_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * renderer 側のモバイルリレー contribution。
 * - shared process のリレーサービス(IPC)へ接続
 * - ペアリングコマンド + SAS確認ダイアログ
 * - 接続状態のステータスバー表示
 * - ParadisMobileWorkspaceProvider を通じて state/term を提供
 */
class ParadisMobileRelayContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisMobileRelay';

	// ペアリングコマンド(Action2)から到達するための参照。1ウィンドウ1インスタンス。
	static instance: ParadisMobileRelayContribution | undefined;

	private readonly service: IParadisMobileRelayService;
	private readonly provider: ParadisMobileWorkspaceProvider;
	private readonly statusbarEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly terminalHintListeners = this._register(new DisposableMap<number, DisposableStore>());
	private readonly terminalHintConsumers = new Map<number, IParadisAgentTerminalHintConsumer>();
	private readonly terminalHintTokens = new Map<number, string>();
	private readonly terminalPaneTokens = new Map<number, string>();
	private readonly agentCommandsByInstance = new Map<number, { readonly token: string; readonly commandLine: string }>();
	private agentCommandCoordinator: ParadisAgentCommandDeliveryCoordinator | undefined;
	private readonly windowLeasePromise: Promise<IParadisMobileWindowLease>;
	private readonly rendererReadyPromise: Promise<void>;
	private previousOnlineMobiles = 0;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ILogService private readonly logService: ILogService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@ITerminalService terminalService: ITerminalService,
		@ITerminalGroupService terminalGroupService: ITerminalGroupService,
		@IParadisTerminalScopeService terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
		@IParadisAgentStatusStore agentStatusStore: IParadisAgentStatusStore,
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILanguageService languageService: ILanguageService,
		@IExtensionService extensionService: IExtensionService,
		@IThemeService themeService: IThemeService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalIdentityService terminalIdentityService: IParadisTerminalIdentityService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IHostService private readonly hostService: IHostService,
		@ICommandService commandService: ICommandService,
	) {
		super();

		ParadisMobileRelayContribution.instance = this;
		this._register({ dispose: () => { if (ParadisMobileRelayContribution.instance === this) { ParadisMobileRelayContribution.instance = undefined; } } });

		this.service = ProxyChannel.toService<IParadisMobileRelayService>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
		const windowSession = generateUuid();
		this.windowLeasePromise = new ParadisMobileWindowLeaseClient(mainProcessService.getChannel(PARADIS_MOBILE_WINDOW_LEASE_CHANNEL))
			.claim(windowSession)
			.then(lease => {
				if (lease === undefined) {
					throw new Error('Electron Main did not issue a mobile Renderer lease');
				}
				return lease;
			});
		let markRendererReady!: () => void;
		this.rendererReadyPromise = new Promise<void>(resolve => { markRendererReady = resolve; });
		let markTerminalStateReady!: () => void;
		const terminalStateReady = new Promise<void>(resolve => { markTerminalStateReady = resolve; });
		let agentPanesSyncChain = Promise.resolve();
		const withWindowLease = <T>(callback: (lease: IParadisMobileWindowLease) => Promise<T>): Promise<T> => this.withWindowLease(callback);
		const withCurrentRendererLease = <T>(callback: (lease: IParadisMobileWindowLease) => Promise<T>): Promise<T> => this.withCurrentRendererLease(callback);

		// ウィンドウを閉じるとき、terminal leaseと同時にこのsessionのペイン対応表も破棄する。
		this._register({ dispose: () => { withWindowLease(lease => this.service.removeTerminalWindow(lease)).catch(() => { }); } });

		// PCフォーカス中はモバイルへの通知配信を抑制する機能（suppressWhenPcFocused）用に、
		// このウィンドウのフォーカス状態を shared process へ報告する（paradisNotificationTrigger等と
		// 同じ isVisibleAndFocused 判定: !document.hidden && hostService.hasFocus）。
		// イベント駆動の即時報告に加え、定期ハートビートでも再送する
		// （shared process側はWINDOW_FOCUS_TTL_MSより古い報告を無視する。rendererがクラッシュ等で
		// disposeを経ずに落ちても、このハートビートが途絶えることで自然に「フォーカス無し」に
		// 復帰させ、通知が恒久的にサイレント抑制され続けることを防ぐ）。
		const reportPcFocus = () => {
			const focused = !mainWindow.document.hidden && this.hostService.hasFocus;
			withCurrentRendererLease(lease => this.service.setPcFocus(lease, focused)).catch(err => this.logService.warn('[paradisMobileRelay] setPcFocus failed', err));
		};
		this._register(this.hostService.onDidChangeFocus(() => reportPcFocus()));
		this._register(dom.addDisposableListener(mainWindow.document, 'visibilitychange', () => reportPcFocus()));
		const focusHeartbeat = this._register(new IntervalTimer());
		focusHeartbeat.cancelAndSet(() => reportPcFocus(), PC_FOCUS_HEARTBEAT_INTERVAL_MS);
		reportPcFocus();
		this._register({ dispose: () => { withWindowLease(lease => this.service.setPcFocus(lease, false)).catch(() => { }); } });

		// ccusage ダッシュボードデータ取得（PC版と同じ shared process 経由のクライアントを再利用する）
		const ccusageClient = instantiationService.createInstance(ParadisCcusageClient);

		this.provider = this._register(new ParadisMobileWorkspaceProvider(
			frame => { withCurrentRendererLease(lease => this.service.sendFrame(lease, frame.ch, frame.ws, frame.mobileId, frame.payload)).catch(err => this.logService.warn('[paradisMobileRelay] sendFrame failed', err)); },
			mainWindow.vscodeWindowId,
			workspaceSwitchService,
			terminalService,
			terminalGroupService,
			terminalScopeService,
			worktreeService,
			agentStatusStore,
			this.logService,
			fileService,
			environmentService,
			languageService,
			extensionService,
			themeService,
			sharedProcessService,
			(repoPath, args) => this.service.runGit(repoPath, args),
			paneTokenService,
			terminalIdentityService,
			state => { withWindowLease(lease => this.service.syncTerminalWindow(lease, state)).then(markTerminalStateReady, err => this.logService.warn('[paradisMobileRelay] syncTerminalWindow failed', err)); },
			(revision, entries) => {
				const sync = agentPanesSyncChain.then(() => terminalStateReady).then(() => withWindowLease(lease => this.service.syncAgentPanes(lease, revision, entries)));
				agentPanesSyncChain = sync.catch(() => { /* 次のsnapshotは継続する */ });
				return sync;
			},
			(mobileId, operationId, status) => withWindowLease(lease => this.service.completeTerminalOperation(lease, mobileId, operationId, status)),
			(mobileId, requestId, token, epoch) => withWindowLease(lease => this.service.claimAgentAction(mobileId, requestId, token, epoch, lease)),
			(mobileId, requestId, token, epoch, terminalId) => withWindowLease(lease => this.service.continueAgentInteraction(mobileId, requestId, token, epoch, terminalId, lease)),
			(mobileId, requestId, token, outcome) => withWindowLease(lease => this.service.finalizeAgentInteraction(mobileId, requestId, token, outcome, lease)),
			(mobileId, requestId, token, epoch, terminalId) => withWindowLease(lease => this.service.validateAgentAction(mobileId, requestId, token, epoch, terminalId, lease)),
			(rootPath, query, maxResults) => this.service.searchFiles(rootPath, query, maxResults),
			(rootPath, query, maxResults) => this.service.searchText(rootPath, query, maxResults),
			bypassCache => ccusageClient.fetchDashboard(bypassCache),
			// worktree（スペース）作成。実体はヘッドレス版のPC作成ダイアログ相当処理
			() => instantiationService.invokeFunction(paradisGetWorktreeCreateForm),
			request => instantiationService.invokeFunction(paradisCreateWorktreeHeadless, request),
			// PR 状態はPC版 Workspaces ビューと同じコマンド経由（gh 実行は shared process へ委譲）
			paths => commandService.executeCommand<Record<string, IParadisPrStatus>>(PARADIS_GET_PR_STATUSES_COMMAND_ID, [...paths]),
		));
		this.provider.pushState();
		this._register(this.service.onDidRequestAgentPaneSync(request => {
			withCurrentRendererLease(async lease => {
				if (lease.windowId === request.windowId
					&& lease.windowSession === request.windowSession
					&& lease.rendererGeneration === request.rendererGeneration) {
					await this.provider.syncAgentPaneRegistry();
				}
			}).catch(err => this.logService.warn('[paradisMobileRelay] requested agent pane sync failed', err));
		}));
		Promise.all([terminalStateReady, this.provider.initialAgentPanesReady]).then(
			() => markRendererReady(),
			err => this.logService.warn('[paradisMobileRelay] initial renderer state sync failed', err),
		);
		reportPcFocus();

		// shared process側では、daemon利用時にhookプロセスがターミナル固有envを継承できなくても、
		// shell integration後の鮮度検証済みtranscript探索で実在セッションを確定できる。
		// その確定結果をホーム一覧のagentフラグへ反映する。
		let confirmedAgentPanesRevision = -1;
		const applyConfirmedAgentPanes = (state: { readonly revision: number; readonly tokens: readonly string[] }) => {
			if (state.revision > confirmedAgentPanesRevision) {
				confirmedAgentPanesRevision = state.revision;
				this.provider.setConfirmedAgentPaneTokens(state.tokens);
			}
		};
		this._register(this.service.onDidChangeConfirmedAgentPanes(applyConfirmedAgentPanes));
		this.service.getConfirmedAgentPanes()
			.then(applyConfirmedAgentPanes)
			.catch(err => this.logService.warn('[paradisMobileRelay] confirmed agent terminals initial sync failed', err));

		// エージェントCLI (`claude` / `codex`) コマンドの実行開始を shell integration で検知し、
		// shared process のセッション探索を前倒しするトリガーとして通知する。起動の確定情報には
		// 使わない (探索側の鮮度ガードで `claude --help` 等の空振りは自然に弾かれる)。
		// hookがまだ届かない環境 (Codex の hook 未trust等) での検知の主経路になる。
		this.agentCommandCoordinator = this._register(new ParadisAgentCommandDeliveryCoordinator({
			syncRegistry: async () => this.provider.syncAgentPaneRegistry(),
			onProvisionalChange: (token, active) => {
				this.provider.setProvisionalAgentPaneToken(token, active);
				this.updateTerminalHintTracking();
			},
			onGenerationEnded: token => {
				for (const [instanceId, running] of this.agentCommandsByInstance) {
					if (running.token === token) {
						this.agentCommandsByInstance.delete(instanceId);
						this.terminalHintConsumers.get(instanceId)?.reset();
					}
				}
			},
		}));
		this._register({
			dispose: () => {
				for (const consumer of this.terminalHintConsumers.values()) {
					consumer.dispose();
				}
				this.terminalHintConsumers.clear();
				this.terminalHintTokens.clear();
				this.terminalPaneTokens.clear();
				this.agentCommandsByInstance.clear();
			}
		});
		const detectAgentCommand = (instance: ITerminalInstance, commandLine: string) => {
			const paneToken = this.provider.getPaneTokenForTerminalHint(instance.instanceId);
			const running = paradisResolveRunningAgentCommand(commandLine, paneToken);
			if (running === undefined) { return; }
			const { paneToken: runningPaneToken, commandLine: normalizedCommandLine, command } = running;
			const cwd = instance.capabilities.get(TerminalCapability.CommandDetection)?.cwd;
			this.agentCommandCoordinator?.start(runningPaneToken, normalizedCommandLine, generation => withCurrentRendererLease(lease => this.service.notifyAgentCliCommand(
				lease, runningPaneToken, generation, normalizedCommandLine, command.agent, command.mode, cwd, command.cwd, command.sessionId,
			)));
			this.agentCommandsByInstance.set(instance.instanceId, { token: runningPaneToken, commandLine: normalizedCommandLine });
			this.terminalPaneTokens.set(instance.instanceId, runningPaneToken);
		};
		const finishAgentCommand = (instance: ITerminalInstance, commandLineValue: string) => {
			const commandLine = commandLineValue.trim();
			if (paradisInteractiveAgentCommand(commandLine) === undefined) { return; }
			const running = this.agentCommandsByInstance.get(instance.instanceId);
			const paneToken = this.provider.getPaneTokenForTerminalHint(instance.instanceId) ?? running?.token;
			if (paneToken === undefined) { return; }
			this.agentCommandCoordinator?.finish(paneToken, commandLine, generation => withCurrentRendererLease(lease => this.service.notifyAgentCliCommandFinished(lease, paneToken, generation)));
		};
		const recoveryTracker = this._register(new ParadisAgentTerminalRecoveryTracker(
			() => this.provider.getAllTerminalInstancesForAgentRecovery(),
			{
				getAuthorityKey: instance => this.provider.getPaneTokenForTerminalHint(instance.instanceId),
				onCommandExecuted: detectAgentCommand,
				onCommandFinished: finishAgentCommand,
			},
		));
		const reconcileTerminalTracking = () => {
			recoveryTracker.reconcile();
			this.updateTerminalHintTracking();
		};
		// 永続ターミナル再接続ではCommandDetectionよりpane token復元が遅い場合がある。
		// token割当時に実行中コマンドを再評価し、起動済みAgentの取りこぼしを回収する。
		this._register(paneTokenService.onDidChange(() => {
			for (const [instanceId, token] of this.terminalPaneTokens) {
				const reverseOwner = paneTokenService.getInstanceForToken(token);
				if (reverseOwner === instanceId) {
					continue;
				}
				this.terminalPaneTokens.delete(instanceId);
				this.agentCommandsByInstance.delete(instanceId);
				this.terminalHintConsumers.get(instanceId)?.reset();
				if (reverseOwner === undefined) {
					this.agentCommandCoordinator?.disposeToken(token);
				}
			}
			reconcileTerminalTracking();
		}));
		// panel park/unparkはgroup event、editor park/unparkはscope switch完了、通常生成/破棄は
		// terminal service eventでexact authority集合へ収束させる。capability add/removeはtrackerが
		// 各live instanceへ直接一度だけ購読する。
		this._register(terminalService.onDidCreateInstance(reconcileTerminalTracking));
		this._register(terminalService.onDidDisposeInstance(instance => {
			this.cleanupTerminalTracking(instance);
			reconcileTerminalTracking();
		}));
		this._register(terminalGroupService.onDidChangeGroups(reconcileTerminalTracking));
		this._register(workspaceSwitchService.onDidSwitchScope(reconcileTerminalTracking));
		this._register(agentStatusStore.onDidChangeAgentStatuses(() => this.updateTerminalHintTracking()));
		reconcileTerminalTracking();

		// WebRTCミラーのストリーマ（browser チャネルの webrtc-* シグナリングを処理）。
		const webrtcStreamer = this._register(new ParadisMobileWebrtcStreamer(
			frame => { withCurrentRendererLease(lease => this.service.sendFrame(lease, frame.ch, frame.ws, frame.mobileId, frame.payload)).catch(err => this.logService.warn('[paradisMobileRelay] webrtc sendFrame failed', err)); },
			this.logService,
		));

		// shared process が復号したモバイル→PCフレームを provider へ。
		// browser チャネルは webrtc シグナリングだけが renderer に転送されてくる
		// （それ以外の browser 要求は shared process 内で処理される）。
		this._register(this.service.onInboundFrame(([ch, ws, seq, payload, mobileId]) => {
			if ((ch === Channels.Agent || ch === Channels.Terminal || ch === Channels.Scm || ch === Channels.Fs || ch === Channels.Browser)
				&& ws !== undefined) {
				void this.windowLeasePromise.then(lease => {
					if (ws === paradisMobileWindowRoute(lease.windowId, lease.windowSession, lease.rendererGeneration)) {
						if (ch === Channels.Browser) {
							webrtcStreamer.handleInbound({ ch, ws, seq, payload, mobileId });
						} else {
							this.provider.handleInbound({ ch, ws, seq, payload, mobileId });
						}
					}
				}).catch(err => this.logService.warn('[paradisMobileRelay] inbound route lease failed', err));
				return;
			}
			if (ch === Channels.Browser) {
				webrtcStreamer.handleInbound({ ch, ws, seq, payload, mobileId });
				return;
			}
			this.provider.handleInbound({ ch, ws, seq, payload, mobileId });
		}));

		// 接続状態をステータスバーに反映。オンラインのモバイルが0になったら端末購読を解放。
		// 0 → 非0 に転じた（新規ペアリングに限らず、PC再起動後の自動再接続なども含む）
		// 瞬間には、そのモバイルはまだ最新状態を持っていないため改めて1回 push する。
		this._register(this.service.onDidChangeStatus(status => {
			this.renderStatusbar(status);
			this.provider.setMobileOnline(status.onlineMobiles > 0);
			if (status.onlineMobiles === 0) {
				this.provider.detachAll();
				webrtcStreamer.stopAll();
			} else if (this.previousOnlineMobiles === 0) {
				this.provider.pushState();
			}
			this.previousOnlineMobiles = status.onlineMobiles;
		}));

		// ペアリング成立時に通知 + 状態を1回送る。
		this._register(this.service.onPairingEvent(() => { /* ダイアログ側で処理。ここではno-op */ }));

		// shared process を現在の設定で初期化。
		const enabled = this.isEnabled();
		const relayUrl = this.configurationService.getValue<string>(PARADIS_MOBILE_RELAY_URL_KEY);
		this.initialize(enabled, relayUrl);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_MOBILE_ENABLED_KEY)) {
				const enabled = this.isEnabled();
				this.service.setEnabled(enabled).catch(err => this.logService.warn('[paradisMobileRelay] setEnabled failed', err));
				if (!enabled) {
					this.provider.detachAll();
				}
				this.syncAgentLiveOptions();
				this.updateTerminalHintTracking();
				// 有効/無効の切り替えは shared process の状態変化を待たずに即座に表示へ反映する
				// （無効化直後の項目消去・有効化直後の項目表示を確実にするため）。
				this.service.getStatus().then(status => this.renderStatusbar(status)).catch(() => { /* ignore */ });
			}
			if (e.affectsConfiguration(PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY)) {
				this.syncAgentLiveOptions();
			}
		}));

		this.service.getStatus().then(status => this.renderStatusbar(status)).catch(() => { /* ignore */ });
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_MOBILE_ENABLED_KEY) === true;
	}

	private syncAgentLiveOptions(): void {
		const codexDaemonStreaming = this.isEnabled()
			&& this.configurationService.getValue<boolean>(PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY) === true;
		this.service.setAgentLiveOptions({ codexDaemonStreaming }).catch(err => this.logService.warn('[paradisMobileRelay] setAgentLiveOptions failed', err));
	}

	private withWindowLease<T>(callback: (lease: IParadisMobileWindowLease) => Promise<T>): Promise<T> {
		return this.windowLeasePromise.then(callback);
	}

	private withCurrentRendererLease<T>(callback: (lease: IParadisMobileWindowLease) => Promise<T>): Promise<T> {
		return this.rendererReadyPromise.then(() => this.windowLeasePromise).then(callback);
	}

	private updateTerminalHintTracking(): void {
		const desired = new Map<number, { readonly instance: ITerminalInstance; readonly token: string }>();
		if (this.isEnabled()) {
			for (const instance of this.provider.getAllTerminalInstancesForAgentRecovery()) {
				const token = this.provider.getPaneTokenForTerminalHint(instance.instanceId);
				if (token !== undefined && paradisShouldAcceptAgentTerminalHint(true, token, this.provider.isTerminalHintActive(token))) {
					desired.set(instance.instanceId, { instance, token });
				}
			}
		}
		for (const instanceId of [...this.terminalHintListeners.keys()]) {
			if (desired.get(instanceId)?.token !== this.terminalHintTokens.get(instanceId)) {
				this.stopTerminalHints(instanceId);
			}
		}
		for (const { instance, token } of desired.values()) {
			this.trackTerminalHints(instance, token);
		}
	}

	private trackTerminalHints(instance: ITerminalInstance, paneToken: string): void {
		if (this.terminalHintListeners.has(instance.instanceId) && this.terminalHintTokens.get(instance.instanceId) === paneToken) {
			return;
		}
		this.stopTerminalHints(instance.instanceId);
		const parser = new ParadisAgentTerminalHintParser();
		this.terminalHintTokens.set(instance.instanceId, paneToken);
		const store = new DisposableStore();
		const hintConsumer = paradisCreateAgentTerminalHintConsumer(parser, hint => {
			this.withCurrentRendererLease(lease => this.service.notifyAgentTerminalHint(lease, instance.instanceId, hint)).catch(err => this.logService.trace('[paradisMobileRelay] terminal hint failed', String(err)));
		});
		this.terminalHintConsumers.set(instance.instanceId, hintConsumer);
		store.add(hintConsumer);
		store.add(instance.onData(paradisCreateTerminalOutputConsumer(undefined, hintConsumer.accept)!));
		store.add(instance.onDisposed(() => this.cleanupTerminalTracking(instance)));
		this.terminalHintListeners.set(instance.instanceId, store);
	}

	private stopTerminalHints(instanceId: number): void {
		this.terminalHintTokens.delete(instanceId);
		this.terminalHintListeners.deleteAndDispose(instanceId);
		this.terminalHintConsumers.delete(instanceId);
	}

	private cleanupTerminalTracking(instance: ITerminalInstance): void {
		const instanceId = instance.instanceId;
		const paneToken = this.terminalPaneTokens.get(instanceId)
			?? this.agentCommandsByInstance.get(instanceId)?.token
			?? this.paneTokenService.getTokenForInstance(instanceId);
		if (paneToken !== undefined && paradisShouldRetireAgentToken(instanceId, this.paneTokenService.getInstanceForToken(paneToken))) {
			this.agentCommandCoordinator?.disposeToken(paneToken);
		}
		this.agentCommandsByInstance.delete(instanceId);
		this.terminalPaneTokens.delete(instanceId);
		this.stopTerminalHints(instanceId);
	}

	private async initialize(enabled: boolean, relayUrl: string | undefined): Promise<void> {
		try {
			await this.service.initialize(enabled, relayUrl);
			this.syncAgentLiveOptions();
			// オンラインになったら状態を1回 push。
			this.provider.pushState();
			// 初期化完了時点の状態でステータスバーを描き直す。onDidChangeStatus は状態が
			// 「変化」したときしか発火しないため、shared process が既に目的の状態だった場合に
			// 初回描画を取りこぼさないよう、ここでも明示的に反映する（件3: 表示が出ない対策）。
			const status = await this.service.getStatus();
			this.renderStatusbar(status);
			// 既にモバイルが接続済みだった場合（ウィンドウリロード直後など）、
			// onDidChangeStatus が発火しなくても PR ポーリングを開始できるようにする
			this.provider.setMobileOnline(status.onlineMobiles > 0);
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] initialize failed', err);
		}
	}

	private renderStatusbar(status: IParadisMobileStatus): void {
		// 表示可否は「設定でリレーが有効か」だけで決める。shared process の state に依存すると、
		// 初期化前・再接続中・ウィンドウリロード直後などに一瞬 'disabled'/'disconnected' が
		// 返ってきた時に項目が消えてしまう（「接続状態表示が出ない時がある」の原因）。
		// リレーが有効な間は常に項目を出し、現在の接続状態はラベル側で表す。
		if (!this.isEnabled()) {
			this.statusbarEntry.clear();
			return;
		}
		const online = status.onlineMobiles > 0;
		let label: string;
		let icon: string;
		if (status.state === 'online') {
			label = online
				? localize('paradis.mobile.statusbar.active', "モバイル接続中 ({0})", status.onlineMobiles)
				: localize('paradis.mobile.statusbar.ready', "モバイル待機中");
			icon = '$(radio-tower)';
		} else if (status.state === 'disconnected') {
			label = localize('paradis.mobile.statusbar.disconnected', "モバイル切断中");
			icon = '$(debug-disconnect)';
		} else {
			label = localize('paradis.mobile.statusbar.connecting', "モバイル接続中…");
			icon = '$(sync~spin)';
		}
		const entry = {
			name: localize('paradis.mobile.statusbar.name', "Para Code Mobile"),
			text: `${icon} ${label}`,
			ariaLabel: label,
			tooltip: localize('paradis.mobile.statusbar.tooltip', "Para Code Mobile のリレー接続状態。クリックでメニューを開きます。"),
			command: MENU_COMMAND,
		};
		if (this.statusbarEntry.value) {
			this.statusbarEntry.value.update(entry);
		} else {
			this.statusbarEntry.value = this.statusbarService.addEntry(entry, STATUSBAR_ID, StatusbarAlignment.RIGHT, 47);
		}
	}

	/** ペアリングフロー（コマンドから呼ばれる）。 */
	async runPairing(): Promise<void> {
		// 有効化されていなければ先に有効化する。
		if (!this.isEnabled()) {
			await this.configurationService.updateValue(PARADIS_MOBILE_ENABLED_KEY, true);
		}

		let session;
		try {
			session = await this.service.beginPairing();
		} catch (err) {
			this.notificationService.error(localize('paradis.mobile.pairFailed', "ペアリングを開始できませんでした: {0}", String(err)));
			return;
		}

		// QR + URI をwebviewパネルで表示（QR生成は自前の paradisQrCode.ts、依存ゼロ）。
		// ペアリング成立/失敗でパネルは自動で閉じる。
		const pairingPanel = this.openPairingPanel(session.deviceId, session.pairingUri);

		// SAS確認を待つ。onPairingEvent の 'awaiting-approval' で確認ダイアログを出す。
		// awaiting-approval を受けてもリスナーは維持する（confirm dialog 表示中に届く
		// paired/failed まで拾い切る必要があるため）。一連のペアリングフローの終端
		// （paired または failed）でのみ clear する。
		const pairingListener = this._register(new MutableDisposable());
		pairingListener.value = this.service.onPairingEvent(async event => {
			if (event.kind === 'awaiting-approval') {
				const { confirmed } = await this.dialogService.confirm({
					type: 'info',
					message: localize('paradis.mobile.confirmSas', "モバイルデバイス「{0}」を接続しますか？", event.proposedName),
					detail: localize('paradis.mobile.confirmSasDetail', "モバイルアプリに表示されている確認コードが次の6桁と一致することを確認してください:\n\n    {0}\n\n一致しない場合は接続を拒否してください（第三者による中間者攻撃の可能性があります）。", event.sasCode),
					primaryButton: localize('paradis.mobile.approve', "接続を承認"),
					cancelButton: localize('paradis.mobile.reject', "拒否"),
				});
				if (confirmed) {
					await this.service.approvePairing();
				} else {
					await this.service.cancelPairing();
				}
			} else if (event.kind === 'paired') {
				pairingListener.clear();
				pairingPanel?.dispose();
				this.provider.pushState();
				this.notificationService.info(localize('paradis.mobile.paired', "モバイルデバイス「{0}」を接続しました。", event.deviceName));
			} else if (event.kind === 'failed') {
				pairingListener.clear();
				pairingPanel?.dispose();
				this.notificationService.warn(localize('paradis.mobile.pairFailed2', "ペアリングに失敗しました: {0}", event.reason));
			}
		});
	}

	/** ペアリングQRパネル（webviewエディタ）を開く。失敗時はダイアログにフォールバック。 */
	private openPairingPanel(deviceId: string, pairingUri: string): { dispose(): void } | undefined {
		const title = localize('paradis.mobile.pairingTitle', "モバイルデバイスを接続");
		try {
			const svg = qrToSvg(encodeQrCode(pairingUri), 6);
			const html = this.buildPairingHtml(title, deviceId, pairingUri, svg);
			const input = this.webviewWorkbenchService.openWebview(
				{
					providedViewType: 'paradis.mobilePairing',
					title,
					options: {},
					contentOptions: { allowScripts: false },
					extension: undefined,
				},
				'paradis.mobilePairing',
				title,
				undefined,
				{ group: ACTIVE_GROUP },
			);
			input.webview.setHtml(html);
			return input;
		} catch (err) {
			// QR生成/表示に失敗した場合はURIテキストのダイアログにフォールバック
			this.logService.warn('[paradisMobileRelay] failed to open pairing QR panel', err);
			this.dialogService.info(
				title,
				localize('paradis.mobile.pairingDetail', "Para Code Mobile アプリを開き、次のリンクを読み取るか貼り付けてください。5分間有効です。\n\nデバイスID: {0}\n\n{1}", deviceId, pairingUri),
			);
			return undefined;
		}
	}

	private buildPairingHtml(title: string, deviceId: string, pairingUri: string, qrSvg: string): string {
		const svgDataUri = `data:image/svg+xml;base64,${btoa(qrSvg)}`;
		const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; align-items: center; padding: 24px; }
	h2 { font-weight: 600; }
	.qr { background: #fff; padding: 8px; border-radius: 8px; margin: 16px 0; }
	.hint { color: var(--vscode-descriptionForeground); max-width: 560px; text-align: center; line-height: 1.7; }
	.uri { font-family: var(--vscode-editor-font-family); font-size: 11px; word-break: break-all; max-width: 640px; margin-top: 20px; padding: 10px 12px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; user-select: all; }
	.device { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 10px; }
</style></head>
<body>
	<h2>${esc(title)}</h2>
	<div class="hint">${esc(localize('paradis.mobile.pairingHint', "Para Code Mobile アプリで「QR を読み取る」を開き、このQRコードをスキャンしてください。読み取れない場合は下のリンクをコピーして貼り付けても接続できます。5分間有効です。"))}</div>
	<img class="qr" src="${svgDataUri}" alt="QR" />
	<div class="hint">${esc(localize('paradis.mobile.pairingSasHint', "読み取り後、モバイルに表示される6桁の確認コードとPC側ダイアログのコードが一致することを確認して承認してください。"))}</div>
	<div class="uri">${esc(pairingUri)}</div>
	<div class="device">${esc(localize('paradis.mobile.deviceIdLabel', "デバイスID: {0}", deviceId))}</div>
</body></html>`;
	}

	/** ペアリング済みデバイスの一覧・失効（コマンドから呼ばれる）。 */
	async manageDevices(): Promise<void> {
		const status = await this.service.getStatus();
		if (status.pairedDevices.length === 0) {
			this.notificationService.info(localize('paradis.mobile.noDevices', "ペアリング済みのモバイルデバイスはありません。"));
			return;
		}
		const picked = await this.quickInputService.pick(
			status.pairedDevices.map(name => ({
				label: name,
				description: localize('paradis.mobile.revokeDesc', "選択すると失効します"),
			})),
			{ placeHolder: localize('paradis.mobile.managePlaceholder', "失効するモバイルデバイスを選択（Escで閉じる）") },
		);
		if (!picked) {
			return;
		}
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('paradis.mobile.revokeConfirm', "モバイルデバイス「{0}」を失効させますか？", picked.label),
			detail: localize('paradis.mobile.revokeDetail', "失効すると、このデバイスからの接続はできなくなります。再接続には再ペアリングが必要です。"),
			primaryButton: localize('paradis.mobile.revoke', "失効"),
		});
		if (!confirmed) {
			return;
		}
		await this.service.revokeDevice(picked.label);
		this.notificationService.info(localize('paradis.mobile.revoked', "モバイルデバイス「{0}」を失効させました。", picked.label));
	}

	/**
	 * ステータスバークリック（およびコマンド）から開くアクションメニュー。
	 * デバイス接続 / 接続済みデバイスの解除 / リレーの有効・無効切り替え（＝PCとの接続を切る）を一箇所に集約する。
	 */
	async showActionMenu(): Promise<void> {
		const status = await this.service.getStatus();
		const enabled = this.isEnabled();
		type MenuItem = IQuickPickItem & { readonly action: 'pair' | 'manage' | 'disable' | 'enable' };
		const items: MenuItem[] = [];
		if (enabled) {
			items.push({
				action: 'pair',
				label: localize('paradis.mobile.menu.pair', "モバイルデバイスを接続…"),
				description: localize('paradis.mobile.menu.pairDesc', "QRコードで新しいデバイスをペアリング"),
			});
			if (status.pairedDevices.length > 0) {
				items.push({
					action: 'manage',
					label: localize('paradis.mobile.menu.manage', "接続済みデバイスを解除…"),
					description: localize('paradis.mobile.menu.manageDesc', "{0}台がペアリング済み", status.pairedDevices.length),
				});
			}
			items.push({
				action: 'disable',
				label: localize('paradis.mobile.menu.disable', "リレーを無効にする（接続を切る）"),
				description: localize('paradis.mobile.menu.disableDesc', "モバイルとの接続を切断し、待機を停止します"),
			});
		} else {
			items.push({
				action: 'enable',
				label: localize('paradis.mobile.menu.enable', "リレーを有効にする"),
				description: localize('paradis.mobile.menu.enableDesc', "モバイルからの接続を待機します"),
			});
		}
		const picked = await this.quickInputService.pick(items, {
			placeHolder: localize('paradis.mobile.menu.placeholder', "Para Code Mobile"),
		});
		if (!picked) {
			return;
		}
		switch (picked.action) {
			case 'pair':
				await this.runPairing();
				break;
			case 'manage':
				await this.manageDevices();
				break;
			case 'disable':
				await this.configurationService.updateValue(PARADIS_MOBILE_ENABLED_KEY, false);
				this.notificationService.info(localize('paradis.mobile.disabled', "モバイルリレーを無効にしました。モバイルからの接続はできなくなります。"));
				break;
			case 'enable':
				await this.configurationService.updateValue(PARADIS_MOBILE_ENABLED_KEY, true);
				break;
		}
	}
}

registerWorkbenchContribution2(ParadisMobileRelayContribution.ID, ParadisMobileRelayContribution, WorkbenchPhase.AfterRestored);

class ParadisConnectMobileDeviceAction extends Action2 {
	constructor() {
		super({
			id: PAIR_COMMAND,
			title: localize2('paradis.mobile.connectDevice', "Connect Mobile Device"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(_accessor: ServicesAccessor): Promise<void> {
		await ParadisMobileRelayContribution.instance?.runPairing();
	}
}
registerAction2(ParadisConnectMobileDeviceAction);

class ParadisManageMobileDevicesAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.mobile.manageDevices',
			title: localize2('paradis.mobile.manageDevices', "Manage Mobile Devices"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(_accessor: ServicesAccessor): Promise<void> {
		await ParadisMobileRelayContribution.instance?.manageDevices();
	}
}
registerAction2(ParadisManageMobileDevicesAction);

class ParadisMobileMenuAction extends Action2 {
	constructor() {
		super({
			id: MENU_COMMAND,
			title: localize2('paradis.mobile.showMenu', "Mobile Relay Menu"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(_accessor: ServicesAccessor): Promise<void> {
		await ParadisMobileRelayContribution.instance?.showActionMenu();
	}
}
registerAction2(ParadisMobileMenuAction);
