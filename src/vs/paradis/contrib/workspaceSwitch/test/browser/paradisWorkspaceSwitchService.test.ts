/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisApplySameUriScopeCorrection, paradisRunBestEffortPhases } from '../../browser/paradisWorkspaceSwitchService.js';
import { paradisShouldAutoRetireMissingWorktree } from '../../browser/paradisWorktreeService.js';

suite('ParadisWorkspaceSwitchService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks the window managed before a same-URI state-key correction returns', async () => {
		const calls: string[] = [];
		await paradisApplySameUriScopeCorrection(
			'space-old',
			'space-corrected',
			() => calls.push('set'),
			stateKey => calls.push(`switch:${stateKey}`),
			() => calls.push('managed'),
			async () => { calls.push('scope'); },
		);
		assert.deepStrictEqual(calls, ['managed', 'set', 'scope', 'switch:space-corrected']);
	});

	test('does not emit a duplicate switch when the state key is unchanged', async () => {
		const calls: string[] = [];
		await paradisApplySameUriScopeCorrection(
			'space-a',
			'space-a',
			() => calls.push('set'),
			stateKey => calls.push(`switch:${stateKey}`),
			() => calls.push('managed'),
		);
		assert.deepStrictEqual(calls, ['managed', 'set']);
	});

	test('runs identity and pending-state cleanup even when content restoration fails', async () => {
		const calls: string[] = [];
		const errors: string[] = [];
		await paradisRunBestEffortPhases([
			() => { calls.push('workingSet'); throw new Error('restore failed'); },
			() => { calls.push('liveEditors'); throw new Error('live restore failed'); },
			() => { calls.push('identity'); },
			() => { calls.push('pending'); },
			() => { calls.push('backups'); },
		], error => errors.push((error as Error).message));

		assert.deepStrictEqual(calls, ['workingSet', 'liveEditors', 'identity', 'pending', 'backups']);
		assert.deepStrictEqual(errors, ['restore failed', 'live restore failed']);
	});

	test('never auto-retires the active missing worktree', () => {
		assert.strictEqual(paradisShouldAutoRetireMissingWorktree(true, false, true), false);
		assert.strictEqual(paradisShouldAutoRetireMissingWorktree(true, false, false), true);
		assert.strictEqual(paradisShouldAutoRetireMissingWorktree(true, true, false), false);
	});
});
