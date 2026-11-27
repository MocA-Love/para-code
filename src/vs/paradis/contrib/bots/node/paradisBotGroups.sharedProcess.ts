/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で Bot グループの台帳のサービスを作り、ウィンドウへチャネルを出す。
// `paradis.sharedProcess.contribution.ts` から、Bot の台帳（paradisBots.sharedProcess.ts）の後に副作用 import される。
// Bot 同士の伝言の道具へは、`paradisRegisterBotGroupsPort` で口（グループの引き当て・「聞きました・伝えました」の記録・届けられなかった印）を渡す。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_BOT_GROUPS_CHANNEL } from '../common/paradisBotGroupsApi.js';
import { ParadisBotGroupsChannel } from './paradisBotGroupsChannel.js';
import { paradisRegisterBotGroupsPort } from './paradisBotMessageToolProvider.js';
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
	store.add({
		dispose: () => {
			if (shared === service) {
				shared = undefined;
			}
		},
	});
	return store;
});
