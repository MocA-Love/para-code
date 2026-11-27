/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で Bot グループの台帳のサービスを作り、ウィンドウへチャネルを出す。
// `paradis.sharedProcess.contribution.ts` から、Bot の台帳（paradisBots.sharedProcess.ts）の後に副作用 import される。
// Bot 同士の伝言の道具へは、`paradisRegisterBotGroupsPort` で口（グループの引き当て・「聞きました・伝えました」の記録＝宛先の受け箱・受け箱を読む・既読にする）を渡す。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_BOT_GROUPS_CHANNEL } from '../common/paradisBotGroupsApi.js';
import { ParadisBotGroupsChannel } from './paradisBotGroupsChannel.js';
import { paradisRegisterBotGroupsPort } from './paradisBotMessageToolProvider.js';
import { paradisSharedBotsService } from './paradisBots.sharedProcess.js';
import { createParadisBotGroupsFile, ParadisBotGroupsService, paradisBotGroupsMessagePort } from './paradisBotGroupsService.js';

let shared: ParadisBotGroupsService | undefined;

/** shared process に 1 つだけの Bot グループのサービス。登録の前は undefined。 */
export function paradisSharedBotGroupsService(): ParadisBotGroupsService | undefined {
	return shared;
}

ParadisSharedProcessContributions.register('botGroups', ({ server, accessor }) => {
	const store = new DisposableStore();
	const service = store.add(new ParadisBotGroupsService(createParadisBotGroupsFile(accessor.get(INativeEnvironmentService).userDataPath), accessor.get(ILogService)));
	server.registerChannel(PARADIS_BOT_GROUPS_CHANNEL, new ParadisBotGroupsChannel(service));
	shared = service;
	// Bot 同士の伝言の道具（paradisBotMessageToolProvider.ts）へ、グループの台帳の口を差し込む
	store.add(paradisRegisterBotGroupsPort(paradisBotGroupsMessagePort(service)));
	// Bot を消したら、その Bot 宛ての未読を捨てる（読む者がいないまま、1 体につき最大 30 通が残り続けないように）
	const bots = paradisSharedBotsService();
	if (bots !== undefined) {
		const logService = accessor.get(ILogService);
		store.add(bots.onDidRemoveBot(botId => {
			service.forgetBot(botId).catch(error => logService.warn('[ParadisBotGroups] could not drop the unread messages of a removed bot', error));
		}));
	} else {
		// Bot の台帳（paradisBots.sharedProcess.ts）が先に登録されていない。消した Bot 宛ての未読は上限で刈られるまで残る
		accessor.get(ILogService).warn('[ParadisBotGroups] the bots service is not registered; unread messages of removed bots are kept');
	}
	store.add({
		dispose: () => {
			if (shared === service) {
				shared = undefined;
			}
		},
	});
	return store;
});
