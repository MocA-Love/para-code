/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）へモデルの一覧のチャネルを足す。`paradis.server.contribution.ts` から副作用 import で読み込まれる。
//
// SSH のウィンドウではエージェントが接続先で動くので、選べるモデルは接続先にインストールされた Claude Code / Codex の
// 版で決まる。手元と同じサービスを接続先で動かし、キャッシュは接続先のユーザーデータに置く（同じ接続先へ繋いだ
// ウィンドウどうしで共通。CLI を起こすのは版が変わったときだけ、という決まりも手元と同じ）。
// このチャネルを持たない古い REH では、ウィンドウが `Unknown channel` で気づき、別名だけの固定の候補を使う。

import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_AGENT_MODEL_CATALOG_CHANNEL } from '../common/paradisAgentModelCatalog.js';
import { paradisCreateAgentModelCatalogChannel } from './paradisAgentModelCatalog.js';

ParadisServerContributions.register('agentModelCatalog', ({ server, accessor }) => {
	server.registerChannel(PARADIS_AGENT_MODEL_CATALOG_CHANNEL, paradisCreateAgentModelCatalogChannel<RemoteAgentConnectionContext>(accessor));
});
