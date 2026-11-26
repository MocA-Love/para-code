/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で Computer Use（B3）を立ち上げる。`paradis.sharedProcess.contribution.ts` から副作用 import される。
//
// 設定がオンのときだけ補助アプリを起動して状態を確かめる。オフの間は起動せず、OS と部品の有無だけを見る。
// ここで何が失敗しても、ほかの MCP ツールと shared process の機能には影響させない（例外は外へ出さない）。
//
// 状態のチャネルは、利用者が Esc の 2 回押しで止めたこと・入力を送ったことを全ウィンドウへ知らせ（通知とステータスバー）、
// ウィンドウからの「再開」を受ける。再開の口はこのチャネルだけで、MCP のツール・para CLI・設定からは届かない。

import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	IParadisComputerUseActivity,
	IParadisComputerUseStatus,
	PARADIS_COMPUTER_USE_ACTIVITY_EVENT,
	PARADIS_COMPUTER_USE_ACTIVITY_METHOD,
	PARADIS_COMPUTER_USE_ALLOW_OPERATING_READ_ONLY_APPS_SETTING,
	PARADIS_COMPUTER_USE_CONFIRM_FOREGROUND_SETTING,
	PARADIS_COMPUTER_USE_ENABLED_SETTING,
	PARADIS_COMPUTER_USE_REFRESH_METHOD,
	PARADIS_COMPUTER_USE_RESUME_METHOD,
	PARADIS_COMPUTER_USE_SHOW_CURSOR_SETTING,
	PARADIS_COMPUTER_USE_STATUS_CHANNEL,
	PARADIS_COMPUTER_USE_STATUS_METHOD,
	paradisComputerUseAllowOperatingReadOnlyApps,
	paradisComputerUseConfirmForeground,
	paradisComputerUseEnabled,
	paradisComputerUseShowCursor,
} from '../common/paradisComputerUse.js';
import { ParadisComputerUseGrantLedger } from './paradisComputerUseGrantLedger.js';
import { createParadisComputerUseHelperHost, ParadisComputerUseHelperClient } from './paradisComputerUseHelperClient.js';
import { ParadisComputerUseToolProvider } from './paradisComputerUseToolProvider.js';

/** 止まっているか・入力を送ったかの知らせと、再開の口（{@link ParadisComputerUseToolProvider} が実体）。 */
export interface IParadisComputerUseActivitySource {
	readonly onDidChangeActivity: Event<IParadisComputerUseActivity>;
	readonly stopped: boolean;
	resume(): Promise<void>;
}

/** 設定画面とコマンドへ状態を返すチャネル。止めた・入力を送った知らせと、ウィンドウからの再開もここで受ける。 */
export class ParadisComputerUseStatusChannel implements IServerChannel {

	constructor(
		private readonly _helper: Pick<ParadisComputerUseHelperClient, 'availability' | 'detail' | 'lastStatus' | 'check'>,
		private readonly _enabled: () => boolean,
		private readonly _activity?: IParadisComputerUseActivitySource,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		if (event === PARADIS_COMPUTER_USE_ACTIVITY_EVENT && this._activity) {
			return this._activity.onDidChangeActivity as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string): Promise<T> {
		switch (command) {
			case PARADIS_COMPUTER_USE_ACTIVITY_METHOD: {
				const activity: IParadisComputerUseActivity = { stopped: this._activity?.stopped === true, input: false };
				return activity as T;
			}
			case PARADIS_COMPUTER_USE_RESUME_METHOD: {
				// ウィンドウでの人の操作（通知の「再開」・ステータスバー・コマンド）からだけ届く
				await this._activity?.resume();
				const activity: IParadisComputerUseActivity = { stopped: this._activity?.stopped === true, input: false };
				return activity as T;
			}
			case PARADIS_COMPUTER_USE_STATUS_METHOD:
				return this._snapshot() as T;
			case PARADIS_COMPUTER_USE_REFRESH_METHOD:
				// オフの間は起動しない（状態の表示のために補助アプリを立ち上げない）
				if (this._enabled()) {
					await this._helper.check();
				}
				return this._snapshot() as T;
		}
		throw new Error(`Method not found: ${command}`);
	}

	private _snapshot(): IParadisComputerUseStatus {
		const status = this._helper.lastStatus;
		return {
			enabled: this._enabled(),
			availability: this._helper.availability,
			...(this._helper.detail ? { detail: this._helper.detail } : {}),
			...(status ? { helperVersion: status.helperVersion, permissions: status.permissions } : {}),
		};
	}
}

ParadisSharedProcessContributions.register('computerUse', ({ server, accessor }) => {
	const configurationService = accessor.get(IConfigurationService);
	const logService = accessor.get(ILogService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const store = new DisposableStore();
	const helper = store.add(new ParadisComputerUseHelperClient(createParadisComputerUseHelperHost(environmentService.appRoot, environmentService.userDataPath, environmentService.isBuilt), logService));
	const ledger = new ParadisComputerUseGrantLedger();
	// 設定のスキーマは画面側でしか登録されないので、ここでは生の値を読んで既定（オフ）へ倒す
	const enabled = () => paradisComputerUseEnabled(configurationService.getValue(PARADIS_COMPUTER_USE_ENABLED_SETTING));
	const onDidChangeActivity = store.add(new Emitter<IParadisComputerUseActivity>());
	const provider = new ParadisComputerUseToolProvider(helper, ledger, {
		enabled,
		confirmForeground: () => paradisComputerUseConfirmForeground(configurationService.getValue(PARADIS_COMPUTER_USE_CONFIRM_FOREGROUND_SETTING)),
		showCursor: () => paradisComputerUseShowCursor(configurationService.getValue(PARADIS_COMPUTER_USE_SHOW_CURSOR_SETTING)),
		allowOperatingReadOnlyApps: () => paradisComputerUseAllowOperatingReadOnlyApps(configurationService.getValue(PARADIS_COMPUTER_USE_ALLOW_OPERATING_READ_ONLY_APPS_SETTING)),
		onDidChangeStopped: stopped => onDidChangeActivity.fire({ stopped, input: false }),
		onDidSendInput: () => onDidChangeActivity.fire({ stopped: provider.stopped, input: true }),
	}, logService);
	store.add(paradisRegisterMcpToolProvider(provider));
	server.registerChannel(PARADIS_COMPUTER_USE_STATUS_CHANNEL, new ParadisComputerUseStatusChannel(helper, enabled, {
		onDidChangeActivity: onDidChangeActivity.event,
		get stopped() { return provider.stopped; },
		resume: () => provider.resume(),
	}));

	const sync = () => {
		if (enabled()) {
			helper.check().catch(error => logService.warn('[ParadisComputerUse] check failed', error));
		} else {
			// オフにしたら補助アプリを止め、許可も忘れる（次にオンにしたときは聞き直す）。許可はすぐ忘れる。
			// 補助アプリを止めるのは、Esc の停止が掛かっているかを読んでから（掛け金は補助アプリと一緒に消えるので、
			// 読まずに止めると、設定のオフ→オンで停止を外せてしまう）。読んでいる間にオンへ戻っていたら止めない
			ledger.clear();
			provider.captureStopped().finally(() => {
				if (!enabled()) {
					helper.markDisabled();
				}
			});
		}
	};
	store.add(configurationService.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(PARADIS_COMPUTER_USE_ENABLED_SETTING)) {
			sync();
		}
	}));
	sync();
	return store;
});
