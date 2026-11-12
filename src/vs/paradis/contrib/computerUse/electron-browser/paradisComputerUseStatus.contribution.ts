/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use の状態を確かめて見せるコマンド（設定画面の「状態を確認…」から呼ぶ）。
//
// 補助アプリの状態（設計書 5.3）と、OS の許可（アクセシビリティ・画面収録）が補助アプリに付いているかを出す。
// 許可は Para Code 本体ではなく「Para Code Computer Use」に付ける、と必ず書く（本体に付けると、ターミナルの
// 全プロセスが同じ許可を使えてしまい、アプリごとの承認を素通りできる。設計書 4 章）。
// 状態はキットの確認の箱（paradisConfirmDialog.ts）で出し、許可ごとに状態の札と「システム設定を開く」を 1 行に並べる。
// 許可したアプリの一覧と取り消し、OS の許可のやり直しは後の段（設計書 7 章 S4）で足す。
//
// 設定がオフからオンに変わったら 1 回知らせる（レビュー L14）。ペインのエージェントは同じユーザーなので
// settings.json を書き換えてオンにできる。オン・オフは守りの境界ではなく、境界はアプリごとの承認だが、
// 知らないうちにオンになっていたら利用者が気づけるようにする。設定はアプリ全体のものなので、どのウィンドウも
// 同じ変更を受ける。知らせるのは最後にフォーカスのあったウィンドウ 1 つだけにする。

import './media/paradisComputerUseStatus.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { toAction } from '../../../../base/common/actions.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { paradisButtonClasses } from '../../../browser/paradisButton.js';
import { openParadisConfirmDialog } from '../../confirmDialog/browser/paradisConfirmDialog.js';
import {
	IParadisComputerUseStatus,
	PARADIS_COMPUTER_USE_ENABLED_SETTING,
	PARADIS_COMPUTER_USE_REFRESH_METHOD,
	PARADIS_COMPUTER_USE_SHOW_STATUS_COMMAND_ID,
	PARADIS_COMPUTER_USE_STATUS_CHANNEL,
	ParadisComputerUseAvailability,
	paradisComputerUseEnabled,
	paradisParseComputerUseStatus,
} from '../common/paradisComputerUse.js';

/** 状態を利用者向けの 1 文にする。 */
export function paradisComputerUseAvailabilityText(availability: ParadisComputerUseAvailability, enabled: boolean): string {
	switch (availability) {
		case 'unsupported-os':
			return localize('paradis.computerUse.status.unsupported', "macOS 14 以降で使えます。");
		case 'missing':
			return localize('paradis.computerUse.status.missing', "このビルドには Computer Use の部品が含まれていません。");
		case 'launch-failed':
			return localize('paradis.computerUse.status.launchFailed', "Computer Use の部品を起動できませんでした。");
		case 'incompatible':
			return localize('paradis.computerUse.status.incompatible', "部品の版が合いません。Para Code を入れ直してください。");
		case 'misattributed':
			return localize('paradis.computerUse.status.misattributed', "この Mac では許可を Para Code 本体と分けられないため使えません。");
		case 'ok':
			return localize('paradis.computerUse.status.ok', "使える状態です。");
		case 'unchecked':
		default:
			return enabled
				? localize('paradis.computerUse.status.checking', "確かめています。")
				: localize('paradis.computerUse.status.off', "オフです。設定の「Computer Use を使う」をオンにすると使えます。");
	}
}

/** 「設定 (Para Code)」を Computer Use の節で開くコマンド（paradisSettingsDialog.contribution.ts）。 */
const PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID = 'paradis.openSettingsDialog';
const PARADIS_SETTINGS_COMPUTER_USE_SECTION_ID = 'psd-sec-computeruse';

/** システム設定の「プライバシーとセキュリティ」の各許可の画面。 */
const PARADIS_PRIVACY_ACCESSIBILITY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const PARADIS_PRIVACY_SCREEN_CAPTURE_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

interface IParadisComputerUsePermissionRow {
	readonly label: string;
	readonly granted: boolean;
	readonly settingsUrl: string;
}

/**
 * 許可ごとに「名前・状態の札・システム設定を開く（足りないときだけ）」の行を描く。
 * 本家の Dialog は本文の中の `<a>` だけを Tab で巡るので、ボタンは `<a>`（monaco-button で本家のリンクの色を付けない）で作る。
 */
function renderPermissionRows(container: HTMLElement, rows: readonly IParadisComputerUsePermissionRow[], openSettings: (url: string) => void, store: DisposableStore): void {
	const list = append(container, $('.paradis-computer-use-permissions'));
	for (const row of rows) {
		const line = append(list, $('.paradis-computer-use-permission'));
		append(line, $('span.paradis-computer-use-permission-name')).textContent = row.label;
		createParadisChip(line, row.granted
			? localize('paradis.computerUse.status.grantedChip', "許可済み")
			: localize('paradis.computerUse.status.notGrantedChip', "未許可"), row.granted ? 'success' : 'warning');
		if (row.granted) {
			append(line, $('span'));
			continue;
		}
		const button = append(line, $<HTMLAnchorElement>('a.monaco-button'));
		button.classList.add(...paradisButtonClasses('secondary', true));
		button.href = row.settingsUrl;
		button.setAttribute('role', 'button');
		button.textContent = localize('paradis.computerUse.status.openSystemSettings', "システム設定を開く");
		store.add(addDisposableListener(button, EventType.CLICK, e => {
			e.preventDefault();
			openSettings(row.settingsUrl);
		}));
		store.add(addDisposableListener(button, EventType.KEY_DOWN, e => {
			if (new StandardKeyboardEvent(e).equals(KeyCode.Space)) {
				e.preventDefault();
				openSettings(row.settingsUrl);
			}
		}));
	}
}

class ParadisShowComputerUseStatusAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_COMPUTER_USE_SHOW_STATUS_COMMAND_ID,
			title: localize2('paradis.computerUse.showStatus', "Computer Use の状態を確認"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// accessor は最初の await の後には使えないので、要るサービスは先に取る
		const channel = accessor.get(ISharedProcessService).getChannel(PARADIS_COMPUTER_USE_STATUS_CHANNEL);
		const logService = accessor.get(ILogService);
		const nativeHostService = accessor.get(INativeHostService);
		const services = {
			layoutService: accessor.get(ILayoutService),
			keybindingService: accessor.get(IKeybindingService),
			hostService: accessor.get(IHostService),
		};
		let status: IParadisComputerUseStatus | undefined;
		try {
			status = paradisParseComputerUseStatus(await channel.call<unknown>(PARADIS_COMPUTER_USE_REFRESH_METHOD));
		} catch (error) {
			logService.warn('[ParadisComputerUse] could not read the status', error);
		}
		const title = localize('paradis.computerUse.status.title', "Computer Use");
		const closeButton = [{ label: localize('paradis.computerUse.status.close', "閉じる"), kind: 'primary' as const, run: () => undefined }];
		if (!status) {
			await openParadisConfirmDialog(services, { message: title, detail: localize('paradis.computerUse.status.unreadable', "状態を読めませんでした。"), buttons: closeButton, cancelIndex: 0 });
			return;
		}
		if (status.detail) {
			logService.info(`[ParadisComputerUse] ${status.availability}: ${status.detail}`);
		}
		const permissions = status.availability === 'ok' ? status.permissions : undefined;
		if (!permissions) {
			await openParadisConfirmDialog(services, { message: title, detail: paradisComputerUseAvailabilityText(status.availability, status.enabled), buttons: closeButton, cancelIndex: 0 });
			return;
		}
		// 開いた後に許可が変わっても行は描き直さない（もう一度「状態を確認」で読み直す）
		const store = new DisposableStore();
		try {
			const missing = !permissions.accessibility || !permissions.screenRecording;
			await openParadisConfirmDialog(services, {
				message: localize('paradis.computerUse.status.okTitle', "Computer Use は使える状態です"),
				detail: missing ? localize('paradis.computerUse.status.grantTarget', "許可は Para Code 本体ではなく「Para Code Computer Use」に付けてください。") : undefined,
				buttons: closeButton,
				cancelIndex: 0,
				renderBody: container => renderPermissionRows(container, [
					{ label: localize('paradis.computerUse.status.accessibility', "アクセシビリティ"), granted: permissions.accessibility, settingsUrl: PARADIS_PRIVACY_ACCESSIBILITY_URL },
					{ label: localize('paradis.computerUse.status.screenRecording', "画面収録"), granted: permissions.screenRecording, settingsUrl: PARADIS_PRIVACY_SCREEN_CAPTURE_URL },
				], url => void nativeHostService.openExternal(url), store),
			});
		} finally {
			store.dispose();
		}
	}
}

registerAction2(ParadisShowComputerUseStatusAction);

/** 設定がオフからオンに変わったら 1 回知らせる。 */
class ParadisComputerUseEnabledNotice extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisComputerUseEnabledNotice';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		let enabled = paradisComputerUseEnabled(configurationService.getValue(PARADIS_COMPUTER_USE_ENABLED_SETTING));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(PARADIS_COMPUTER_USE_ENABLED_SETTING)) {
				return;
			}
			const now = paradisComputerUseEnabled(configurationService.getValue(PARADIS_COMPUTER_USE_ENABLED_SETTING));
			if (now && !enabled) {
				void this.notifyIfLastFocused();
			}
			enabled = now;
		}));
	}

	/** 最後にフォーカスのあったウィンドウでだけ知らせる（どのウィンドウも前面に無くても 1 つは知らせる）。 */
	private async notifyIfLastFocused(): Promise<void> {
		if (!await this.hostService.hadLastFocus()) {
			return;
		}
		// ボタンがあると通知は開いた状態で出るので、本文が全部読める
		this.notificationService.notify({
			severity: Severity.Info,
			message: localize('paradis.computerUse.enabledNotice', "Computer Use がオンになりました。エージェントは、あなたが承認したアプリの画面を読み、操作できます。心当たりが無ければ、Para Code の設定の「Computer Use」でオフにしてください。"),
			actions: {
				primary: [
					toAction({
						id: 'paradis.computerUse.turnOff',
						label: localize('paradis.computerUse.enabledNotice.turnOff', "オフにする"),
						run: async () => {
							try {
								await this.configurationService.updateValue(PARADIS_COMPUTER_USE_ENABLED_SETTING, false);
							} catch (error) {
								this.logService.warn('[ParadisComputerUse] could not turn Computer Use off', error);
								this.notificationService.error(localize('paradis.computerUse.enabledNotice.turnOffFailed', "Computer Use をオフにできませんでした。Para Code の設定の「Computer Use」でオフにしてください。"));
							}
						},
					}),
					toAction({
						id: 'paradis.computerUse.openSettings',
						label: localize('paradis.computerUse.enabledNotice.openSettings', "設定を開く"),
						run: () => this.commandService.executeCommand(PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID, PARADIS_SETTINGS_COMPUTER_USE_SECTION_ID),
					}),
				],
			},
		});
	}
}

registerWorkbenchContribution2(ParadisComputerUseEnabledNotice.ID, ParadisComputerUseEnabledNotice, WorkbenchPhase.AfterRestored);
