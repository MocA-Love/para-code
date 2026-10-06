/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PC のおやすみモードの今の状態を shared process へ渡す役（notify.dnd-remote.v1）。shared process は値が変わったときだけ
// Desktop State を送り直し、モバイルの「PC のおやすみモード」の行がそれを追う。
//
// 渡すのは、起動時・状態が変わったとき（このウィンドウ・別のウィンドウ・モバイルのどこで変えても）・期限が来たとき。
// 期限切れは storage の getter が読んだときに消すだけで変更の通知が出ないので、ステータスバーと同じ
// 期限つきの再読み込み（ParadisDoNotDisturbRefreshController）で読み直す。全ウィンドウが同じ値を渡すが、
// shared process が同じ値を捨てる。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisNotificationsSettingsService } from '../../notifications/browser/paradisNotificationsSettings.js';
import { paradisCreateDoNotDisturbRefreshController } from '../../notifications/common/paradisDoNotDisturb.js';
import { paradisSameMobileDoNotDisturbState, IParadisMobileDoNotDisturbState } from '../common/paradisMobileDoNotDisturb.js';
import { IParadisMobileRelayService, PARADIS_MOBILE_RELAY_CHANNEL } from '../common/paradisMobileRelay.js';
import { paradisMobileDoNotDisturbStateOf } from './paradisMobileDoNotDisturbRequests.js';

class ParadisMobileDoNotDisturbSyncContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisMobileDoNotDisturbSync';

	private lastSent: IParadisMobileDoNotDisturbState | undefined;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService settingsService: IParadisNotificationsSettingsService,
		@ILogService logService: ILogService,
	) {
		super();
		const service = ProxyChannel.toService<IParadisMobileRelayService>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
		const refresh = this._register(paradisCreateDoNotDisturbRefreshController(() => {
			const current = settingsService.getDoNotDisturb();
			const state = paradisMobileDoNotDisturbStateOf(current);
			if (!paradisSameMobileDoNotDisturbState(this.lastSent, state)) {
				this.lastSent = state;
				service.setDoNotDisturb(state).catch(error => {
					// 届かなかった。次の変更・期限・読み直しで同じ値でも送り直す
					if (paradisSameMobileDoNotDisturbState(this.lastSent, state)) {
						this.lastSent = undefined;
					}
					logService.trace('[paradisMobileRelay] do-not-disturb sync failed', String(error));
				});
			}
			return current;
		}));
		this._register(settingsService.onDidChangeDoNotDisturb(() => refresh.refresh()));
		refresh.refresh();
	}
}

registerWorkbenchContribution2(ParadisMobileDoNotDisturbSyncContribution.ID, ParadisMobileDoNotDisturbSyncContribution, WorkbenchPhase.AfterRestored);
