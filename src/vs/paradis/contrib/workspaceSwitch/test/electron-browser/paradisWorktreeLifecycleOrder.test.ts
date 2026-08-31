/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCompleteCreatedWorktree } from '../../electron-browser/paradisCompleteCreatedWorktree.js';
import { paradisRemoveWorktreeSequence } from '../../electron-browser/paradisCreateWorktree.contribution.js';

suite('worktree lifecycle order', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('agent launches while setup is still running, auto-run waits for it', async () => {
		const events: string[] = [];
		let finishSetup!: () => void;
		const setupFinished = new Promise<void>(resolve => { finishSetup = resolve; });
		let agentLaunched!: () => void;
		const agentDone = new Promise<void>(resolve => { agentLaunched = resolve; });

		const flow = paradisCompleteCreatedWorktree({
			runSetup: async () => { events.push('setup:start'); await setupFinished; events.push('setup:end'); },
			runAutoRun: async () => { events.push('autoRun'); return true; },
			openDefaultTerminal: async () => { events.push('terminal'); },
			launchAgent: async () => { events.push('agent'); agentLaunched(); }
		});

		// setup を止めたままエージェントが起動しきることが、待ち合わせていない証拠になる
		await agentDone;
		assert.deepStrictEqual(events, ['setup:start', 'agent']);

		finishSetup();
		await flow;
		assert.deepStrictEqual(events, ['setup:start', 'agent', 'setup:end', 'autoRun']);
	});

	test('setup failure still launches the agent but skips auto-run', async () => {
		const events: string[] = [];
		await assert.rejects(paradisCompleteCreatedWorktree({
			runSetup: async () => { events.push('setup'); throw new Error('failed'); },
			runAutoRun: async () => { events.push('autoRun'); return false; },
			openDefaultTerminal: async () => { events.push('terminal'); },
			launchAgent: async () => { events.push('agent'); }
		}), /failed/);
		assert.deepStrictEqual(events, ['setup', 'agent']);
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

	test('teardown failure still removes when the user confirms', async () => {
		const events: string[] = [];
		await paradisRemoveWorktreeSequence({
			runTeardown: async () => { events.push('teardown'); throw new Error('failed'); },
			confirmTeardownFailure: async error => { events.push(`confirm:${(error as Error).message}`); return true; },
			switchToParent: async () => { events.push('switch'); },
			remove: async () => { events.push('remove'); }
		});
		assert.deepStrictEqual(events, ['teardown', 'confirm:failed', 'switch', 'remove']);
	});

	test('teardown failure aborts when the user declines', async () => {
		const events: string[] = [];
		await assert.rejects(paradisRemoveWorktreeSequence({
			runTeardown: async () => { events.push('teardown'); throw new Error('failed'); },
			confirmTeardownFailure: async () => { events.push('confirm'); return false; },
			switchToParent: async () => { events.push('switch'); },
			remove: async () => { events.push('remove'); }
		}), /failed/);
		assert.deepStrictEqual(events, ['teardown', 'confirm']);
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
