/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 手元（shared process）へモデルの一覧のチャネルを足す。`paradis.sharedProcess.contribution.ts` から副作用 import で
// 読み込まれる。手元のウィンドウは、手元にインストールされた Claude Code / Codex の一覧をここから受け取る。

import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_AGENT_MODEL_CATALOG_CHANNEL } from '../common/paradisAgentModelCatalog.js';
import { paradisCreateAgentModelCatalogChannel } from './paradisAgentModelCatalog.js';

ParadisSharedProcessContributions.register('agentModelCatalog', ({ server, accessor }) => {
	server.registerChannel(PARADIS_AGENT_MODEL_CATALOG_CHANNEL, paradisCreateAgentModelCatalogChannel<string>(accessor));
});
