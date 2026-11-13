/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PosixShellType } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisParkedTerminalUnattendedRestartBlocker } from '../../browser/paradisTerminalUnattendedRestart.contribution.js';

suite('Paradis parked terminals and the unattended restart', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function terminal(instanceId: number, hasChildProcesses: boolean): ITerminalInstance {
		return {
			instanceId,
			isDisposed: false,
			hasChildProcesses,
			shellType: PosixShellType.Zsh,
			shouldPersist: true,
			capabilities: { get: () => undefined } as unknown as ITerminalInstance['capabilities'],
		} as Partial<ITerminalInstance> as ITerminalInstance;
	}

	test('blocks on a parked terminal that runs a process, and leaves the visible ones to upstream', () => {
		const visibleBusy = terminal(1, true);
		const parkedBusy = terminal(2, true);
		assert.deepStrictEqual({
			onlyVisible: paradisParkedTerminalUnattendedRestartBlocker([visibleBusy], [visibleBusy]),
			parked: paradisParkedTerminalUnattendedRestartBlocker([], [parkedBusy]),
			nothing: paradisParkedTerminalUnattendedRestartBlocker([], []),
		}, {
			onlyVisible: undefined,
			parked: 'terminal.runningProcess',
			nothing: undefined,
		});
	});
});
