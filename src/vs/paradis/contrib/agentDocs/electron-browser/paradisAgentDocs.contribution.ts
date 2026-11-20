/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 呼び出し元ペインのウィンドウとして、資料のツールの受け口（paradisAgentDocsChannel.ts）を shared process へ登録する。
// ペイン → スペースの解き方は preview_file・メモと同じ（paradisAgentDocsPaneFolder.ts）。確認はページ共有と同じ承認のダイアログ。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_AGENT_DOCS_CHANNEL } from '../common/paradisAgentDocs.js';
import { ParadisAgentDocsChannel } from './paradisAgentDocsChannel.js';
import { paradisDocPaneFolder } from './paradisAgentDocsPaneFolder.js';

class ParadisAgentDocsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentDocs';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IParadisPaneTokenService paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
		@IParadisAgentBrowserTabsService approvals: IParadisAgentBrowserTabsService,
	) {
		super();
		const channel = new ParadisAgentDocsChannel(
			{
				remoteAuthority: environmentService.remoteAuthority,
				paneKnown: token => paneTokenService.getInstanceForToken(token) !== undefined,
				paneFolder: token => paradisDocPaneFolder(token, { paneTokenService, terminalScopeService, workspaceSwitchService, worktreeService, workspaceContextService }),
				stat: async resource => {
					if (!await fileService.exists(resource)) {
						return undefined;
					}
					const stat = await fileService.stat(resource);
					return { isFile: stat.isFile };
				},
				realpath: resource => fileService.realpath(resource),
			},
			async (token, request, cancellation) => {
				// ダイアログはウィンドウ側の締め切りで閉じる。shared process の待ちはそれより長い
				const deadline = new ParadisApprovalDeadline(cancellation);
				try {
					const outcome = await approvals.askApproval(token, request, deadline.token);
					return outcome === 'cancelled' && deadline.timedOut ? 'timedOut' : outcome;
				} finally {
					deadline.dispose();
				}
			},
		);
		sharedProcessService.registerChannel(PARADIS_AGENT_DOCS_CHANNEL, channel);
	}
}

registerWorkbenchContribution2(ParadisAgentDocsContribution.ID, ParadisAgentDocsContribution, WorkbenchPhase.AfterRestored);
