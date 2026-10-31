/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import 'mocha';
import { IParadisTsServerIdleStopHost, ParadisTsServerIdleStop, paradisIdleStopDelay } from '../../paradis/paradisTsServerIdleStop';

class FakeHost implements IParadisTsServerIdleStopHost {
	public documents = 0;
	public started = true;
	public running = true;
	public minutes: number | undefined = 5;
	public stops = 0;
	public readonly timers: { callback: () => void; milliseconds: number; cancelled: boolean }[] = [];

	countDocuments() { return this.documents; }
	isStarted() { return this.started; }
	getIdleStopMinutes() { return this.minutes; }
	stop() {
		const wasRunning = this.running;
		this.running = false;
		this.stops++;
		return wasRunning;
	}
	setTimeout(callback: () => void, milliseconds: number) {
		const timer = { callback, milliseconds, cancelled: false };
		this.timers.push(timer);
		return { cancel: () => { timer.cancelled = true; } };
	}

	/** Runs every timer that is still pending. */
	elapse() {
		for (const timer of this.timers.splice(0)) {
			if (!timer.cancelled) {
				timer.callback();
			}
		}
	}

	pending() {
		return this.timers.filter(timer => !timer.cancelled).map(timer => timer.milliseconds);
	}
}

suite('Para Code: TS Server idle stop', () => {

	test('setting: 0, negative and non-numbers turn it off; large values are capped at one day', () => {
		assert.deepStrictEqual(
			[5, 0, -1, undefined, Number.NaN, 0.5, 100000].map(paradisIdleStopDelay),
			[300000, undefined, undefined, undefined, undefined, 30000, 86400000]);
	});

	test('stops after the idle time when no JS/TS document is open', () => {
		const host = new FakeHost();
		const idleStop = new ParadisTsServerIdleStop(host);
		idleStop.update();
		assert.deepStrictEqual(host.pending(), [300000]);
		host.elapse();
		assert.deepStrictEqual({ stops: host.stops, running: host.running }, { stops: 1, running: false });
	});

	test('does nothing while a document is open, and starts counting again once it closes', () => {
		const host = new FakeHost();
		const idleStop = new ParadisTsServerIdleStop(host);
		host.documents = 1;
		idleStop.update();
		assert.deepStrictEqual(host.pending(), []);

		host.documents = 0;
		idleStop.update();
		host.documents = 1; // reopened before the timer fired, without an update
		host.elapse();
		assert.strictEqual(host.stops, 0);
	});

	test('opening a document cancels the pending stop', () => {
		const host = new FakeHost();
		const idleStop = new ParadisTsServerIdleStop(host);
		idleStop.update();
		host.documents = 1;
		idleStop.update();
		assert.deepStrictEqual(host.pending(), []);
	});

	test('never touches a window where TS Server was never started', () => {
		const host = new FakeHost();
		host.started = false;
		const idleStop = new ParadisTsServerIdleStop(host);
		idleStop.update();
		host.elapse();
		assert.deepStrictEqual({ pending: host.pending(), stops: host.stops }, { pending: [], stops: 0 });
	});

	test('0 minutes disables it, also when changed while a stop is pending', () => {
		const host = new FakeHost();
		host.minutes = 0;
		const idleStop = new ParadisTsServerIdleStop(host);
		idleStop.update();
		assert.deepStrictEqual(host.pending(), []);

		host.minutes = 5;
		idleStop.update();
		host.minutes = 0;
		idleStop.update();
		host.elapse();
		assert.strictEqual(host.stops, 0);
	});

	test('stops again after the server was started once more', () => {
		const host = new FakeHost();
		const idleStop = new ParadisTsServerIdleStop(host);
		idleStop.update();
		host.elapse();

		host.running = true; // started again by a request (opening a file, a rename, ...)
		idleStop.update();
		host.elapse();
		assert.deepStrictEqual({ stops: host.stops, running: host.running }, { stops: 2, running: false });
	});

	test('dispose cancels the pending stop', () => {
		const host = new FakeHost();
		const idleStop = new ParadisTsServerIdleStop(host);
		idleStop.update();
		idleStop.dispose();
		host.elapse();
		assert.strictEqual(host.stops, 0);
	});
});
