/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ITerminalGroup } from './terminal.js';

/** Restores the active pane after every asynchronously created pane has joined its group. */
export function paradisRestoreTerminalGroupActiveInstance(group: ITerminalGroup | undefined, activePersistentProcessId: number | undefined): void {
	if (group === undefined || activePersistentProcessId === undefined) {
		return;
	}
	const activeIndex = group.terminalInstances.findIndex(instance => {
		const attachTarget = instance.shellLaunchConfig.attachPersistentProcess;
		return attachTarget?.id === activePersistentProcessId
			|| attachTarget?.paradisRevivedFromPersistentProcessId === activePersistentProcessId;
	});
	if (activeIndex !== -1) {
		group.setActiveInstanceByIndex(activeIndex);
	}
}
