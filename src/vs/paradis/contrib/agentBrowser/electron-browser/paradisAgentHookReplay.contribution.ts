/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code が止まっている間の許可要求・質問を控えから流し直したとき（W2-20）、その確認が画面に今も
// 出ているかをこのウィンドウで確かめ、出ていれば shared process へ伝える。伝えて初めて状態と承認カードが
// 出る。再起動の後の画面を見ずに承認カードを出すと、答えたつもりで別の確認に答えてしまうため。
//
// 出ていない間は何も言わない（shared process 側が 10 分で捨てる）。画面がまだ戻っていないだけの
// こともあるので、スナップショット（2 秒ごと）のたびに見直す。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisVisibleTerminalText } from '../../agentChat/browser/paradisAgentTuiInput.js';
import { paradisCollectAllTerminalInstances } from '../browser/paradisLivePaneInstances.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { paradisReplayedPromptShownOnScreen } from '../browser/paradisReplayedPromptCheck.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from './paradisAgentStatusSnapshotService.js';

class ParadisAgentHookReplayScreenCheck extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.agentHookReplayScreenCheck';

	/** 伝えている最中のペイン（同じペインを二重に伝えない）。 */
	private readonly confirming = new Set<string>();

	constructor(
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(snapshotService.subscribe(outcome => {
			for (const prompt of outcome.snapshot?.replayedPrompts ?? []) {
				this.check(prompt.token, prompt.status);
			}
		}));
	}

	private check(token: string, status: 'permission' | 'question'): void {
		if (this.confirming.has(token)) {
			return;
		}
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			return;
		}
		const instance = paradisCollectAllTerminalInstances(this.terminalService, this.terminalGroupService).find(candidate => candidate.instanceId === instanceId);
		if (instance === undefined || !paradisReplayedPromptShownOnScreen(status, paradisVisibleTerminalText(instance))) {
			return;
		}
		this.confirming.add(token);
		this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call<boolean>('confirmReplayedPrompt', [token])
			.catch(error => this.logService.warn('[paradisAgentHookReplay] could not confirm a replayed prompt', error))
			.finally(() => this.confirming.delete(token));
	}
}

registerWorkbenchContribution2(ParadisAgentHookReplayScreenCheck.ID, ParadisAgentHookReplayScreenCheck, WorkbenchPhase.AfterRestored);
