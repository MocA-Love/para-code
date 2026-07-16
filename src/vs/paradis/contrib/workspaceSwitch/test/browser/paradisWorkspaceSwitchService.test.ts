/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisApplySameUriScopeCorrection, paradisCancelRetirementAfterScopeRollback, paradisCommitPreparedScopeRetirement, paradisRunBestEffortPhases } from '../../browser/paradisWorkspaceSwitchService.js';
import { paradisDiscardScopeBeforeRemovingKnownWorktree, paradisShouldAutoRetireMissingWorktree } from '../../browser/paradisWorktreeService.js';

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

	test('does not close auxiliary windows before prepared editor retirement commits', async () => {
		const calls: string[] = [];
		const committed = await paradisCommitPreparedScopeRetirement(
			async () => { calls.push('editors'); return false; },
			[async () => { calls.push('auxiliary'); }],
			() => { calls.push('error'); }
		);

		assert.strictEqual(committed, false);
		assert.deepStrictEqual(calls, ['editors']);
	});

	test('finalizes auxiliary windows only after editor retirement commits', async () => {
		const calls: string[] = [];
		const errors: string[] = [];
		const committed = await paradisCommitPreparedScopeRetirement(
			async () => { calls.push('editors'); return true; },
			[
				async () => { calls.push('auxiliary'); throw new Error('close failed'); },
				async () => { calls.push('remaining'); },
			],
			error => errors.push((error as Error).message)
		);

		assert.strictEqual(committed, true);
		assert.deepStrictEqual(calls, ['editors', 'auxiliary', 'remaining']);
		assert.deepStrictEqual(errors, ['close failed']);
	});

	test('switches back before restoring a cancelled active-scope retirement', async () => {
		const calls: string[] = [];
		await paradisCancelRetirementAfterScopeRollback(
			'space-a',
			'space-b',
			async stateKey => { calls.push(`switch:${stateKey}`); },
			async () => { calls.push('cancel'); },
			() => { calls.push('error'); }
		);

		assert.deepStrictEqual(calls, ['switch:space-a', 'cancel']);
	});

	test('keeps frozen retirement data when switching back fails', async () => {
		const calls: string[] = [];
		await paradisCancelRetirementAfterScopeRollback(
			'space-a',
			'space-b',
			async () => { calls.push('switch'); throw new Error('switch failed'); },
			async () => { calls.push('cancel'); },
			error => { calls.push((error as Error).message); }
		);

		assert.deepStrictEqual(calls, ['switch', 'switch failed']);
	});

	test('never auto-retires the active missing worktree', () => {
		assert.strictEqual(paradisShouldAutoRetireMissingWorktree(true, false, true), false);
		assert.strictEqual(paradisShouldAutoRetireMissingWorktree(true, false, false), true);
		assert.strictEqual(paradisShouldAutoRetireMissingWorktree(true, true, false), false);
	});

	test('keeps a missing worktree known when scope retirement is vetoed', async () => {
		const calls: string[] = [];
		const removed = await paradisDiscardScopeBeforeRemovingKnownWorktree(
			async () => { calls.push('discard'); return false; },
			() => { calls.push('remove'); }
		);

		assert.strictEqual(removed, false);
		assert.deepStrictEqual(calls, ['discard']);
	});

	test('removes a known worktree only after scope retirement succeeds', async () => {
		const calls: string[] = [];
		const removed = await paradisDiscardScopeBeforeRemovingKnownWorktree(
			async () => { calls.push('discard'); return true; },
			() => { calls.push('remove'); }
		);

		assert.strictEqual(removed, true);
		assert.deepStrictEqual(calls, ['discard', 'remove']);
	});
});
