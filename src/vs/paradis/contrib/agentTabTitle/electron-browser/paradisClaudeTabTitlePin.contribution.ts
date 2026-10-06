/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// hook で確かめた Claude Code の会話を、タブ名の側（terminalInstance.ts の PARA-PATCH）へ伝えて、
// 再開・`/rename` した会話でも OSC タイトル（`✳ <名前>`）をタブ名に出す。決め方は
// ../common/paradisClaudeTabTitlePin.ts。hook が届かない環境（WSL・hook の信頼なし・古い Claude Code）では
// 会話が載らないので、今までどおり OSC タイトルとプロセス名だけで決まる。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { GeneralShellType } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisCollectLivePaneInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneSession } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { ParadisClaudeTabTitlePinTracker, ParadisTitlePinAction } from '../common/paradisClaudeTabTitlePin.js';

/** terminalInstance.ts の PARA-PATCH が足したメソッド（インターフェースは広げない）。 */
interface IParadisAgentShellTypePinnable {
	paradisSetAgentShellTypeFromHooks(shellType: GeneralShellType | undefined): void;
}

function isPinnable(instance: ITerminalInstance): instance is ITerminalInstance & IParadisAgentShellTypePinnable {
	return typeof (instance as Partial<IParadisAgentShellTypePinnable>).paradisSetAgentShellTypeFromHooks === 'function';
}

class ParadisClaudeTabTitlePinContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisClaudeTabTitlePin';

	private readonly tracker = new ParadisClaudeTabTitlePinTracker();
	private sessions: ReadonlyMap<string, IParadisAgentPaneSession> = new Map();

	constructor(
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
	) {
		super();
		this._register(snapshotService.subscribe(outcome => {
			if (outcome.snapshot === undefined) {
				return;
			}
			this.sessions = new Map((outcome.snapshot.paneSessions ?? []).map(session => [session.token, session]));
			this.updateAll();
		}));
		// 前面のプロセスが変わったら（Claude を起動した・シェルへ戻った）、次のスナップショットを待たずに決める
		this._register(this.terminalService.onAnyInstanceShellTypeChanged(instance => this.updateInstance(instance)));
		this._register(this.terminalService.onDidDisposeInstance(instance => this.tracker.forget(instance.instanceId)));
	}

	private updateAll(): void {
		const panes = paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService);
		this.tracker.retain(new Set(panes.map(pane => pane.instance.instanceId)));
		for (const { instance, token } of panes) {
			this.apply(instance, this.tracker.decide(instance.instanceId, instance.shellType, this.sessions.get(token)));
		}
	}

	private updateInstance(instance: ITerminalInstance): void {
		const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
		if (token === undefined || this.paneTokenService.getInstanceForToken(token) !== instance.instanceId) {
			return;
		}
		this.apply(instance, this.tracker.decide(instance.instanceId, instance.shellType, this.sessions.get(token)));
	}

	private apply(instance: ITerminalInstance, action: ParadisTitlePinAction | undefined): void {
		if (action === undefined || instance.isDisposed || !isPinnable(instance)) {
			return;
		}
		instance.paradisSetAgentShellTypeFromHooks(action === 'pin' ? GeneralShellType.Claude : undefined);
	}
}

registerWorkbenchContribution2(ParadisClaudeTabTitlePinContribution.ID, ParadisClaudeTabTitlePinContribution, WorkbenchPhase.AfterRestored);
