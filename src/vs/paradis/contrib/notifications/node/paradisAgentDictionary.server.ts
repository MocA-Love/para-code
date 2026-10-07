/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）の aivis-mcp へ通知の辞書を書くチャネルを足す。`paradis.server.contribution.ts` から
// 副作用 import で読み込まれる。接続先のエージェントは接続先の aivis-mcp で読み上げるので、そちらにも同じ辞書を書く。
// aivis-mcp はログインシェル由来の PATH で探す（サーバーが ssh から継承した PATH には、npm のグローバルや
// Homebrew が入っていないことが多い。拡張ホストと同じ解決を使い、結果はサーバーの中で共有される）。
// 辞書の設定は REH からは読めないので、書くかどうか・何を書くかはウィンドウが決めて渡す。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_AGENT_DICTIONARY_CHANNEL } from '../common/paradisAgentDictionary.js';
import { ParadisAgentDictionarySyncChannel, ParadisAgentDictionarySyncService } from './paradisAgentDictionarySync.js';

ParadisServerContributions.register(PARADIS_AGENT_DICTIONARY_CHANNEL, ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const shellEnv = new ParadisCachedShellEnv(logService, 'ParadisAgentDictionary', createParadisShellEnvResolver(logService, configurationService, environmentService.args));
	const service = new ParadisAgentDictionarySyncService({ getEnv: () => shellEnv.getEnv(), logService });
	server.registerChannel(PARADIS_AGENT_DICTIONARY_CHANNEL, new ParadisAgentDictionarySyncChannel<RemoteAgentConnectionContext>(service));
});
