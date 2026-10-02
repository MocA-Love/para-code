/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 手元（このマシン）の権限のチャネルを shared process に足す。`paradis.sharedProcess.contribution.ts` から
// 副作用 import で読み込まれる。SSH のウィンドウでも、左（このマシン）はこちらを使う。

import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_FILE_MODES_CHANNEL } from '../common/paradisFileTransfer.js';
import { ParadisFileModesChannel, ParadisFileModesService } from './paradisFileModesService.js';

ParadisSharedProcessContributions.register('fileModes', ({ server }) => {
	server.registerChannel(PARADIS_FILE_MODES_CHANNEL, new ParadisFileModesChannel<string>(new ParadisFileModesService()));
});
