/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { paradisCloseEndedTerminalWhenSafe } from '../../browser/paradisEndedTerminalClose.js';

suite('paradisEndedTerminalClose', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function fakeInstance(processReady: Promise<void>) {
		const disposedWith: (TerminalExitReason | undefined)[] = [];
		return {
			disposedWith,
			instance: {
				processReady,
				get isDisposed() { return disposedWith.length > 0; },
				dispose: (reason?: TerminalExitReason) => { disposedWith.push(reason); },
			},
		};
	}

	function switchState(isSwitching: boolean) {
		const emitter = store.add(new Emitter<string>());
		const state = { isSwitching, onDidSwitchScope: emitter.event };
		return { state, finish: () => { state.isSwitching = false; emitter.fire('worktree:target'); } };
	}

	test('closes once the shell is ready and no switch is running', async () => {
		const fake = fakeInstance(Promise.resolve());
		const closed = await paradisCloseEndedTerminalWhenSafe(fake.instance, switchState(false).state, 1_000);

		assert.deepStrictEqual({ closed, disposedWith: fake.disposedWith }, { closed: true, disposedWith: [TerminalExitReason.User] });
	});

	test('waits for the switch to end, then closes', async () => {
		const fake = fakeInstance(Promise.resolve());
		const running = switchState(true);
		const closing = paradisCloseEndedTerminalWhenSafe(fake.instance, running.state, 1_000);
		await Promise.resolve();
		running.finish();

		assert.deepStrictEqual({ closed: await closing, disposedWith: fake.disposedWith }, { closed: true, disposedWith: [TerminalExitReason.User] });
	});

	test('leaves the tab when the shell is not ready in time', async () => {
		const fake = fakeInstance(new DeferredPromise<void>().p);
		const closed = await paradisCloseEndedTerminalWhenSafe(fake.instance, switchState(false).state, 5);

		assert.deepStrictEqual({ closed, disposedWith: fake.disposedWith }, { closed: false, disposedWith: [] });
	});

	test('leaves the tab when the switch is still running after the wait', async () => {
		const fake = fakeInstance(Promise.resolve());
		const closed = await paradisCloseEndedTerminalWhenSafe(fake.instance, switchState(true).state, 5);

		assert.deepStrictEqual({ closed, disposedWith: fake.disposedWith }, { closed: false, disposedWith: [] });
	});
});
