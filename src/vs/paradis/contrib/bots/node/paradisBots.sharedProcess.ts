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
import { paradisRegisterAgentIdeActionRefusal } from '../../agentIde/node/paradisAgentIdeToolProvider.js';
import { paradisSharedHumanAskService } from '../../humanAsk/node/paradisHumanAskChannel.js';
import { paradisSharedScheduledRunsService } from '../../scheduledRuns/node/paradisScheduledRunsChannel.js';
import { PARADIS_BOTS_CHANNEL, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { ParadisBotHomes } from './paradisBotHomes.js';
import { ParadisBotManageToolProvider, paradisBotIdeActionRefusal } from './paradisBotManageToolProvider.js';
import { ParadisBotToolProvider } from './paradisBotToolProvider.js';
import { ParadisBotMessageToolProvider } from './paradisBotMessageToolProvider.js';
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
	// Bot の機能は試験中の設定でオン・オフする（スキーマは画面側で登録されるので、生の値を読む）
	const configurationService = accessor.get(IConfigurationService);
	const enabled = () => configurationService.getValue(PARADIS_BOTS_ENABLED_SETTING) === true;
	const homes = new ParadisBotHomes(join(homedir(), '.para-code', 'bots'));
	const service = store.add(new ParadisBotsService(createParadisBotsFile(userDataPath), createParadisBotItemsFile(userDataPath), paradisSharedHumanAskService(), accessor.get(ILogService), {
		hookEvents: onParadisAgentHookEvent,
		enabled,
		panesFile: createParadisBotPanesFile(userDataPath),
		suggestionsFile: createParadisBotSuggestionsFile(userDataPath),
		// 記憶の写しは専用フォルダ（Bot が書ける）の外に置く
		memorySnapshots: new ParadisBotMemorySnapshots(join(paradisBotsDataFolder(userDataPath), 'memory-snapshots'), homes),
		homes,
	}));
	server.registerChannel(PARADIS_BOTS_CHANNEL, new ParadisBotsChannel(service));
	shared = service;
	store.add(configurationService.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING)) {
			service.refresh();
		}
	}));
	// 見回りは定期実行の台帳に載せる。走らせる前の門（機能のオン・一時停止など）をこちらが答え、Bot を消したら定義も消す
	const scheduledRuns = paradisSharedScheduledRunsService();
	const logService = accessor.get(ILogService);
	if (scheduledRuns !== undefined) {
		store.add(scheduledRuns.setBotPatrolGate({
			check: botId => service.patrolGateState(botId),
			botName: botId => service.getBot(botId)?.name,
			closeIdlePatrolPanes: botId => service.closeIdlePatrolPanes(botId),
		}));
		store.add(service.onDidRemoveBot(botId => {
			scheduledRuns.deleteBotPatrols(botId).catch(error => logService.warn('[ParadisBots] could not remove the look-around schedule of a removed bot', error));
		}));
	}
	store.add(paradisRegisterMcpToolProvider(new ParadisBotToolProvider(service, enabled)));
	// Bot 同士の伝言（宛先とグループの記録はグループの機能が差し込む口から引く）
	store.add(paradisRegisterMcpToolProvider(new ParadisBotMessageToolProvider(service, enabled)));
	// 管理の道具の書く側は、IDE 系の書く道具と同じ設定の下（スキーマは画面側でしか登録されないので生の値を読む）
	store.add(paradisRegisterMcpToolProvider(new ParadisBotManageToolProvider(service, {
		actionsEnabled: () => paradisAgentIdeActionsAllowed(configurationService.getValue(PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING)),
		botsEnabled: enabled,
	})));
	// スマホへ送る Bot の一覧（PR 16、bots.page.v1）
	store.add(new ParadisBotsMobileFeed(service, configurationService));
	// Bot のペインからは、別のペインを起こす・動かす IDE の道具を断る
	store.add(paradisRegisterAgentIdeActionRefusal(paradisBotIdeActionRefusal(service)));
	store.add({
		dispose: () => {
			if (shared === service) {
				shared = undefined;
			}
		},
	});
	return store;
});
