/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の ParadisCodexAccountsService を呼ぶチャネルと、その登録。
// 登録は shared process の登録口（paradisProcessContributions.ts）経由で、
// `paradis.sharedProcess.contribution.ts` がこのファイルを副作用 import する。
//
// REH（SSH の接続先）には登録しない。リセットクレジットの台帳と Codex の選択はこの PC に1つだけ
// 持つもので、接続先の Codex ホームは扱わない（接続中のウィンドウではカードを出さない）。

import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisCodexResetConsumeRequest, PARADIS_CODEX_ACCOUNTS_CHANNEL } from '../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsService } from './paradisCodexAccountsService.js';

/** 設定で足した Codex ホーム（limitsMonitor と同じ設定を読む）。 */
const CODEX_HOMES_SETTING = 'paradis.limitsMonitor.codexHomes';

export class ParadisCodexAccountsChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisCodexAccountsService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		switch (event) {
			case 'onDidChangeState': return this.service.onDidChangeState as Event<T>;
			default:
				throw new Error(`Event not found: ${event}`);
		}
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'readResetCredits': return this.service.readResetCredits(typeof args[0] === 'string' ? args[0] : '', args[1] === true) as Promise<T>;
			case 'consumeResetCredit': return this.service.consumeResetCredit(args[0] as IParadisCodexResetConsumeRequest) as Promise<T>;
			case 'getState': return this.service.getState() as Promise<T>;
			case 'selectHome': return this.service.selectHome(typeof args[0] === 'string' ? args[0] : undefined) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

ParadisSharedProcessContributions.register('codexAccounts', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const shellEnv = new ParadisCachedShellEnv(
		logService,
		'ParadisCodexAccounts',
		createParadisShellEnvResolver(logService, configurationService, environmentService.args),
		Date.now,
		reportParadisShellEnvDiagnosticError,
	);
	const service = new ParadisCodexAccountsService({
		logService,
		stateDirectory: join(environmentService.userDataPath, 'paradis', 'codexAccounts'),
		resolveEnv: () => shellEnv.getEnv(),
		extraHomes: () => {
			const value = configurationService.getValue<unknown>(CODEX_HOMES_SETTING);
			return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
		},
	});
	server.registerChannel(PARADIS_CODEX_ACCOUNTS_CHANNEL, new ParadisCodexAccountsChannel(service));
	return service;
});
