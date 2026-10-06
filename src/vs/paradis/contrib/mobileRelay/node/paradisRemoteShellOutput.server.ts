/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（REH）で、Claude Code のバックグラウンドのシェルの出力の末尾を読むチャネル。`paradis.server.contribution.ts`
// から副作用 import で読み込まれる。取り決めは common/paradisRemoteShellOutput.ts。
// このチャネルを持たない古い REH では、ウィンドウ側の呼び出しが失敗し、アプリには「読めない」と出る。

import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_REMOTE_SHELL_OUTPUT_CHANNEL } from '../common/paradisRemoteShellOutput.js';
import { ParadisRemoteShellOutputChannel } from './paradisRemoteShellOutputChannel.js';

ParadisServerContributions.register(PARADIS_REMOTE_SHELL_OUTPUT_CHANNEL, ({ server }) => {
	server.registerChannel(PARADIS_REMOTE_SHELL_OUTPUT_CHANNEL, new ParadisRemoteShellOutputChannel<RemoteAgentConnectionContext>());
});
