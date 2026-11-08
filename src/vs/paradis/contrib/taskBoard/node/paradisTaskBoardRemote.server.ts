/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードの SSH 中継の、接続先（REH）のチャネル（q.html Q472 = A）。`paradis.server.contribution.ts` から
// 副作用 import で読み込まれる。呼ぶのは手元のウィンドウだけで、ウィンドウ側はまだ無い（設計書の PR 2 で足す）。

import { ILogService } from '../../../../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { PARADIS_TASK_BOARD_REMOTE_CHANNEL } from '../common/paradisTaskBoardRemote.js';
import { ParadisTaskBoardRemoteChannel, ParadisTaskBoardRemoteService } from './paradisTaskBoardRemoteService.js';
import { paradisTaskBoardWorktreeIncludes } from './paradisTaskBoardWorktreeIncludes.js';
import { ParadisWorktreeGitService } from '../../workspaceSwitch/node/paradisWorktreeGitChannel.js';

ParadisServerContributions.register('taskBoardRemote', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const shellEnv = new ParadisCachedShellEnv(logService, 'ParadisTaskBoardRemote', createParadisShellEnvResolver(logService), Date.now, reportParadisShellEnvDiagnosticError);
	// ボードのワークツリーへの持ち込み（762-RES）は、スペースの作成と同じ口で行う
	const includes = paradisTaskBoardWorktreeIncludes(new ParadisWorktreeGitService(logService), logService);
	const service = new ParadisTaskBoardRemoteService(logService, () => shellEnv.getEnv(), undefined, undefined, undefined, undefined, undefined, undefined, includes);
	server.registerChannel(PARADIS_TASK_BOARD_REMOTE_CHANNEL, new ParadisTaskBoardRemoteChannel<RemoteAgentConnectionContext>(service));
	return service;
});
