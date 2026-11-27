/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で、para-browser MCP の `ask_human` と、答えをウィンドウへ流すチャネルを足す。
// `paradis.sharedProcess.contribution.ts` から副作用 import される。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { PARADIS_ASK_HUMAN_CHANNEL } from '../common/paradisAskHumanTool.js';
import { ParadisAskHumanChannel, ParadisAskHumanToolProvider, paradisAskHumanIsBotPane } from './paradisAskHumanToolProvider.js';
import { paradisSharedHumanAskService } from './paradisHumanAskChannel.js';

ParadisSharedProcessContributions.register('askHuman', ({ server }) => {
	const store = new DisposableStore();
	// Bot のペインかは、Bot の登録（MCP の説明の順のため最後に登録する）が渡す口で、呼ばれたときに引く
	const provider = store.add(new ParadisAskHumanToolProvider(paradisSharedHumanAskService(), { isBotPane: paradisAskHumanIsBotPane }));
	store.add(onParadisAgentHookEvent(event => provider.onHookEvent(event)));
	server.registerChannel(PARADIS_ASK_HUMAN_CHANNEL, new ParadisAskHumanChannel(provider));
	store.add(paradisRegisterMcpToolProvider(provider));
	return store;
});
