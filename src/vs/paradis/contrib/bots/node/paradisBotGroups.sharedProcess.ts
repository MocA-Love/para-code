/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で Bot グループの台帳のサービスを作り、ウィンドウへチャネルを出す。
// `paradis.sharedProcess.contribution.ts` から、Bot の台帳（paradisBots.sharedProcess.ts）の後に副作用 import される。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_BOT_GROUPS_CHANNEL } from '../common/paradisBotGroupsApi.js';
import { ParadisBotGroupsChannel } from './paradisBotGroupsChannel.js';
import { createParadisBotGroupsFile, ParadisBotGroupsService } from './paradisBotGroupsService.js';

let shared: ParadisBotGroupsService | undefined;

/**
 * shared process に 1 つだけの Bot グループのサービス。登録の前は undefined。Bot 同士の伝言の道具はここから
 * `groupsOf`（呼び出し元の Bot のグループ）と `appendRecord`（「聞きました・伝えました」）を呼ぶ。
 */
export function paradisSharedBotGroupsService(): ParadisBotGroupsService | undefined {
	return shared;
}

ParadisSharedProcessContributions.register('botGroups', ({ server, accessor }) => {
	const store = new DisposableStore();
	const service = store.add(new ParadisBotGroupsService(createParadisBotGroupsFile(accessor.get(INativeEnvironmentService).userDataPath), accessor.get(ILogService)));
	server.registerChannel(PARADIS_BOT_GROUPS_CHANNEL, new ParadisBotGroupsChannel(service));
	shared = service;
	store.add({
		dispose: () => {
			if (shared === service) {
				shared = undefined;
			}
		},
	});
	return store;
});
