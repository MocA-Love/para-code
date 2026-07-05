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
import { IFileService } from '../../../../platform/files/common/files.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWebviewWorkbenchService } from '../../../../workbench/contrib/webviewPanel/browser/webviewWorkbenchService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ACTIVE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { encodeQrCode, qrToSvg } from '../common/paradisQrCode.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
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
	private previousOnlineMobiles = 0;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
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
		@ILanguageService languageService: ILanguageService,
		@IExtensionService extensionService: IExtensionService,
		@IThemeService themeService: IThemeService,
	) {
		super();

		ParadisMobileRelayContribution.instance = this;
		this._register({ dispose: () => { if (ParadisMobileRelayContribution.instance === this) { ParadisMobileRelayContribution.instance = undefined; } } });

		this.service = ProxyChannel.toService<IParadisMobileRelayService>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));

		this.provider = this._register(new ParadisMobileWorkspaceProvider(
			frame => { this.service.sendFrame(frame.ch, frame.ws, frame.mobileId, frame.payload).catch(err => this.logService.warn('[paradisMobileRelay] sendFrame failed', err)); },
			workspaceSwitchService,
			terminalService,
			terminalGroupService,
			terminalScopeService,
			worktreeService,
			agentStatusStore,
			this.logService,
			fileService,
			languageService,
			extensionService,
			themeService,
			sharedProcessService,
			(repoPath, args) => this.service.runGit(repoPath, args),
		));

		// shared process が復号したモバイル→PCフレームを provider へ。
		this._register(this.service.onInboundFrame(([ch, ws, seq, payload, mobileId]) => this.provider.handleInbound({ ch, ws, seq, payload, mobileId })));

		// 接続状態をステータスバーに反映。オンラインのモバイルが0になったら端末購読を解放。
		// 0 → 非0 に転じた（新規ペアリングに限らず、PC再起動後の自動再接続なども含む）
		// 瞬間には、そのモバイルはまだ最新状態を持っていないため改めて1回 push する。
		this._register(this.service.onDidChangeStatus(status => {
			this.renderStatusbar(status);
			if (status.onlineMobiles === 0) {
				this.provider.detachAll();
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
