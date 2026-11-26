/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で Bot の台帳のサービスを作り、ウィンドウへチャネルを出し、para-browser MCP へ Bot の道具を足す。
// `paradis.sharedProcess.contribution.ts` から副作用 import される（MCP の説明の段は登録の順に並ぶので、並びの最後に置く）。

import { homedir } from 'os';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING, paradisAgentIdeActionsAllowed } from '../../agentIde/common/paradisAgentIde.js';
import { paradisSharedHumanAskService } from '../../humanAsk/node/paradisHumanAskChannel.js';
import { PARADIS_BOTS_CHANNEL, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { ParadisBotHomes } from './paradisBotHomes.js';
import { ParadisBotManageToolProvider } from './paradisBotManageToolProvider.js';
import { ParadisBotToolProvider } from './paradisBotToolProvider.js';
import { ParadisBotsChannel } from './paradisBotsChannel.js';
import { ParadisBotsService } from './paradisBotsService.js';
import { ParadisBotMemorySnapshots } from './paradisBotMemorySnapshots.js';
import { createParadisBotItemsFile, createParadisBotPanesFile, createParadisBotsFile, createParadisBotSuggestionsFile, paradisBotsDataFolder } from './paradisBotsStore.js';
import { ParadisBotsMobileFeed } from './paradisBotsMobileFeed.js';

let shared: ParadisBotsService | undefined;

/** shared process に 1 つだけの Bot のサービス。登録の前は undefined。後の PR（定期実行の見回り・中継）はここから取る。 */
export function paradisSharedBotsService(): ParadisBotsService | undefined {
	return shared;
}

ParadisSharedProcessContributions.register('bots', ({ server, accessor }) => {
	const userDataPath = accessor.get(INativeEnvironmentService).userDataPath;
	const store = new DisposableStore();
	const homes = new ParadisBotHomes(join(homedir(), '.para-code', 'bots'));
	const service = store.add(new ParadisBotsService(createParadisBotsFile(userDataPath), createParadisBotItemsFile(userDataPath), paradisSharedHumanAskService(), accessor.get(ILogService), {
		hookEvents: onParadisAgentHookEvent,
		panesFile: createParadisBotPanesFile(userDataPath),
		suggestionsFile: createParadisBotSuggestionsFile(userDataPath),
		// 記憶の写しは専用フォルダ（Bot が書ける）の外に置く
		memorySnapshots: new ParadisBotMemorySnapshots(join(paradisBotsDataFolder(userDataPath), 'memory-snapshots'), homes),
		homes,
	}));
	server.registerChannel(PARADIS_BOTS_CHANNEL, new ParadisBotsChannel(service));
	shared = service;
	store.add(paradisRegisterMcpToolProvider(new ParadisBotToolProvider(service)));
	// 管理の道具の書く側は、IDE 系の書く道具と同じ設定の下（スキーマは画面側でしか登録されないので生の値を読む）
	const configurationService = accessor.get(IConfigurationService);
	store.add(paradisRegisterMcpToolProvider(new ParadisBotManageToolProvider(service, {
		actionsEnabled: () => paradisAgentIdeActionsAllowed(configurationService.getValue(PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING)),
		botsEnabled: () => configurationService.getValue(PARADIS_BOTS_ENABLED_SETTING) === true,
	})));
	// スマホへ送る Bot の一覧（PR 16、bots.page.v1）
	store.add(new ParadisBotsMobileFeed(service, configurationService));
	store.add({
		dispose: () => {
			if (shared === service) {
				shared = undefined;
			}
		},
	});
	return store;
});
