/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// おやすみモード（通知の一括ミュート）のステータスバー表示と、持続時間を選ぶ Quick Pick コマンド。
// 抑制の実体は paradisNotificationTrigger.contribution.ts の _notify() 冒頭にあり、ここは
// 状態の表示と切り替えだけを担う。

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IParadisDoNotDisturbState, IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { paradisCreateDoNotDisturbRefreshController, paradisFormatDoNotDisturbRemaining, PARADIS_DO_NOT_DISTURB_DURATIONS, PARADIS_DO_NOT_DISTURB_SELECT_COMMAND, ParadisDoNotDisturbRefreshControllerFactory } from '../common/paradisDoNotDisturb.js';

const STATUSBAR_ENTRY_ID = 'paradis.notifications.doNotDisturb';

export class ParadisDoNotDisturbStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.contrib.doNotDisturbStatusBar';
	protected static readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
		= refresh => paradisCreateDoNotDisturbRefreshController(refresh);

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
	) {
		super();

		const refreshControllerFactory = new.target.refreshControllerFactory;
		const refreshController = this._register(refreshControllerFactory(renderNow => this._refresh(renderNow)));
		this._register(this.settingsService.onDidChangeDoNotDisturb(() => refreshController.refresh()));
		refreshController.refresh();
	}

	private _refresh(renderNow: number): IParadisDoNotDisturbState {
		const state = this.settingsService.getDoNotDisturb();
		const remaining = paradisFormatDoNotDisturbRemaining(state.until, renderNow);

		let label: string;
		let tooltip: string;
		if (!state.enabled) {
			// allow-any-unicode-next-line
			label = localize('paradis.dnd.status.off', "おやすみモード");
			// allow-any-unicode-next-line
			tooltip = localize('paradis.dnd.status.tooltipOff', "通知はオンです。クリックしておやすみモードを開始します（このPCの音・デスクトップ通知・音声読み上げを一括で止めます。モバイルへのPush通知は対象外）。");
		} else if (remaining) {
			// allow-any-unicode-next-line
			label = localize('paradis.dnd.status.onUntil', "おやすみ中（残り{0}）", remaining);
			// allow-any-unicode-next-line
			tooltip = localize('paradis.dnd.status.tooltipOnUntil', "おやすみモード中です（あと{0}）。このPCの音・デスクトップ通知・音声読み上げを止めています（モバイルへのPush通知は対象外）。クリックで変更・解除できます。", remaining);
		} else {
			// allow-any-unicode-next-line
			label = localize('paradis.dnd.status.onManual', "おやすみ中");
			// allow-any-unicode-next-line
			tooltip = localize('paradis.dnd.status.tooltipOnManual', "おやすみモード中です（自分でオフにするまで）。このPCの音・デスクトップ通知・音声読み上げを止めています（モバイルへのPush通知は対象外）。クリックで変更・解除できます。");
		}

		const properties: IStatusbarEntry = {
			// allow-any-unicode-next-line
			name: localize('paradis.dnd.status.name', "おやすみモード"),
			text: `$(${state.enabled ? 'bell-slash' : 'bell'}) ${label}`,
			ariaLabel: label,
			tooltip,
			command: PARADIS_DO_NOT_DISTURB_SELECT_COMMAND,
		};

		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			// ccusage(-9990) / githubMetrics(-9991) の左、RTK(-9993) の右
			this.entry.value = this.statusbarService.addEntry(properties, STATUSBAR_ENTRY_ID, StatusbarAlignment.RIGHT, -9992);
		}
		return state;
	}
}

registerWorkbenchContribution2(ParadisDoNotDisturbStatusBarContribution.ID, ParadisDoNotDisturbStatusBarContribution, WorkbenchPhase.AfterRestored);

/** 持続時間の選択（ステータスバーのクリック先、コマンドパレットからも実行可）。 */
class ParadisSelectDoNotDisturbAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_DO_NOT_DISTURB_SELECT_COMMAND,
			title: localize2('paradis.dnd.selectCommand', "Select Do Not Disturb Duration"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const settingsService = accessor.get(IParadisNotificationsSettingsService);

		const state = settingsService.getDoNotDisturb();
		interface IDurationItem extends IQuickPickItem { readonly durationId: string | undefined }

		const items: IDurationItem[] = [];
		if (state.enabled) {
			items.push({
				durationId: undefined,
				// allow-any-unicode-next-line
				label: localize('paradis.dnd.pick.turnOff', "今すぐ解除"),
				// allow-any-unicode-next-line
				description: localize('paradis.dnd.pick.turnOffDescription', "通知（音・デスクトップ通知・音声読み上げ）を再開します"),
			});
		}
		for (const duration of PARADIS_DO_NOT_DISTURB_DURATIONS) {
			items.push({ durationId: duration.id, label: duration.label });
		}

		const picked = await quickInputService.pick(items, {
			placeHolder: state.enabled
				// allow-any-unicode-next-line
				? localize('paradis.dnd.pick.placeholderOn', "おやすみモード中です。解除するか、期間を選び直してください")
				// allow-any-unicode-next-line
				: localize('paradis.dnd.pick.placeholderOff', "通知を止める期間を選択してください"),
		});
		if (!picked) {
			return;
		}

		if (picked.durationId === undefined) {
			settingsService.setDoNotDisturb(false, undefined);
			return;
		}

		const duration = PARADIS_DO_NOT_DISTURB_DURATIONS.find(candidate => candidate.id === picked.durationId);
		if (duration) {
			settingsService.setDoNotDisturb(true, duration.resolveUntil(Date.now()));
		}
	}
}

registerAction2(ParadisSelectDoNotDisturbAction);
