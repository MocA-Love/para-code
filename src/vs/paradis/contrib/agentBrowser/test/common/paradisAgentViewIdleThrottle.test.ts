/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisExactBrowserViewDescriptor } from '../../common/paradisAgentBrowser.js';
import { IParadisAgentViewIdleTimer, ParadisAgentViewIdleThrottle } from '../../common/paradisAgentViewIdleThrottle.js';

class FakeTimer implements IParadisAgentViewIdleTimer {
	private next = 1;
	readonly pending = new Map<number, () => void>();
	set(callback: () => void): unknown {
		const handle = this.next++;
		this.pending.set(handle, callback);
		return handle;
	}
	clear(handle: unknown): void {
		this.pending.delete(handle as number);
	}
	fireAll(): void {
		const callbacks = [...this.pending.values()];
		this.pending.clear();
		callbacks.forEach(callback => callback());
	}
}

function descriptor(viewId: string): IParadisExactBrowserViewDescriptor {
	return { windowId: 1, viewId, targetId: `target-${viewId}`, viewLease: `lease-${viewId}` };
}

suite('ParadisAgentViewIdleThrottle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function create() {
		const calls: string[] = [];
		const timer = new FakeTimer();
		const throttle = new ParadisAgentViewIdleThrottle({
			wake: d => calls.push(`wake ${d.viewId}`),
			sleep: d => calls.push(`sleep ${d.viewId}`),
		}, 60_000, timer);
		return { calls, timer, throttle };
	}

	test('restores throttling after the idle time, and lifts it again on the next use', () => {
		const { calls, timer, throttle } = create();
		const a = descriptor('a');
		throttle.hold(a);
		assert.strictEqual(throttle.isAwake(a), true);
		timer.fireAll();
		assert.strictEqual(throttle.isAwake(a), false);
		assert.strictEqual(throttle.noteActivity(a), true);
		assert.strictEqual(throttle.noteActivity(a), true);
		timer.fireAll();
		assert.deepStrictEqual(calls, ['sleep a', 'wake a', 'sleep a']);
		throttle.dispose();
	});

	test('use before the idle time only postpones it', () => {
		const { calls, timer, throttle } = create();
		const a = descriptor('a');
		throttle.hold(a);
		throttle.noteActivity(a);
		assert.strictEqual(timer.pending.size, 1);
		throttle.dispose();
		assert.deepStrictEqual({ calls, pending: timer.pending.size }, { calls: [], pending: 0 });
	});

	test('a released or unknown view is left alone', () => {
		const { calls, timer, throttle } = create();
		const a = descriptor('a');
		throttle.hold(a);
		throttle.release(a);
		timer.fireAll();
		assert.deepStrictEqual({ calls, activity: throttle.noteActivity(a), unknown: throttle.noteActivity(descriptor('b')), size: throttle.size }, { calls: [], activity: false, unknown: false, size: 0 });
	});
});
