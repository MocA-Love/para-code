/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isParadisBindingScopeEligibilityError } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisBindPageToPaneOperation } from '../../common/paradisAgentBrowserBindingOperation.js';

suite('paradisBindPageToPaneOperation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rejects an ineligible bind before page sharing or IPC starts', async () => {
		let sharingStarted = false;
		let ipcStarted = false;
		await assert.rejects(
			paradisBindPageToPaneOperation(
				{ eligible: false, reason: 'differentScope' },
				async () => {
					sharingStarted = true;
					return true;
				},
				async () => { ipcStarted = true; },
			),
			error => isParadisBindingScopeEligibilityError(error) && error.reason === 'differentScope',
		);
		assert.strictEqual(sharingStarted, false);
		assert.strictEqual(ipcStarted, false);
	});

	test('runs IPC only after eligible page sharing succeeds', async () => {
		const calls: string[] = [];
		assert.strictEqual(await paradisBindPageToPaneOperation(
			{ eligible: true },
			async () => {
				calls.push('share');
				return true;
			},
			async () => { calls.push('ipc'); },
		), true);
		assert.deepStrictEqual(calls, ['share', 'ipc']);

		calls.length = 0;
		assert.strictEqual(await paradisBindPageToPaneOperation(
			{ eligible: true },
			async () => {
				calls.push('share');
				return false;
			},
			async () => { calls.push('ipc'); },
		), false);
		assert.deepStrictEqual(calls, ['share']);
	});
});
