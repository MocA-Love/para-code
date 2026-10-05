/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 手元の aivis-mcp へ通知の辞書を書くチャネルを shared process に足す。`paradis.sharedProcess.contribution.ts`
// から副作用 import で読み込まれる。aivis-mcp はログインシェル由来の PATH で探す（`--ingest` と同じ）。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_AGENT_DICTIONARY_CHANNEL } from '../common/paradisAgentDictionary.js';
import { ParadisAgentDictionarySyncChannel, ParadisAgentDictionarySyncService } from './paradisAgentDictionarySync.js';

ParadisSharedProcessContributions.register(PARADIS_AGENT_DICTIONARY_CHANNEL, ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const shellEnv = new ParadisCachedShellEnv(logService, 'ParadisAgentDictionary', createParadisShellEnvResolver(logService, configurationService, environmentService.args));
	const service = new ParadisAgentDictionarySyncService({ getEnv: () => shellEnv.getEnv(), logService });
	server.registerChannel(PARADIS_AGENT_DICTIONARY_CHANNEL, new ParadisAgentDictionarySyncChannel<string>(service));
});
