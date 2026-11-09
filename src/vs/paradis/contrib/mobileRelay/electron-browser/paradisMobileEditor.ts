/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「モバイル」のタブ（Q597 の案 A: 1 枚に並べる）。上に札・状態・ボタン、中にペアリングした端末の表、下に設定。
// 「タスク」のタブと同じ並びと見た目。中身はリレー（shared process）の状態を paradisBuildMobileTabModel で
// 組み立てて描くだけで、ペアリング・解除・鍵の読み直しは contribution の既存の処理（コマンド）を呼ぶ。
// 新しく接続の QR は今のモーダル（paradisMobilePairingDialog.ts）のまま。

import './media/paradisMobileEditor.css';
import * as dom from '../../../../base/browser/dom.js';
import { Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { ParadisSwitch } from '../../../browser/paradisSwitch.js';
import { IParadisNotificationsSettingsService } from '../../notifications/browser/paradisNotificationsSettings.js';
import { IParadisDoNotDisturbRefreshState, paradisCreateDoNotDisturbRefreshController, paradisFormatDoNotDisturbRemaining } from '../../notifications/common/paradisDoNotDisturb.js';
import {
	IParadisMobileDeviceNotifySettings,
	IParadisMobileRelayService,
	IParadisMobileStatus,
	PARADIS_MOBILE_DEFAULT_RELAY_URL,
	PARADIS_MOBILE_DEVICE_ALIAS_MAX_LENGTH,
	PARADIS_MOBILE_ENABLED_KEY,
	PARADIS_MOBILE_PC_NAME_KEY,
	PARADIS_MOBILE_RELAY_CHANNEL,
	PARADIS_MOBILE_RELAY_URL_KEY,
} from '../common/paradisMobileRelay.js';
import { IParadisMobileTabDevice, IParadisMobileTabModel, ParadisMobileTabState, paradisBuildMobileTabModel } from '../common/paradisMobileTabModel.js';
import {
	PARADIS_MOBILE_CONNECT_DEVICE_COMMAND_ID,
	PARADIS_MOBILE_EDITOR_ID,
	PARADIS_MOBILE_RETRY_STORE_COMMAND_ID,
	PARADIS_MOBILE_REVOKE_DEVICE_COMMAND_ID,
} from './paradisMobileEditorInput.js';

const $ = dom.$;

/** 「設定 (Para Code)」のモバイルの節を開く（paradisSettingsDialog.contribution.ts）。 */
const OPEN_PARADIS_SETTINGS_COMMAND_ID = 'paradis.openSettingsDialog';
const PARADIS_SETTINGS_MOBILE_SECTION_ID = 'psd-sec-mobile';
/** 通知の設定のおやすみモードの節を開く（paradisNotificationSettingsDialog.contribution.ts）。 */
const OPEN_NOTIFICATION_SETTINGS_COMMAND_ID = 'paradis.notifications.openSettings';
const NOTIFICATION_SETTINGS_DND_SECTION_ID = 'pns-sec-dnd';
/** 接続の計測（paradisMobileLinkMetrics.contribution.ts）。 */
const START_LINK_METRICS_COMMAND_ID = 'paradis.mobile.startLinkMetrics';
const STOP_LINK_METRICS_COMMAND_ID = 'paradis.mobile.stopLinkMetrics';
const EXPORT_LINK_METRICS_COMMAND_ID = 'paradis.mobile.exportLinkMetrics';

type ParadisMobileTone = 'ok' | 'warn' | 'err' | 'acc' | 'off';

/** 上の札（ステータスバーの項目と同じ言い方）。 */
function chipOf(model: IParadisMobileTabModel): { readonly icon: ThemeIcon; readonly label: string; readonly tone: ParadisMobileTone } {
	switch (model.state) {
		case 'disabled':
			return { icon: Codicon.circleSlash, label: localize('paradis.mobileTab.chip.disabled', "リレー無効"), tone: 'off' };
		case 'storeUnreadable':
		case 'storeUndecryptable':
			return { icon: Codicon.error, label: localize('paradis.mobileTab.chip.store', "モバイル: 鍵を読み込めません"), tone: 'err' };
		case 'unauthorized':
			return { icon: Codicon.warning, label: localize('paradis.mobileTab.chip.unauthorized', "モバイル: 再ペアリングが必要"), tone: 'warn' };
		case 'connecting':
			return { icon: ThemeIcon.modify(Codicon.loading, 'spin'), label: localize('paradis.mobileTab.chip.connecting', "接続中…"), tone: 'acc' };
		case 'disconnected':
			return { icon: Codicon.debugDisconnect, label: localize('paradis.mobileTab.chip.disconnected', "切断中 · 自動で再接続します"), tone: 'warn' };
		case 'unregistered':
			return { icon: Codicon.circleOutline, label: localize('paradis.mobileTab.chip.unregistered', "まだペアリングしていません"), tone: 'off' };
		case 'waiting':
			return { icon: Codicon.circleFilled, label: localize('paradis.mobileTab.chip.waiting', "モバイル待機中"), tone: 'ok' };
		case 'connected':
			return { icon: Codicon.circleFilled, label: localize('paradis.mobileTab.chip.connected', "モバイル接続中 ({0})", model.onlineCount), tone: 'ok' };
	}
}

/** 通知の列の 4 つ（アプリの設定の並び）。 */
function notifyItems(notify: IParadisMobileDeviceNotifySettings): readonly { readonly icon: ThemeIcon; readonly label: string; readonly on: boolean }[] {
	return [
		{ icon: Codicon.check, label: localize('paradis.mobileTab.notify.agentDone', "作業が終わったとき"), on: notify.agentDone },
		{ icon: Codicon.bell, label: localize('paradis.mobileTab.notify.agentQuestion', "質問・許可を待つとき"), on: notify.agentQuestion },
		{ icon: Codicon.deviceDesktop, label: localize('paradis.mobileTab.notify.pcFocusQuiet', "PC を操作中は鳴らさない"), on: notify.pcFocusQuiet },
		{ icon: Codicon.info, label: localize('paradis.mobileTab.notify.includeContent', "通知に中身を含める"), on: notify.includeContent },
	];
}

function onOff(on: boolean): string {
	return on ? localize('paradis.mobileTab.on', "オン") : localize('paradis.mobileTab.off', "オフ");
}

/** 端末 ID などを短く見せる（先頭と末尾の 4 文字）。 */
function shortId(id: string): string {
	return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

export class ParadisMobileEditor extends EditorPane {

	static readonly ID = PARADIS_MOBILE_EDITOR_ID;

	private readonly service: IParadisMobileRelayService;
	private status: IParadisMobileStatus | undefined;
	/** 状態の通知を受けた回数（読み直しの応答が、後から届いた通知を古い値で上書きしないため）。 */
	private statusEvents = 0;
	private linkMetricsEnabled = false;

	private root: HTMLElement | undefined;
	private chip!: HTMLElement;
	private pairButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;
	private infoLine!: HTMLElement;
	private bannerHost!: HTMLElement;
	private devicesHeading!: HTMLElement;
	private devicesHost!: HTMLElement;
	private enabledSwitch!: ParadisSwitch;
	private pcNameInput!: HTMLInputElement;
	private relayUrlInput!: HTMLInputElement;
	private doNotDisturbText!: HTMLElement;
	private metricsSwitch!: ParadisSwitch;
	/** 描き直すたびに作り直す部品（お知らせのボタン・表の行）の listener と hover。 */
	private readonly bannerDisposables = this._register(new DisposableStore());
	private readonly deviceDisposables = this._register(new DisposableStore());
	private readonly doNotDisturbRefresh;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@IHoverService private readonly hoverService: IHoverService,
		@IParadisNotificationsSettingsService notificationsSettingsService: IParadisNotificationsSettingsService,
	) {
		super(PARADIS_MOBILE_EDITOR_ID, group, telemetryService, themeService, storageService);
		this.service = ProxyChannel.toService<IParadisMobileRelayService>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
		this._register(this.service.onDidChangeStatus(status => {
			this.statusEvents++;
			this.status = status;
			this.update();
		}));
		this._register(this.service.onDidChangeLinkMetricsEnabled(enabled => {
			this.linkMetricsEnabled = enabled;
			this.update();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_MOBILE_ENABLED_KEY) || e.affectsConfiguration(PARADIS_MOBILE_PC_NAME_KEY) || e.affectsConfiguration(PARADIS_MOBILE_RELAY_URL_KEY)) {
				this.update();
			}
		}));
		// おやすみモードは期限が来ても変更の通知が出ないので、ステータスバーと同じ期限つきの読み直しで追う
		this.doNotDisturbRefresh = this._register(paradisCreateDoNotDisturbRefreshController(now => {
			const state = notificationsSettingsService.getDoNotDisturb();
			this.renderDoNotDisturb(state, now);
			return state;
		}));
		this._register(notificationsSettingsService.onDidChangeDoNotDisturb(() => this.doNotDisturbRefresh.refresh()));
	}

	protected override createEditor(parent: HTMLElement): void {
		const root = this.root = dom.append(parent, $('.paradis-mobile'));
		root.tabIndex = -1;

		const header = dom.append(root, $('.paradis-mobile-row'));
		const sourceIcon = dom.append(header, $('span.paradis-mobile-source-icon'));
		sourceIcon.append(...this.icon(Codicon.deviceMobile));
		dom.append(header, $('span.paradis-mobile-title')).textContent = 'Para Code Mobile';
		this.chip = dom.append(header, $('span.paradis-mobile-chip'));
		dom.append(header, $('span.paradis-mobile-grow'));
		this.pairButton = this.button(header, localize('paradis.mobileTab.pair', "新しく接続"), () => this.pair(), 'paradis-mobile-pill.primary', Codicon.add);
		this.stopButton = this.button(header, localize('paradis.mobileTab.stop', "リレーを止める"), () => void this.setEnabled(false), 'paradis-mobile-pill.paradis-mobile-hide-narrow', Codicon.circleSlash);
		this.iconButton(header, Codicon.refresh, localize('paradis.mobileTab.refresh', "更新"), () => void this.reload());

		this.infoLine = dom.append(root, $('.paradis-mobile-info'));
		this.bannerHost = dom.append(root, $('.paradis-mobile-banner-host'));

		this.devicesHeading = dom.append(root, $('.paradis-mobile-section'));
		this.devicesHost = dom.append(root, $('.paradis-mobile-devices'));

		const settingsHeading = dom.append(root, $('.paradis-mobile-section'));
		dom.append(settingsHeading, $('span')).textContent = localize('paradis.mobileTab.settings', "設定");
		dom.append(settingsHeading, $('span.paradis-mobile-section-line'));
		this.button(settingsHeading, localize('paradis.mobileTab.openParadisSettings', "設定 (Para Code) で開く"), () => void this.commandService.executeCommand(OPEN_PARADIS_SETTINGS_COMMAND_ID, PARADIS_SETTINGS_MOBILE_SECTION_ID), 'paradis-mobile-link');
		this.createSettings(dom.append(root, $('.paradis-mobile-box')));

		this.update();
		this.doNotDisturbRefresh.refresh();
		void this.reload();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible && this.root) {
			// 最終接続の「〜分前」を見えるたびに今に合わせる
			void this.reload();
		}
	}

	override layout(_dimension: dom.Dimension): void {
		// 表と設定の行は CSS（@container）で幅に合わせる
	}

	override focus(): void {
		super.focus();
		this.root?.focus();
	}

	private async reload(): Promise<void> {
		const before = this.statusEvents;
		const [status, linkMetricsEnabled] = await Promise.all([
			this.service.getStatus(),
			this.service.getLinkMetricsEnabled().catch(() => this.linkMetricsEnabled),
		]);
		if (before === this.statusEvents) {
			this.status = status;
		}
		this.linkMetricsEnabled = linkMetricsEnabled;
		this.update();
	}

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_MOBILE_ENABLED_KEY) === true;
	}

	private async setEnabled(enabled: boolean): Promise<void> {
		await this.configurationService.updateValue(PARADIS_MOBILE_ENABLED_KEY, enabled);
	}

	private pair(): void {
		void this.commandService.executeCommand(PARADIS_MOBILE_CONNECT_DEVICE_COMMAND_ID);
	}

	/** 状態・設定が変わったときに、作ってある部品の中身だけを入れ替える（入力中の欄は書き換えない）。 */
	private update(): void {
		if (!this.root) {
			return;
		}
		const enabled = this.enabled;
		this.enabledSwitch.checked = enabled;
		this.metricsSwitch.checked = this.linkMetricsEnabled;
		this.syncInput(this.pcNameInput, this.configurationService.getValue<string>(PARADIS_MOBILE_PC_NAME_KEY) ?? '');
		this.syncInput(this.relayUrlInput, this.relayUrlOverride() ?? '');

		const status = this.status;
		if (!status) {
			this.renderChip(Codicon.loading, localize('paradis.mobileTab.chip.loading', "読み込み中…"), 'off');
			dom.setVisibility(false, this.pairButton, this.stopButton, this.devicesHeading, this.devicesHost);
			return;
		}
		const model = paradisBuildMobileTabModel(status, enabled);
		const chip = chipOf(model);
		this.renderChip(chip.icon, chip.label, chip.tone);
		dom.setVisibility(model.canPair, this.pairButton);
		dom.setVisibility(model.canStop, this.stopButton);
		this.renderInfo(status, model.state);
		this.renderBanner(model);
		this.renderDevices(model);
	}

	private renderChip(icon: ThemeIcon, label: string, tone: ParadisMobileTone): void {
		dom.clearNode(this.chip);
		this.chip.className = `paradis-mobile-chip ${tone}`;
		this.chip.append(...this.icon(icon));
		dom.append(this.chip, $('span')).textContent = label;
	}

	/** 「この PC: 名前 · リレー: 既定 · PC の ID」の 1 行。 */
	private renderInfo(status: IParadisMobileStatus, state: ParadisMobileTabState): void {
		const pcName = status.pcName ?? (this.configurationService.getValue<string>(PARADIS_MOBILE_PC_NAME_KEY)?.trim() || localize('paradis.mobileTab.hostName', "(ホスト名)"));
		const override = this.relayUrlOverride();
		let relay = localize('paradis.mobileTab.relayDefault', "既定");
		if (override !== undefined) {
			try {
				relay = new URL(override).host || override;
			} catch {
				relay = override;
			}
		}
		const parts = [
			localize('paradis.mobileTab.thisPc', "この PC: {0}", pcName),
			localize('paradis.mobileTab.relay', "リレー: {0}", relay),
		];
		if (status.deviceId !== undefined && state !== 'disabled') {
			parts.push(localize('paradis.mobileTab.pcId', "PC の ID {0}", shortId(status.deviceId)));
		}
		this.infoLine.textContent = parts.join(' · ');
	}

	/** 設定の上書きがあればその URL（既定のリレーと同じ・空なら undefined）。 */
	private relayUrlOverride(): string | undefined {
		const value = this.configurationService.getValue<string>(PARADIS_MOBILE_RELAY_URL_KEY)?.trim();
		return value && value.replace(/\/$/, '') !== PARADIS_MOBILE_DEFAULT_RELAY_URL ? value : undefined;
	}

	private renderBanner(model: IParadisMobileTabModel): void {
		this.bannerDisposables.clear();
		dom.clearNode(this.bannerHost);
		const banner = (tone: 'warn' | 'err' | 'info', icon: ThemeIcon, text: string) => {
			const element = dom.append(this.bannerHost, $(`.paradis-mobile-banner.${tone}`));
			element.append(...this.icon(icon));
			dom.append(element, $('.paradis-mobile-banner-text')).textContent = text;
			return dom.append(element, $('.paradis-mobile-banner-actions'));
		};
		switch (model.state) {
			case 'storeUnreadable': {
				const actions = banner('err', Codicon.error, localize('paradis.mobileTab.banner.unreadable', "保存した鍵とペアリングの台帳を読み込めないため、接続を止めています。ファイルを読めるようにしてから読み込み直すか、作り直してください（作り直すと、ペアリングした端末はすべて解除されます）。"));
				this.button(actions, localize('paradis.mobileTab.banner.retry', "読み込み直す"), () => void this.commandService.executeCommand(PARADIS_MOBILE_RETRY_STORE_COMMAND_ID), 'paradis-mobile-pill', Codicon.refresh, this.bannerDisposables);
				this.button(actions, localize('paradis.mobileTab.banner.recreate', "作り直す…"), () => this.pair(), 'paradis-mobile-pill.danger', undefined, this.bannerDisposables);
				return;
			}
			case 'storeUndecryptable': {
				const actions = banner('err', Codicon.error, localize('paradis.mobileTab.banner.undecryptable', "保存した鍵を復号できないため、接続を止めています。キーチェーンへのアクセスを許可してから Para Code を再起動してください。"));
				this.button(actions, localize('paradis.mobileTab.banner.restart', "再起動"), () => void this.hostService.restart(), 'paradis-mobile-pill', undefined, this.bannerDisposables);
				this.button(actions, localize('paradis.mobileTab.banner.recreate2', "作り直す…"), () => this.pair(), 'paradis-mobile-pill.danger', undefined, this.bannerDisposables);
				return;
			}
			case 'unauthorized': {
				const actions = banner('warn', Codicon.warning, model.pairedCount > 0
					? localize('paradis.mobileTab.banner.unauthorized', "リレーがこの PC の資格情報を受け付けませんでした。登録をやり直すと、ペアリング済みの {0} 台はすべて解除され、各端末で接続し直します。", model.pairedCount)
					: localize('paradis.mobileTab.banner.unauthorizedEmpty', "リレーがこの PC の資格情報を受け付けませんでした。登録をやり直してから、あらためてペアリングします。"));
				this.button(actions, localize('paradis.mobileTab.banner.reset', "登録をやり直す…"), () => this.pair(), 'paradis-mobile-pill.primary', undefined, this.bannerDisposables);
				return;
			}
			case 'disabled': {
				const actions = banner('info', Codicon.info, localize('paradis.mobileTab.banner.disabled', "リレーを止めています。モバイルからこの PC へは接続できません。ペアリングした端末はそのまま残ります。"));
				this.button(actions, localize('paradis.mobileTab.banner.enable', "有効にする"), () => void this.setEnabled(true), 'paradis-mobile-pill.primary', undefined, this.bannerDisposables);
				return;
			}
			case 'disconnected':
				banner('warn', Codicon.debugDisconnect, localize('paradis.mobileTab.banner.disconnected', "リレーとの接続が切れています。ネットワークが戻ると自動で接続し直します。"));
				return;
		}
	}

	private renderDevices(model: IParadisMobileTabModel): void {
		this.deviceDisposables.clear();
		dom.clearNode(this.devicesHeading);
		dom.clearNode(this.devicesHost);
		const devices = model.devices;
		// 鍵と台帳を読めないときは台帳が手元に無い。0 台と見せずに、お知らせだけにする
		dom.setVisibility(devices !== undefined, this.devicesHeading, this.devicesHost);
		if (!devices) {
			return;
		}
		dom.append(this.devicesHeading, $('span')).textContent = localize('paradis.mobileTab.devices', "ペアリングした端末（{0}）", devices.length);
		dom.append(this.devicesHeading, $('span.paradis-mobile-section-line'));
		this.devicesHost.classList.toggle('dimmed', model.dimDevices);

		if (devices.length === 0) {
			const empty = dom.append(this.devicesHost, $('.paradis-mobile-empty'));
			empty.append(...this.icon(Codicon.deviceMobile));
			dom.append(empty, $('.paradis-mobile-empty-title')).textContent = localize('paradis.mobileTab.empty.title', "まだ端末をペアリングしていません");
			dom.append(empty, $('.paradis-mobile-empty-body')).textContent = localize('paradis.mobileTab.empty.body', "iPhone・iPad に Para Code Mobile を入れ、「新しく接続」で出る QR を読み取ると、外からこの PC のエージェントやターミナルを操作できます。");
			const button = this.button(empty, localize('paradis.mobileTab.pair2', "新しく接続"), () => this.pair(), 'paradis-mobile-pill.primary', Codicon.add, this.deviceDisposables);
			button.disabled = !model.canPair;
			return;
		}

		const table = dom.append(this.devicesHost, $('table.paradis-mobile-table'));
		const head = dom.append(dom.append(table, $('thead')), $('tr'));
		for (const [label, className] of [
			[localize('paradis.mobileTab.column.device', "端末"), 'device'],
			[localize('paradis.mobileTab.column.state', "状態"), 'state'],
			[localize('paradis.mobileTab.column.lastSeen', "最終接続"), 'last'],
			[localize('paradis.mobileTab.column.notify', "通知"), 'notify'],
			['', 'actions'],
		] as const) {
			dom.append(head, $(`th.${className}`)).textContent = label;
		}
		const body = dom.append(table, $('tbody'));
		for (const device of devices) {
			this.renderDevice(body, device);
		}
	}

	private renderDevice(body: HTMLElement, device: IParadisMobileTabDevice): void {
		const row = dom.append(body, $('tr'));

		const nameCell = dom.append(dom.append(row, $('td.device')), $('.paradis-mobile-device'));
		nameCell.append(...this.icon(Codicon.deviceMobile));
		const text = dom.append(nameCell, $('.paradis-mobile-device-text'));
		dom.append(text, $('.paradis-mobile-device-name')).textContent = device.displayName;
		const meta: string[] = [];
		if (device.deviceName !== undefined) {
			meta.push(localize('paradis.mobileTab.deviceName', "端末の名前: {0}", device.deviceName));
		}
		meta.push(device.pairedAt !== undefined
			? localize('paradis.mobileTab.pairedAt', "ペアした日 {0}", new Date(device.pairedAt).toLocaleDateString())
			: localize('paradis.mobileTab.pairedAtUnknown', "ペアした日 不明"));
		dom.append(text, $('.paradis-mobile-device-meta')).textContent = meta.join(' · ');

		const presence = dom.append(dom.append(row, $('td.state')), $(`span.paradis-mobile-presence${device.online ? '.on' : ''}`));
		dom.append(presence, $('span.paradis-mobile-dot'));
		dom.append(presence, $('span')).textContent = device.online ? localize('paradis.mobileTab.online', "オンライン") : localize('paradis.mobileTab.offline', "オフライン");

		const last = dom.append(row, $('td.last'));
		if (device.online) {
			last.textContent = localize('paradis.mobileTab.lastSeenNow', "今");
		} else if (device.lastSeenAt !== undefined) {
			last.textContent = fromNow(device.lastSeenAt, true);
			this.deviceDisposables.add(this.hoverService.setupDelayedHover(last, { content: new Date(device.lastSeenAt).toLocaleString() }));
		} else {
			last.textContent = localize('paradis.mobileTab.lastSeenUnknown', "不明");
		}

		const notifyCell = dom.append(row, $('td.notify'));
		if (device.notify) {
			const icons = dom.append(notifyCell, $('span.paradis-mobile-notify'));
			for (const item of notifyItems(device.notify)) {
				const icon = dom.append(icons, $(`span${ThemeIcon.asCSSSelector(item.icon)}${item.on ? '.on' : ''}`));
				const description = localize('paradis.mobileTab.notifyItem', "{0}: {1}", item.label, onOff(item.on));
				icon.setAttribute('aria-label', description);
				this.deviceDisposables.add(this.hoverService.setupDelayedHover(icon, { content: description }));
			}
		} else {
			dom.append(notifyCell, $('span.paradis-mobile-faint')).textContent = '-';
		}

		const actions = dom.append(row, $('td.actions'));
		this.iconButton(actions, Codicon.ellipsis, localize('paradis.mobileTab.rowActions', "操作"), event => this.showDeviceMenu(device, event), this.deviceDisposables);
	}

	private showDeviceMenu(device: IParadisMobileTabDevice, event: MouseEvent): void {
		const anchor = dom.isHTMLElement(event.currentTarget) ? event.currentTarget : event.target as HTMLElement;
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({ id: 'paradis.mobileTab.rename', label: localize('paradis.mobileTab.rename', "名前を変更…"), run: () => this.renameDevice(device) }),
				toAction({ id: 'paradis.mobileTab.showNotify', label: localize('paradis.mobileTab.showNotify', "通知の設定を見る"), enabled: device.notify !== undefined, run: () => this.showNotifySettings(device) }),
				toAction({ id: 'paradis.mobileTab.copyId', label: localize('paradis.mobileTab.copyId', "端末 ID をコピー"), run: () => this.clipboardService.writeText(device.mobileId) }),
				new Separator(),
				toAction({ id: 'paradis.mobileTab.revoke', label: localize('paradis.mobileTab.revoke', "解除…"), run: () => this.commandService.executeCommand(PARADIS_MOBILE_REVOKE_DEVICE_COMMAND_ID, device.mobileId) }),
			],
		});
	}

	private async renameDevice(device: IParadisMobileTabDevice): Promise<void> {
		const original = device.deviceName ?? device.displayName;
		const value = await this.quickInputService.input({
			value: device.displayName,
			prompt: localize('paradis.mobileTab.renamePrompt', "この PC で表示する名前。空にすると端末の名前（{0}）に戻します。", original),
			validateInput: async input => input.trim().length > PARADIS_MOBILE_DEVICE_ALIAS_MAX_LENGTH
				? localize('paradis.mobileTab.renameTooLong', "{0} 文字以内で入力してください。", PARADIS_MOBILE_DEVICE_ALIAS_MAX_LENGTH)
				: undefined,
		});
		if (value === undefined) {
			return;
		}
		const alias = value.trim() === original ? undefined : value;
		try {
			await this.service.renameDevice(device.mobileId, alias);
		} catch (error) {
			this.notificationService.error(localize('paradis.mobileTab.renameFailed', "名前を変更できませんでした: {0}", String(error)));
		}
	}

	private showNotifySettings(device: IParadisMobileTabDevice): void {
		if (!device.notify) {
			return;
		}
		const lines = notifyItems(device.notify).map(item => localize('paradis.mobileTab.notifyLine', "{0}: {1}", item.label, onOff(item.on)));
		void this.dialogService.info(
			localize('paradis.mobileTab.notifyTitle', "「{0}」の通知", device.displayName),
			[...lines, '', localize('paradis.mobileTab.notifyHint', "通知の設定は Para Code Mobile の設定で変えます。")].join('\n'),
		);
	}

	private createSettings(box: HTMLElement): void {
		const enabledRow = this.settingRow(box, 'paradis-mobile-setting-enabled', localize('paradis.mobileTab.setting.enabled', "モバイルアプリからの接続を許可する"), localize('paradis.mobileTab.setting.enabledDesc', "オフにすると今の接続を切り、待ち受けを止めます。ペアリングした端末は残ります。"));
		this.enabledSwitch = this._register(new ParadisSwitch(enabledRow.value, { checked: this.enabled, ariaLabelledBy: enabledRow.titleId }));
		this._register(this.enabledSwitch.onDidChange(checked => void this.setEnabled(checked)));

		const pcNameRow = this.settingRow(box, 'paradis-mobile-setting-pc-name', localize('paradis.mobileTab.setting.pcName', "モバイルに表示する PC 名"), localize('paradis.mobileTab.setting.pcNameDesc', "複数の PC とペアリングしているときの見分けに使います。"), true);
		this.pcNameInput = this.textInput(pcNameRow.value, pcNameRow.titleId, localize('paradis.mobileTab.setting.pcNamePlaceholder', "(ホスト名)"),
			() => this.configurationService.getValue<string>(PARADIS_MOBILE_PC_NAME_KEY) ?? '',
			value => this.configurationService.updateValue(PARADIS_MOBILE_PC_NAME_KEY, value || undefined));

		const doNotDisturbRow = this.settingRow(box, 'paradis-mobile-setting-dnd', localize('paradis.mobileTab.setting.dnd', "おやすみモード"), '');
		this.doNotDisturbText = doNotDisturbRow.description;
		this.button(doNotDisturbRow.value, localize('paradis.mobileTab.setting.dndOpen', "通知の設定を開く"), () => void this.commandService.executeCommand(OPEN_NOTIFICATION_SETTINGS_COMMAND_ID, NOTIFICATION_SETTINGS_DND_SECTION_ID), 'paradis-mobile-link');

		const relayRow = this.settingRow(box, 'paradis-mobile-setting-relay', localize('paradis.mobileTab.setting.relayUrl', "リレーサーバー URL"), localize('paradis.mobileTab.setting.relayUrlDesc', "自分でリレーを運用する場合だけ指定します。"), true);
		this.relayUrlInput = this.textInput(relayRow.value, relayRow.titleId, localize('paradis.mobileTab.setting.relayUrlPlaceholder', "(既定のリレー)"),
			() => this.relayUrlOverride() ?? '',
			// 空・既定と同じなら上書きを外す（空の文字列を URL として持たない）
			value => this.configurationService.updateValue(PARADIS_MOBILE_RELAY_URL_KEY, value && value.replace(/\/$/, '') !== PARADIS_MOBILE_DEFAULT_RELAY_URL ? value : undefined));

		const metricsRow = this.settingRow(box, 'paradis-mobile-setting-metrics', localize('paradis.mobileTab.setting.metrics', "接続の計測"), localize('paradis.mobileTab.setting.metricsDesc', "接続が遅い・切れるときの調査用です。計測を始めてから書き出します。"));
		this.metricsSwitch = this._register(new ParadisSwitch(metricsRow.value, { checked: this.linkMetricsEnabled, ariaLabelledBy: metricsRow.titleId }));
		this._register(this.metricsSwitch.onDidChange(checked => void this.commandService.executeCommand(checked ? START_LINK_METRICS_COMMAND_ID : STOP_LINK_METRICS_COMMAND_ID)));
		this.button(metricsRow.value, localize('paradis.mobileTab.setting.metricsExport', "書き出す"), () => void this.commandService.executeCommand(EXPORT_LINK_METRICS_COMMAND_ID), 'paradis-mobile-pill', Codicon.graph);
	}

	private renderDoNotDisturb(state: IParadisDoNotDisturbRefreshState, now: number): void {
		if (!this.doNotDisturbText) {
			return;
		}
		const remaining = state.enabled ? paradisFormatDoNotDisturbRemaining(state.until, now) : undefined;
		this.doNotDisturbText.textContent = !state.enabled
			? localize('paradis.mobileTab.setting.dndOff', "PC のおやすみモードはモバイルからも切り替えられます。今はオフです。")
			: remaining !== undefined
				? localize('paradis.mobileTab.setting.dndOnUntil', "PC のおやすみモードはモバイルからも切り替えられます。今はオンです（残り {0}）。", remaining)
				: localize('paradis.mobileTab.setting.dndOn', "PC のおやすみモードはモバイルからも切り替えられます。今はオンです（自分でオフにするまで）。");
	}

	/** 設定の 1 行（左に名前と説明、右に値）。`wrap` は値を説明の下へ回す（入力欄の行）。 */
	private settingRow(box: HTMLElement, id: string, title: string, description: string, wrap = false): { readonly value: HTMLElement; readonly description: HTMLElement; readonly titleId: string } {
		const row = dom.append(box, $(`.paradis-mobile-setting${wrap ? '.wrap' : ''}`));
		const label = dom.append(row, $('.paradis-mobile-setting-label'));
		const titleElement = dom.append(label, $('.paradis-mobile-setting-title'));
		titleElement.id = id;
		titleElement.textContent = title;
		const descriptionElement = dom.append(label, $('.paradis-mobile-setting-description'));
		descriptionElement.textContent = description;
		return { value: dom.append(row, $('.paradis-mobile-setting-value')), description: descriptionElement, titleId: id };
	}

	/** 設定の文字の欄。打鍵ごとには書かず、Enter かフォーカスが外れたときに書く。Escape で今の値へ戻す。 */
	private textInput(parent: HTMLElement, labelledBy: string, placeholder: string, read: () => string, write: (value: string) => Promise<void>): HTMLInputElement {
		const input = dom.append(parent, $<HTMLInputElement>('input.paradis-mobile-input'));
		input.type = 'text';
		input.spellcheck = false;
		input.placeholder = placeholder;
		input.setAttribute('aria-labelledby', labelledBy);
		input.value = read();
		this._register(dom.addDisposableListener(input, 'change', () => {
			write(input.value.trim()).catch(error => this.notificationService.error(localize('paradis.mobileTab.settingWriteFailed', "設定を保存できませんでした: {0}", String(error))));
		}));
		this._register(dom.addDisposableListener(input, 'keydown', event => {
			if (event.key === 'Enter' && !event.isComposing) {
				input.blur();
			} else if (event.key === 'Escape') {
				input.value = read();
				input.blur();
			}
		}));
		return input;
	}

	/** 入力中（フォーカスがある）でなければ、欄を今の設定に合わせる。 */
	private syncInput(input: HTMLInputElement, value: string): void {
		if (input.ownerDocument.activeElement !== input && input.value !== value) {
			input.value = value;
		}
	}

	private icon(icon: ThemeIcon): HTMLElement[] {
		return [$(`span${ThemeIcon.asCSSSelector(icon)}`)];
	}

	private button(parent: HTMLElement, label: string, run: (event: MouseEvent) => void, className: string, leading?: ThemeIcon, store?: DisposableStore): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>(`button.${className}`));
		button.type = 'button';
		if (leading) {
			button.append(...this.icon(leading));
		}
		dom.append(button, $('span.paradis-mobile-button-label')).textContent = label;
		const listener = dom.addDisposableListener(button, 'click', event => run(event));
		if (store) {
			store.add(listener);
		} else {
			this._register(listener);
		}
		return button;
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: (event: MouseEvent) => void, store?: DisposableStore): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>('button.paradis-mobile-icon-button'));
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.append(...this.icon(icon));
		const hover = this.hoverService.setupDelayedHover(button, { content: label });
		const listener = dom.addDisposableListener(button, 'click', event => run(event));
		if (store) {
			store.add(hover);
			store.add(listener);
		} else {
			this._register(hover);
			this._register(listener);
		}
		return button;
	}
}
