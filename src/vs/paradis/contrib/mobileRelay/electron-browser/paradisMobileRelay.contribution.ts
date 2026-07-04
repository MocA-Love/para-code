/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize, localize2 } from '../../../../nls.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisMobileRelayService,
	IParadisMobileStatus,
	PARADIS_MOBILE_ENABLED_KEY,
	PARADIS_MOBILE_RELAY_CHANNEL,
	PARADIS_MOBILE_RELAY_URL_KEY,
} from '../common/paradisMobileRelay.js';
import { ParadisMobileWorkspaceProvider } from './paradisMobileWorkspaceProvider.js';

const STATUSBAR_ID = 'paradis.mobile.relay';
const PAIR_COMMAND = 'paradis.mobile.connectDevice';

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

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ILogService private readonly logService: ILogService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@ITerminalService terminalService: ITerminalService,
		@IParadisTerminalScopeService terminalScopeService: IParadisTerminalScopeService,
		@IParadisAgentStatusStore agentStatusStore: IParadisAgentStatusStore,
	) {
		super();

		ParadisMobileRelayContribution.instance = this;
		this._register({ dispose: () => { if (ParadisMobileRelayContribution.instance === this) { ParadisMobileRelayContribution.instance = undefined; } } });

		this.service = ProxyChannel.toService<IParadisMobileRelayService>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));

		this.provider = this._register(new ParadisMobileWorkspaceProvider(
			frame => { this.service.sendFrame(frame).catch(err => this.logService.warn('[paradisMobileRelay] sendFrame failed', err)); },
			workspaceSwitchService,
			terminalService,
			terminalScopeService,
			agentStatusStore,
			this.logService,
		));

		// shared process が復号したモバイル→PCフレームを provider へ。
		this._register(this.service.onInboundFrame(frame => this.provider.handleInbound(frame)));

		// 接続状態をステータスバーに反映。オンラインのモバイルが0になったら端末購読を解放。
		this._register(this.service.onDidChangeStatus(status => {
			this.renderStatusbar(status);
			if (status.onlineMobiles === 0) {
				this.provider.detachAll();
			}
		}));

		// ペアリング成立時に通知 + 状態を1回送る。
		this._register(this.service.onPairingEvent(() => { /* ダイアログ側で処理。ここではno-op */ }));

		// shared process を現在の設定で初期化。
		const enabled = this.isEnabled();
		const relayUrl = this.configurationService.getValue<string>(PARADIS_MOBILE_RELAY_URL_KEY);
		this.initialize(enabled, relayUrl);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_MOBILE_ENABLED_KEY)) {
				this.service.setEnabled(this.isEnabled()).catch(err => this.logService.warn('[paradisMobileRelay] setEnabled failed', err));
			}
		}));

		this.service.getStatus().then(status => this.renderStatusbar(status)).catch(() => { /* ignore */ });
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_MOBILE_ENABLED_KEY) === true;
	}

	private async initialize(enabled: boolean, relayUrl: string | undefined): Promise<void> {
		try {
			await this.service.initialize(enabled, relayUrl);
			// オンラインになったら状態を1回 push。
			this.provider.pushState();
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] initialize failed', err);
		}
	}

	private renderStatusbar(status: IParadisMobileStatus): void {
		if (status.state === 'disabled') {
			this.statusbarEntry.clear();
			return;
		}
		const online = status.onlineMobiles > 0;
		const label = status.state === 'online'
			? (online ? localize('paradis.mobile.statusbar.active', "モバイル接続中 ({0})", status.onlineMobiles) : localize('paradis.mobile.statusbar.ready', "モバイル待機中"))
			: localize('paradis.mobile.statusbar.connecting', "モバイル接続中…");
		const icon = status.state === 'online' ? '$(radio-tower)' : '$(sync~spin)';
		const entry = {
			name: localize('paradis.mobile.statusbar.name', "Para Code Mobile"),
			text: `${icon} ${label}`,
			ariaLabel: label,
			tooltip: localize('paradis.mobile.statusbar.tooltip', "Para Code Mobile のリレー接続状態。クリックでデバイスを接続します。"),
			command: PAIR_COMMAND,
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

		// SAS確認を待つ。onPairingEvent の 'awaiting-approval' で確認ダイアログを出す。
		const pairingListener = this._register(new MutableDisposable());
		pairingListener.value = this.service.onPairingEvent(async event => {
			if (event.kind === 'awaiting-approval') {
				pairingListener.clear();
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
				this.notificationService.info(localize('paradis.mobile.paired', "モバイルデバイス「{0}」を接続しました。", event.deviceName));
			} else if (event.kind === 'failed') {
				this.notificationService.warn(localize('paradis.mobile.pairFailed2', "ペアリングに失敗しました: {0}", event.reason));
			}
		});

		// QR/URI を表示（QRコード描画ライブラリは未同梱のため、当面はディープリンクURIと
		// deviceId を提示し、モバイルアプリでのQRスキャン or URIペーストに対応する。SAS確認で安全性を担保）。
		await this.dialogService.info(
			localize('paradis.mobile.pairingTitle', "モバイルデバイスを接続"),
			localize('paradis.mobile.pairingDetail', "Para Code Mobile アプリを開き、次のリンクを読み取るか貼り付けてください。5分間有効です。\n\nデバイスID: {0}\n\n{1}", session.deviceId, session.pairingUri),
		);
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
