/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Dock（macOS）・ランチャー（Linux）・タスクバー（Windows）のアイコンの件数。数えるのは確認が必要な
// ペインの数。メニューバー（通知領域）のアイコンへの中身の受け渡しは menuBar/ に移した。
//
// 件数は upstream の `INativeHostService.setApplicationBadge` で出す。main の DockBadgeManager
// （windowImpl.ts）がウィンドウごとの数を足し合わせ、ウィンドウが閉じたらその分を外し、
// 「注意を引く」赤い点（FocusMode.Notify）より数を優先する。そこで各ウィンドウは
// **自分が持っているペインの分だけ**を出す。全体の数を各ウィンドウから出すと、ウィンドウの数だけ
// 掛け算になる。`app.setBadgeCount` を直接呼ぶと DockBadgeManager と取り合うので呼ばない。

import { mainWindow } from '../../../../base/browser/window.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IApplicationBadge, INativeHostService } from '../../../../platform/native/common/native.js';
import { contrastBorder } from '../../../../platform/theme/common/colors/baseColors.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND } from '../../../../workbench/common/theme.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisNotificationsSettingsService } from '../../notifications/browser/paradisNotificationsSettings.js';
import { IParadisNotificationInboxService, PARADIS_NOTIFICATION_DOCK_BADGE_SETTING, paradisInboxAttentionPaneCount, paradisInboxPaneKey } from '../common/paradisNotificationInbox.js';

/** Windows のタスクバーの重ね絵は小さく描かれるので、2倍で描く。 */
const WINDOWS_ICON_SIZE = 32;

class ParadisNotificationInboxBadge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisNotificationInboxBadge';

	/** -1 で始めて、最初の1回は必ず送る（前の renderer が残した数を上書きするため）。 */
	private lastCount = -1;
	/** おやすみモードの期限で件数を出し直すためのタイマー。 */
	private readonly doNotDisturbExpiry = this._register(new MutableDisposable());

	constructor(
		@IParadisNotificationInboxService private readonly inboxService: IParadisNotificationInboxService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IThemeService private readonly themeService: IThemeService,
		@ILogService private readonly logService: ILogService,
		@IParadisNotificationsSettingsService private readonly notificationsSettingsService: IParadisNotificationsSettingsService,
	) {
		super();
		const update = () => this.updateBadge();
		this._register(this.inboxService.onDidChange(update));
		this._register(this.paneTokenService.onDidChange(update));
		this._register(this.notificationsSettingsService.onDidChangeDoNotDisturb(update));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_NOTIFICATION_DOCK_BADGE_SETTING)) {
				update();
			}
		}));
		if (isWindows) {
			// 重ね絵はここで描くので、テーマに合わせて描き直す
			this._register(this.themeService.onDidColorThemeChange(() => this.setBadge(this.lastCount, true)));
		}
		// Dock の件数はアプリ全体のものなので、このウィンドウの分を残して閉じない
		this._register(toDisposable(() => this.setBadge(0, true)));
		update();
	}

	private updateBadge(): void {
		// おやすみモードの間は Dock に数を出さない。音・OS 通知・読み上げと同じく「鳴らさない」側に揃える
		// （受信箱には残し、ベルの数も出す）。OS 通知だけを切っている人の分は数える（要対応には違いない）。
		const doNotDisturb = this.notificationsSettingsService.getDoNotDisturb();
		this.doNotDisturbExpiry.value = doNotDisturb.enabled && doNotDisturb.until !== undefined
			? disposableTimeout(() => this.updateBadge(), Math.max(0, doNotDisturb.until - Date.now()) + 1_000)
			: undefined;
		const enabled = !doNotDisturb.enabled && this.configurationService.getValue<boolean>(PARADIS_NOTIFICATION_DOCK_BADGE_SETTING) !== false;
		const owned = new Set(this.paneTokenService.listPaneTokens().map(entry => paradisInboxPaneKey(entry.token)));
		this.setBadge(enabled ? paradisInboxAttentionPaneCount(this.inboxService.snapshot, owned) : 0);
	}

	private setBadge(count: number, force = false): void {
		if (count === this.lastCount && !force) {
			return;
		}
		this.lastCount = count;
		let badge: IApplicationBadge | undefined;
		if (count > 0) {
			const description = localize('paradis.inbox.badge', "対応が必要なペイン {0} 件", count);
			// iconDataURL は undefined を入れず省く（IPC の JSON 化で消え、main で別物に見えるため）
			const iconDataURL = isWindows ? this.renderIcon(count) : undefined;
			badge = iconDataURL ? { count, description, iconDataURL } : { count, description };
		}
		this.nativeHostService.setApplicationBadge(badge).catch(error => this.logService.trace('[paradisNotificationInbox] setApplicationBadge failed', String(error)));
	}

	/** Windows のタスクバーに重ねる丸い数字。 */
	private renderIcon(count: number): string | undefined {
		const canvas = mainWindow.document.createElement('canvas');
		canvas.width = WINDOWS_ICON_SIZE;
		canvas.height = WINDOWS_ICON_SIZE;
		const context = canvas.getContext('2d');
		if (!context) {
			return undefined;
		}
		const theme = this.themeService.getColorTheme();
		const half = WINDOWS_ICON_SIZE / 2;
		context.fillStyle = theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND)?.toString() ?? '#0078d4';
		context.beginPath();
		context.arc(half, half, half - 1, 0, Math.PI * 2);
		context.fill();
		// ハイコントラストでは背景と同じ色になるので縁取る
		const border = theme.getColor(contrastBorder);
		if (border) {
			context.strokeStyle = border.toString();
			context.lineWidth = 2;
			context.stroke();
		}
		context.fillStyle = theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND)?.toString() ?? '#ffffff';
		context.font = `600 ${count > 9 ? 16 : 20}px Segoe UI, sans-serif`;
		context.textAlign = 'center';
		context.textBaseline = 'middle';
		context.fillText(count > 9 ? '9+' : String(count), half, half + 1);
		return canvas.toDataURL('image/png');
	}
}

registerWorkbenchContribution2(ParadisNotificationInboxBadge.ID, ParadisNotificationInboxBadge, WorkbenchPhase.AfterRestored);
