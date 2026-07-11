/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCompleteCreatedWorktree } from '../../electron-browser/paradisCreateWorktreeDialog.js';
import { paradisRemoveWorktreeSequence } from '../../electron-browser/paradisCreateWorktree.contribution.js';

suite('worktree lifecycle order', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('setup runs before auto-run and agent launch', async () => {
		const events: string[] = [];
		await paradisCompleteCreatedWorktree({
			runSetup: async () => { events.push('setup'); },
			runAutoRun: async () => { events.push('autoRun'); return true; },
			openDefaultTerminal: async () => { events.push('terminal'); },
			launchAgent: async () => { events.push('agent'); }
		});
		assert.deepStrictEqual(events, ['setup', 'autoRun', 'agent']);
	});

	test('setup failure skips all later creation actions', async () => {
		const events: string[] = [];
		await assert.rejects(paradisCompleteCreatedWorktree({
			runSetup: async () => { events.push('setup'); throw new Error('failed'); },
			runAutoRun: async () => { events.push('autoRun'); return false; },
			openDefaultTerminal: async () => { events.push('terminal'); },
			launchAgent: async () => { events.push('agent'); }
		}), /failed/);
		assert.deepStrictEqual(events, ['setup']);
	});

	test('teardown failure prevents switch and removal', async () => {
		const events: string[] = [];
		await assert.rejects(paradisRemoveWorktreeSequence({
			runTeardown: async () => { events.push('teardown'); throw new Error('failed'); },
			switchToParent: async () => { events.push('switch'); },
			remove: async () => { events.push('remove'); }
		}), /failed/);
		assert.deepStrictEqual(events, ['teardown']);
	});

	test('switch-to-parent failure prevents removal', async () => {
		const events: string[] = [];
		await assert.rejects(paradisRemoveWorktreeSequence({
			runTeardown: async () => { events.push('teardown'); },
			switchToParent: async () => { events.push('switch'); throw new Error('switch failed'); },
			remove: async () => { events.push('remove'); }
		}), /switch failed/);
		assert.deepStrictEqual(events, ['teardown', 'switch']);
	});
});
