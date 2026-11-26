/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use の「操作中」と「停止中」をウィンドウに出し、止めた Computer Use を再開する口を持つ。
//
// 利用者は、エージェントがほかのアプリを操作している間に Esc を 2 回押すと、Computer Use を止められる（補助アプリの
// ParadisEmergencyStop.swift）。止まったこと・入力を送ったことは、shared process の状態のチャネルが全ウィンドウへ知らせる。
//  - ステータスバー: 入力を送ってから数秒の間だけ「Computer Use 操作中 · Esc 2 回で停止」、止まっている間は
//    「Computer Use 停止中」（押すと再開）。どのウィンドウにも出す。設定がオフの間は出さない
//  - 通知: 止まったときに 1 回、「再開」のボタン付きで出す。通常ウィンドウ 1 つにだけ出す（オンになった知らせと同じ決め方）
//  - コマンド「Computer Use: 操作を再開」
//
// 再開できるのはここ（ウィンドウでの人の操作）だけ。MCP のツール・para CLI・設定からは再開できない
// （ペインのエージェントは settings.json を書き換えられるので、設定では外せないようにしてある）。
// 的のアプリの画面に重ねる表示は作らない。

import { toAction } from '../../../../base/common/actions.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import {
	IParadisComputerUseActivity,
	IParadisComputerUseActivityState,
	PARADIS_COMPUTER_USE_ACTIVITY_EVENT,
	PARADIS_COMPUTER_USE_ACTIVITY_METHOD,
	PARADIS_COMPUTER_USE_ENABLED_SETTING,
	PARADIS_COMPUTER_USE_RESUME_COMMAND_ID,
	PARADIS_COMPUTER_USE_RESUME_METHOD,
	PARADIS_COMPUTER_USE_STATUS_CHANNEL,
	paradisComputerUseActivityView,
	paradisComputerUseEnabled,
	paradisComputerUseNextActivity,
	paradisParseComputerUseActivity,
} from '../common/paradisComputerUse.js';
import { paradisComputerUseIsNoticeWindow } from './paradisComputerUseStatus.contribution.js';

const ENTRY_ID = 'paradis.computerUse.activity';

/** 入力を送ってから「操作中」を出しておく時間。 */
const ACTIVE_MS = 5_000;

class ParadisComputerUseResumeAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_COMPUTER_USE_RESUME_COMMAND_ID,
			title: localize2('paradis.computerUse.resume', "Computer Use: 操作を再開"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// accessor は最初の await の後には使えないので、要るサービスは先に取る
		const channel = accessor.get(ISharedProcessService).getChannel(PARADIS_COMPUTER_USE_STATUS_CHANNEL);
		const notificationService = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);
		try {
			// 再開したことは、状態のチャネルの知らせで全ウィンドウへ届く（通知を閉じ、ステータスバーを戻す）
			await channel.call<unknown>(PARADIS_COMPUTER_USE_RESUME_METHOD);
		} catch (error) {
			logService.warn('[ParadisComputerUse] could not resume Computer Use', error);
			notificationService.error(localize('paradis.computerUse.resumeFailed', "Computer Use を再開できませんでした。もう一度試すか、Para Code の設定の「Computer Use」で状態を確かめてください。"));
		}
	}
}

registerAction2(ParadisComputerUseResumeAction);

class ParadisComputerUseActivityContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisComputerUseActivity';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly activeTimer = this._register(new MutableDisposable());
	private readonly notice = this._register(new MutableDisposable());
	private state: IParadisComputerUseActivityState = { stopped: false, active: false };
	/** 知らせを 1 つでも受けたか（起動時に読んだ状態で、後から来た知らせを上書きしないため）。 */
	private received = false;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const channel = sharedProcessService.getChannel(PARADIS_COMPUTER_USE_STATUS_CHANNEL);
		this._register(channel.listen<unknown>(PARADIS_COMPUTER_USE_ACTIVITY_EVENT)(value => {
			const activity = paradisParseComputerUseActivity(value);
			if (activity) {
				this.received = true;
				this.apply(activity);
			}
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_COMPUTER_USE_ENABLED_SETTING)) {
				this.render();
			}
		}));
		void this.readInitialState(channel.call<unknown>(PARADIS_COMPUTER_USE_ACTIVITY_METHOD));
	}

	/** ウィンドウを開く前から止まっていたら、ステータスバーにだけ出す（通知は止まったときの 1 回だけ）。 */
	private async readInitialState(pending: Promise<unknown>): Promise<void> {
		let activity: IParadisComputerUseActivity | undefined;
		try {
			activity = paradisParseComputerUseActivity(await pending);
		} catch (error) {
			this.logService.warn('[ParadisComputerUse] could not read the activity state', error);
			return;
		}
		if (!activity || this.received || this._store.isDisposed) {
			return;
		}
		this.state = { stopped: activity.stopped, active: false };
		this.render();
	}

	private apply(activity: IParadisComputerUseActivity): void {
		const next = paradisComputerUseNextActivity(this.state, activity);
		this.state = next.state;
		if (next.armActiveTimer) {
			this.activeTimer.value = disposableTimeout(() => {
				this.state = { ...this.state, active: false };
				this.render();
			}, ACTIVE_MS);
		}
		if (this.state.stopped) {
			this.activeTimer.clear();
		}
		if (next.closeNotice) {
			this.notice.clear();
		}
		if (next.notify) {
			void this.notifyStopped();
		}
		this.render();
	}

	private render(): void {
		const view = paradisComputerUseActivityView(this.state, paradisComputerUseEnabled(this.configurationService.getValue(PARADIS_COMPUTER_USE_ENABLED_SETTING)));
		if (!view) {
			this.entry.clear();
			return;
		}
		const name = localize('paradis.computerUse.activity.name', "Computer Use");
		const properties: IStatusbarEntry = view === 'stopped'
			? {
				name,
				text: `$(debug-pause) ${localize('paradis.computerUse.activity.stopped', "Computer Use 停止中")}`,
				ariaLabel: localize('paradis.computerUse.activity.stoppedAria', "Computer Use は停止中です。押すと再開します。"),
				tooltip: localize('paradis.computerUse.activity.stoppedTooltip', "Esc を 2 回押して Computer Use を止めました。エージェントの操作は送られません。クリックすると再開します。"),
				command: PARADIS_COMPUTER_USE_RESUME_COMMAND_ID,
				kind: 'warning',
			}
			: {
				name,
				text: `$(record) ${localize('paradis.computerUse.activity.active', "Computer Use 操作中 · Esc 2 回で停止")}`,
				ariaLabel: localize('paradis.computerUse.activity.activeAria', "Computer Use がほかのアプリを操作中です。Esc を 2 回押すと止まります。"),
				tooltip: localize('paradis.computerUse.activity.activeTooltip', "エージェントが Computer Use でほかのアプリを操作しています。Esc をすばやく 2 回押すと、再開するまで操作を送りません。"),
				kind: 'prominent',
			};
		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			this.entry.value = this.statusbarService.addEntry(properties, ENTRY_ID, StatusbarAlignment.LEFT, -100);
		}
	}

	/** 止まったことを、通常ウィンドウ 1 つでだけ知らせる。 */
	private async notifyStopped(): Promise<void> {
		if (!await paradisComputerUseIsNoticeWindow(this.nativeHostService, this.environmentService, this.logService)) {
			return;
		}
		// 一覧を読む間に再開されていたら出さない
		if (!this.state.stopped || this._store.isDisposed) {
			return;
		}
		const handle = this.notificationService.notify({
			severity: Severity.Warning,
			message: localize('paradis.computerUse.stoppedNotice', "Computer Use を止めました（Esc を 2 回）。エージェントの操作は再開するまで送られません。"),
			sticky: true,
			actions: {
				primary: [
					toAction({
						id: 'paradis.computerUse.resumeFromNotice',
						label: localize('paradis.computerUse.stoppedNotice.resume', "再開"),
						run: () => this.commandService.executeCommand(PARADIS_COMPUTER_USE_RESUME_COMMAND_ID),
					}),
				],
			},
		});
		this.notice.value = toDisposable(() => handle.close());
	}
}

// 状態のチャネルは shared process が立ち上がってから登録されるので、急がない（ウィンドウの起動を遅らせない）
registerWorkbenchContribution2(ParadisComputerUseActivityContribution.ID, ParadisComputerUseActivityContribution, WorkbenchPhase.Eventually);
