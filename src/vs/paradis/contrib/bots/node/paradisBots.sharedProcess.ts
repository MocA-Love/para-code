/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で Bot の台帳のサービスを作り、para-browser MCP へ Bot の道具を足す。
// `paradis.sharedProcess.contribution.ts` から副作用 import される（MCP の説明の段は登録の順に並ぶので、並びの最後に置く）。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisSharedHumanAskService } from '../../humanAsk/node/paradisHumanAskChannel.js';
import { ParadisBotToolProvider } from './paradisBotToolProvider.js';
import { ParadisBotsService } from './paradisBotsService.js';
import { createParadisBotItemsFile, createParadisBotsFile } from './paradisBotsStore.js';

let shared: ParadisBotsService | undefined;

/** shared process に 1 つだけの Bot のサービス。登録の前は undefined。後の PR（定期実行の見回り・中継）はここから取る。 */
export function paradisSharedBotsService(): ParadisBotsService | undefined {
	return shared;
}

ParadisSharedProcessContributions.register('bots', ({ accessor }) => {
	const userDataPath = accessor.get(INativeEnvironmentService).userDataPath;
	const store = new DisposableStore();
	const service = store.add(new ParadisBotsService(createParadisBotsFile(userDataPath), createParadisBotItemsFile(userDataPath), paradisSharedHumanAskService(), accessor.get(ILogService), { hookEvents: onParadisAgentHookEvent }));
	shared = service;
	store.add(paradisRegisterMcpToolProvider(new ParadisBotToolProvider(service)));
	store.add({
		dispose: () => {
			if (shared === service) {
				shared = undefined;
			}
		},
	});
	return store;
});
