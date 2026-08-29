/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisRestoreTerminalGroupActiveInstance } from '../../browser/paradisTerminalGroupRestore.js';
import { ITerminalGroup, ITerminalInstance } from '../../browser/terminal.js';

suite('paradisRestoreTerminalGroupActiveInstance', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('restores a non-last active pane after asynchronous group creation', () => {
		let activeIndex = 2;
		const terminalInstances = [1, 2, 3].map(id => ({
			shellLaunchConfig: { attachPersistentProcess: { id } },
		}) as Partial<ITerminalInstance> as ITerminalInstance);
		const group = {
			terminalInstances,
			setActiveInstanceByIndex: (index: number) => { activeIndex = index; },
		} as Partial<ITerminalGroup> as ITerminalGroup;

		paradisRestoreTerminalGroupActiveInstance(group, 1);

		assert.strictEqual(activeIndex, 0);
	});
});
