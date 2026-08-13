/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import type { ParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { paradisWatchWebviewServiceWorkers } from '../../electron-main/paradisWebviewServiceWorkerWatch.js';

interface WatchDependencies {
	readonly eventSource: Electron.ServiceWorkers;
	readonly reporter: ParadisDiagnosticReporter;
	readonly clock: FakeClock;
}

type Watch = (targetSession: Electron.Session, logService: NullLogService, dependencies: WatchDependencies) => IDisposable;

interface Report {
	readonly operation: string;
	readonly safeExtra: Record<string, unknown> | undefined;
}

class FakeClock {
	private readonly callbacks = new Set<() => void>();
	private readonly delays: number[] = [];
	private currentTime = 0;

	now = (): number => this.currentTime;

	setInterval = (callback: () => void, _delay: number): IDisposable => {
		this.callbacks.add(callback);
		this.delays.push(_delay);
		return toDisposable(() => this.callbacks.delete(callback));
	};

	advance(milliseconds: number): void {
		this.currentTime += milliseconds;
		for (const callback of [...this.callbacks]) {
			callback();
		}
	}

	get timerCount(): number {
		return this.callbacks.size;
	}

	get timerDelays(): readonly number[] {
		return this.delays;
	}
}

class FakeServiceWorkers {
	private readonly listeners = new Map<string, Set<(...args: object[]) => void>>();
	private readonly scopes = new Map<number, string>();

	on(event: string, listener: (...args: object[]) => void): this {
		let eventListeners = this.listeners.get(event);
		if (eventListeners === undefined) {
			eventListeners = new Set();
			this.listeners.set(event, eventListeners);
		}
		eventListeners.add(listener);
		return this;
	}

	off(event: string, listener: (...args: object[]) => void): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}

	setScope(versionId: number, scope: string): void {
		this.scopes.set(versionId, scope);
	}

	removeRegistration(versionId: number): void {
		this.scopes.delete(versionId);
	}

	emitRunningStatus(versionId: number, runningStatus: 'starting' | 'running' | 'stopping' | 'stopped'): void {
		this.emit('running-status-changed', { versionId, runningStatus });
	}

	emitConsoleMessage(versionId: number): void {
		this.emit('console-message', {}, { message: 'worker failed', versionId, source: 'worker', level: 3 });
	}

	getWorkerFromVersionID(versionId: number): { scope: string } | undefined {
		const scope = this.scopes.get(versionId);
		return scope === undefined ? undefined : { scope };
	}

	private emit(event: string, ...args: object[]): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) {
			listener(...args);
		}
	}
}

function createHarness(): { watcher: IDisposable; workers: FakeServiceWorkers; clock: FakeClock; reports: Report[] } {
	const workers = new FakeServiceWorkers();
	const clock = new FakeClock();
	const reports: Report[] = [];
	const reporter: ParadisDiagnosticReporter = (_scope, _feature, operation, _error, safeExtra) => {
		reports.push({ operation, safeExtra });
	};
	const session = { serviceWorkers: workers } as unknown as Electron.Session;
	const watch = paradisWatchWebviewServiceWorkers as unknown as Watch;
	const watcher = watch(session, new NullLogService(), {
		eventSource: workers as unknown as Electron.ServiceWorkers,
		reporter,
		clock,
	});
	return { watcher, workers, clock, reports };
}

suite('ParadisWebviewServiceWorkerWatch', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports a webview worker once only when starting reaches the 20-second grace period', () => {
		const { watcher, workers, clock, reports } = createHarness();
		try {
			workers.setScope(1, 'vscode-webview://watch-test');
			workers.emitRunningStatus(1, 'starting');

			assert.strictEqual(clock.timerCount, 1);
			assert.deepStrictEqual(clock.timerDelays, [5_000]);
			clock.advance(19_999);
			assert.strictEqual(reports.length, 0);

			clock.advance(1);
			assert.strictEqual(reports.length, 1);
			assert.strictEqual(reports[0]?.operation, 'sw-startup-stuck');

			clock.advance(5_000);
			assert.strictEqual(reports.length, 1);
			assert.strictEqual(reports[0]?.operation, 'sw-startup-stuck');
		} finally {
			watcher.dispose();
		}
	});

	test('stops the timer after a starting worker becomes running', () => {
		const { watcher, workers, clock } = createHarness();
		try {
			workers.setScope(1, 'vscode-webview://watch-test');
			workers.emitRunningStatus(1, 'starting');
			assert.strictEqual(clock.timerCount, 1);

			workers.emitRunningStatus(1, 'running');
			assert.strictEqual(clock.timerCount, 0);
		} finally {
			watcher.dispose();
		}
	});

	test('stops the timer when a tracked registration is deleted', () => {
		const { watcher, workers, clock } = createHarness();
		try {
			workers.setScope(1, 'vscode-webview://watch-test');
			workers.emitRunningStatus(1, 'starting');
			assert.strictEqual(clock.timerCount, 1);

			workers.removeRegistration(1);
			clock.advance(5_000);
			assert.strictEqual(clock.timerCount, 0);
		} finally {
			watcher.dispose();
		}
	});

	test('does not retain a timer for a worker from an unrelated source', () => {
		const { watcher, workers, clock } = createHarness();
		try {
			workers.setScope(1, 'https://example.test');
			workers.emitRunningStatus(1, 'starting');

			assert.strictEqual(clock.timerCount, 0);
		} finally {
			watcher.dispose();
		}
	});

	test('keeps no more than 20 workers under observation', () => {
		const { watcher, workers, clock, reports } = createHarness();
		try {
			for (let versionId = 1; versionId <= 21; versionId++) {
				workers.setScope(versionId, `vscode-webview://watch-test-${versionId}`);
				workers.emitRunningStatus(versionId, 'starting');
			}
			assert.strictEqual(clock.timerCount, 1);

			clock.advance(20_000);
			assert.strictEqual(reports.length, 20);
			assert.deepStrictEqual(reports.map(report => report.safeExtra?.safe_starting_workers), Array(20).fill(20));
			assert.strictEqual(clock.timerCount, 0);

			for (let versionId = 1; versionId <= 20; versionId++) {
				workers.emitRunningStatus(versionId, 'running');
			}
			workers.setScope(21, 'vscode-webview://watch-test-21');
			workers.emitRunningStatus(21, 'starting');
			assert.strictEqual(clock.timerCount, 0);

			clock.advance(20_000);
			assert.strictEqual(reports.length, 20);
		} finally {
			watcher.dispose();
		}
	});

	test('does not retain a timer or listeners after disposal', () => {
		const { watcher, workers, clock, reports } = createHarness();
		workers.setScope(1, 'vscode-webview://watch-test');
		workers.emitRunningStatus(1, 'starting');
		assert.strictEqual(clock.timerCount, 1);

		watcher.dispose();
		assert.strictEqual(clock.timerCount, 0);

		workers.emitRunningStatus(2, 'starting');
		workers.emitConsoleMessage(2);
		clock.advance(20_000);
		assert.deepStrictEqual(reports, []);
	});
});
