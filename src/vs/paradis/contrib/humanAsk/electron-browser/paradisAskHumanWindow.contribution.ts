/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `ask_human`（paradisAskHumanToolProvider.ts）が呼び出し元ペインの名札を引く、ウィンドウ側の口。
// 名札はこのウィンドウの windowId・スペースの状態キーと名前・worktree の名前・タブの題名だけで、
// エージェントからは受け取らない（問いのカードの「だれから」をエージェントに偽らせない）。
// 答えを届ける側は paradisHumanAskPaneAnswer.contribution.ts（ペインの質問と同じ口）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAskHumanPaneLabel, PARADIS_ASK_HUMAN_DESCRIBE_METHOD, PARADIS_ASK_HUMAN_WINDOW_CHANNEL } from '../common/paradisAskHumanTool.js';

class ParadisAskHumanWindow extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAskHumanWindow';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super();
		const channel: IServerChannel<string> = {
			listen: <T>(_ctx: string, event: string): Event<T> => {
				throw new Error(`Event not found: ${event}`);
			},
			call: async <T>(_ctx: string, command: string, arg?: unknown): Promise<T> => {
				if (command !== PARADIS_ASK_HUMAN_DESCRIBE_METHOD) {
					throw new Error(`Method not found: ${command}`);
				}
				const token = Array.isArray(arg) ? arg[0] : undefined;
				return (typeof token === 'string' ? this.describe(token) : undefined) as T;
			},
		};
		sharedProcessService.registerChannel(PARADIS_ASK_HUMAN_WINDOW_CHANNEL, channel);
	}

	/** そのペインの名札。このウィンドウのペインでなければ undefined。 */
	private describe(token: string): IParadisAskHumanPaneLabel | undefined {
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		const instance = instanceId !== undefined ? this.terminalService.getInstanceFromId(instanceId) : undefined;
		if (instanceId === undefined || instance === undefined) {
			return undefined;
		}
		const stateKey = this.terminalScopeService.getStateKeyForInstance(instanceId);
		const tab = instance.title || undefined;
		const base = { windowId: this.nativeHostService.windowId, ...(stateKey !== undefined ? { stateKey } : {}), ...(tab !== undefined ? { tab } : {}) };
		if (stateKey !== undefined) {
			for (const repository of this.workspaceSwitchService.repositories) {
				if (repository.id === stateKey && repository.name) {
					return { ...base, space: repository.name };
				}
				for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
					if (paradisWorktreeStateKey(worktree.uri) === stateKey && repository.name) {
						return { ...base, space: repository.name, ...(worktree.name ? { worktree: worktree.name } : {}) };
					}
				}
			}
		}
		// スペースに属さないターミナル（切り替え直後・スコープ外）はワークスペースのフォルダ名
		const folder = this.contextService.getWorkspace().folders[0]?.name;
		return folder ? { ...base, space: folder } : undefined;
	}
}

registerWorkbenchContribution2(ParadisAskHumanWindow.ID, ParadisAskHumanWindow, WorkbenchPhase.AfterRestored);
