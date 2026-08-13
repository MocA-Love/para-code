/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getParadisOverwriteLoopGuard, shouldStopParadisOverwriteLoop } from '../../common/paradisWin32UpdateGuard.js';
import { StateType, UpdateType } from '../../common/update.js';

suite('ParadisWin32UpdateGuard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns the overwrite reset, idle transition, and early-return signal only for a matching non-empty overwrite', () => {
		for (const { stateType, pendingVersion, offeredVersion, shouldStop, expected } of [
			{
				stateType: StateType.Overwriting,
				pendingVersion: '1.2.3',
				offeredVersion: '1.2.3',
				shouldStop: true,
				expected: {
					overwrite: false,
					state: { type: StateType.Idle, updateType: UpdateType.Setup, error: undefined, notAvailable: undefined },
					shouldReturn: true
				}
			},
			{ stateType: StateType.Overwriting, pendingVersion: '1.2.3', offeredVersion: '1.2.4', shouldStop: false, expected: undefined },
			{ stateType: StateType.Ready, pendingVersion: '1.2.3', offeredVersion: '1.2.3', shouldStop: false, expected: undefined },
			{ stateType: StateType.Overwriting, pendingVersion: '', offeredVersion: '', shouldStop: false, expected: undefined }
		]) {
			assert.deepStrictEqual(getParadisOverwriteLoopGuard(stateType, pendingVersion, offeredVersion, UpdateType.Setup, false), expected);
			assert.strictEqual(shouldStopParadisOverwriteLoop(stateType, pendingVersion, offeredVersion), shouldStop);
		}
	});
});
