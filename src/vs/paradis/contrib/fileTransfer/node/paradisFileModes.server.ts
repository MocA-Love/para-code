/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（REH）の権限のチャネル。`paradis.server.contribution.ts` から副作用 import で読み込まれる。
// このチャネルを持たない古い REH では、ウィンドウ側が `Unknown channel` で気づき、権限の行とメニューを隠す。

import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_FILE_MODES_CHANNEL } from '../common/paradisFileTransfer.js';
import { ParadisFileModesChannel, ParadisFileModesService } from './paradisFileModesService.js';

ParadisServerContributions.register('fileModes', ({ server }) => {
	server.registerChannel(PARADIS_FILE_MODES_CHANNEL, new ParadisFileModesChannel<RemoteAgentConnectionContext>(new ParadisFileModesService()));
});
