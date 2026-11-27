/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で Bot の台帳のサービスを作り、ウィンドウへチャネルを出し、para-browser MCP へ Bot の道具を足す。
// `paradis.sharedProcess.contribution.ts` から副作用 import される（MCP の説明の段は登録の順に並ぶので、並びの最後に置く）。

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_MCP_PORT_FILE_NAME } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { paradisCodexHomeCandidates } from '../../agentBrowser/node/paradisAgentHome.js';
import { onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING, paradisAgentIdeActionsAllowed } from '../../agentIde/common/paradisAgentIde.js';
import { paradisRegisterAgentIdeActionRefusal } from '../../agentIde/node/paradisAgentIdeToolProvider.js';
import { paradisResolveAgentTemplates } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { paradisSharedHumanAskService } from '../../humanAsk/node/paradisHumanAskChannel.js';
import { PARADIS_BOTS_CHANNEL, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { ParadisBotHomes } from './paradisBotHomes.js';
import { ParadisBotManageToolProvider, paradisBotIdeActionRefusal } from './paradisBotManageToolProvider.js';
import { ParadisBotToolProvider } from './paradisBotToolProvider.js';
import { ParadisBotsChannel } from './paradisBotsChannel.js';
import { ParadisBotsService } from './paradisBotsService.js';
import { ParadisBotMemorySnapshots } from './paradisBotMemorySnapshots.js';
import { paradisPrepareBotPatrolLaunch } from './paradisBotPatrolLaunch.js';
import { paradisApplyClaudeFolderTrust, paradisClaudeTrustKeysFor, paradisIsTooBroadToTrust, paradisResolveClaudeGlobalConfigFile, paradisUpdateClaudeConfig } from '../../workspaceSwitch/node/paradisClaudeFolderTrust.js';
import { createParadisBotItemsFile, createParadisBotPanesFile, createParadisBotsFile, createParadisBotSuggestionsFile, paradisBotsDataFolder } from './paradisBotsStore.js';

let shared: ParadisBotsService | undefined;

/**
 * 見回りのフォルダの親を Claude Code の信頼済みにする（見回りのフォルダは起動ごとに新しいので、無いと毎回「このフォルダを
 * 信頼しますか」で止まる。信頼は配下のフォルダにも効く）。ワークツリーの信頼と同じロックと書き方。失敗しても投げない。
 */
async function trustClaudeFolder(folder: string): Promise<void> {
	try {
		const configDir = process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude');
		const legacyExists = await fs.access(join(configDir.normalize('NFC'), '.config.json')).then(() => true, () => false);
		const configFile = paradisResolveClaudeGlobalConfigFile(process.env, homedir(), () => legacyExists);
		const keys = await paradisClaudeTrustKeysFor(folder);
		if (configFile !== undefined && keys.length > 0 && !paradisIsTooBroadToTrust(keys, homedir())) {
			await paradisUpdateClaudeConfig(configFile, config => paradisApplyClaudeFolderTrust(config, keys));
		}
	} catch {
		// 信頼が書けなければ、見回りは信頼の確認で止まり、打ち切りで終わる
	}
}

/** para-browser の MCP の口のポート（Para Code が書くポートのファイルから読む。動いていなければ undefined）。 */
async function readGatewayPort(userDataPath: string): Promise<number | undefined> {
	try {
		const record: unknown = JSON.parse(await fs.readFile(join(userDataPath, PARADIS_MCP_PORT_FILE_NAME), 'utf8'));
		const port = typeof record === 'object' && record !== null ? (record as { port?: unknown }).port : undefined;
		return typeof port === 'number' && Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
	} catch {
		return undefined;
	}
}

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
		// 見回りの設定ファイルも専用フォルダ（Bot が書ける）の外に置く
		preparePatrol: (agent, botId, home) => paradisPrepareBotPatrolLaunch({
			folder: join(paradisBotsDataFolder(userDataPath), 'patrol'),
			runsFolder: join(paradisBotsDataFolder(userDataPath), 'patrol-runs'),
			stopFolder: homedir(),
			gatewayPort: () => readGatewayPort(userDataPath),
			codexConfigFiles: () => paradisCodexHomeCandidates().map(codexHome => join(codexHome, 'config.toml')),
			trustClaudeFolder: folder => trustClaudeFolder(folder),
		}, agent, botId, home),
		agentTemplate: agentId => paradisResolveAgentTemplates(configurationService, []).find(template => template.id === agentId),
	}));
	server.registerChannel(PARADIS_BOTS_CHANNEL, new ParadisBotsChannel(service));
	shared = service;
	store.add(configurationService.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING)) {
			service.refresh();
		}
	}));
	store.add(paradisRegisterMcpToolProvider(new ParadisBotToolProvider(service, enabled)));
	// 管理の道具の書く側は、IDE 系の書く道具と同じ設定の下（スキーマは画面側でしか登録されないので生の値を読む）
	store.add(paradisRegisterMcpToolProvider(new ParadisBotManageToolProvider(service, {
		actionsEnabled: () => paradisAgentIdeActionsAllowed(configurationService.getValue(PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING)),
		botsEnabled: enabled,
	})));
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
