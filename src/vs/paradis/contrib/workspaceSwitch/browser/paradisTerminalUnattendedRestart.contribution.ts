/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { getTerminalInstanceBlocker } from '../../../../workbench/contrib/terminal/browser/terminalUnattendedRestart.js';
import { IUnattendedRestartService } from '../../../../workbench/services/lifecycle/common/unattendedRestart.js';
import { paradisCollectAllTerminalInstances } from './paradisTerminalEditorPark.js';

/**
 * スペース切り替えで待避した端末を、無人の再起動（1.146 の `update.restartWhenIdle`）の判定に入れる。
 *
 * upstream の `TerminalUnattendedRestartParticipant` は `ITerminalService.instances` だけを見る。待避中の
 * パネルのグループ（`paradisParkedGroups`）とエディタの端末（待避の台帳）はそこに入らないので、別のスペースで
 * エージェントの CLI が動いていても再起動が進んでしまう。待避中の端末だけを、upstream と同じ判定
 * （{@link getTerminalInstanceBlocker} と、再起動後に戻せるか）にかける。見えている端末は upstream が見る。
 */
export function paradisParkedTerminalUnattendedRestartBlocker(visible: readonly ITerminalInstance[], all: readonly ITerminalInstance[]): string | undefined {
	const visibleIds = new Set(visible.map(instance => instance.instanceId));
	const parked = all.filter(instance => !instance.isDisposed && !visibleIds.has(instance.instanceId));
	for (const instance of parked) {
		const blocker = getTerminalInstanceBlocker(instance);
		if (blocker) {
			return blocker;
		}
	}
	if (parked.some(instance => !instance.shouldPersist)) {
		return 'terminal.notRestorable';
	}
	return undefined;
}

class ParadisTerminalUnattendedRestartParticipant extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.terminal.parkedUnattendedRestartParticipant';

	constructor(
		@IUnattendedRestartService unattendedRestartService: IUnattendedRestartService,
		@ITerminalService terminalService: ITerminalService,
		@ITerminalGroupService terminalGroupService: ITerminalGroupService,
	) {
		super();
		this._register(unattendedRestartService.registerParticipant({
			check: () => paradisParkedTerminalUnattendedRestartBlocker(terminalService.instances, paradisCollectAllTerminalInstances(terminalService, terminalGroupService)),
		}));
	}
}

registerWorkbenchContribution2(ParadisTerminalUnattendedRestartParticipant.ID, ParadisTerminalUnattendedRestartParticipant, WorkbenchPhase.AfterRestored);
