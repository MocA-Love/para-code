/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）の aivis-mcp へ通知の辞書を書くチャネルを足す。`paradis.server.contribution.ts` から
// 副作用 import で読み込まれる。接続先のエージェントは接続先の aivis-mcp で読み上げるので、そちらにも同じ辞書を書く。
// PATH はサーバーが継承したものをそのまま使う（rtk・ccusage のサーバー版と同じ）。辞書の設定は REH からは
// 読めないので、書くかどうか・何を書くかはウィンドウが決めて渡す。

import { ILogService } from '../../../../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_AGENT_DICTIONARY_CHANNEL } from '../common/paradisAgentDictionary.js';
import { ParadisAgentDictionarySyncChannel, ParadisAgentDictionarySyncService } from './paradisAgentDictionarySync.js';

ParadisServerContributions.register(PARADIS_AGENT_DICTIONARY_CHANNEL, ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const service = new ParadisAgentDictionarySyncService({ getEnv: async () => process.env, logService });
	server.registerChannel(PARADIS_AGENT_DICTIONARY_CHANNEL, new ParadisAgentDictionarySyncChannel<RemoteAgentConnectionContext>(service));
});
