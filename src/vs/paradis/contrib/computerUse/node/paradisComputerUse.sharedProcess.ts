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

import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	IParadisComputerUseStatus,
	PARADIS_COMPUTER_USE_ENABLED_SETTING,
	PARADIS_COMPUTER_USE_REFRESH_METHOD,
	PARADIS_COMPUTER_USE_STATUS_CHANNEL,
	PARADIS_COMPUTER_USE_STATUS_METHOD,
	paradisComputerUseEnabled,
} from '../common/paradisComputerUse.js';
import { ParadisComputerUseGrantLedger } from './paradisComputerUseGrantLedger.js';
import { createParadisComputerUseHelperHost, ParadisComputerUseHelperClient } from './paradisComputerUseHelperClient.js';
import { ParadisComputerUseToolProvider } from './paradisComputerUseToolProvider.js';

/** 設定画面とコマンドへ状態を返すチャネル。 */
export class ParadisComputerUseStatusChannel implements IServerChannel {

	constructor(
		private readonly _helper: Pick<ParadisComputerUseHelperClient, 'availability' | 'detail' | 'lastStatus' | 'check'>,
		private readonly _enabled: () => boolean,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string): Promise<T> {
		switch (command) {
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
	store.add(paradisRegisterMcpToolProvider(new ParadisComputerUseToolProvider(helper, ledger, { enabled }, logService)));
	server.registerChannel(PARADIS_COMPUTER_USE_STATUS_CHANNEL, new ParadisComputerUseStatusChannel(helper, enabled));

	const sync = () => {
		if (enabled()) {
			helper.check().catch(error => logService.warn('[ParadisComputerUse] check failed', error));
		} else {
			// オフにしたら補助アプリを止め、許可も忘れる（次にオンにしたときは聞き直す）
			helper.markDisabled();
			ledger.clear();
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
