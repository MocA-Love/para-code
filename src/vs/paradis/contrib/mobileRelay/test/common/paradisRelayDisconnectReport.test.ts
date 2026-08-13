/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisRelayDisconnectReport,
	IParadisRelayDisconnectReportClock,
	ParadisRelayDisconnectReporter,
} from '../../common/paradisRelayDisconnectReport.js';

const REPORT_DELAY_MS = 60_000;
const REPORT_AFTER_ATTEMPTS = 5;

class FakeClock implements IParadisRelayDisconnectReportClock {
	private currentTime = 1_000;
	private nextTimerId = 0;
	private readonly timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

	now = (): number => this.currentTime;

	setTimeout = (callback: () => void, delay: number): IDisposable => {
		const id = this.nextTimerId++;
		this.timers.set(id, { at: this.currentTime + delay, callback });
		return toDisposable(() => this.timers.delete(id));
	};

	advance(milliseconds: number): void {
		const targetTime = this.currentTime + milliseconds;
		while (true) {
			const next = [...this.timers]
				.filter(([, timer]) => timer.at <= targetTime)
				.sort((left, right) => left[1].at - right[1].at)[0];
			if (next === undefined) {
				break;
			}
			const [id, timer] = next;
			this.timers.delete(id);
			this.currentTime = timer.at;
			timer.callback();
		}
		this.currentTime = targetTime;
	}

	get timerCount(): number {
		return this.timers.size;
	}
}

function createHarness(): {
	readonly reporter: ParadisRelayDisconnectReporter;
	readonly clock: FakeClock;
	readonly reconnectAttempt: { value: number };
	readonly reports: IParadisRelayDisconnectReport[];
} {
	const clock = new FakeClock();
	const reconnectAttempt = { value: 2 };
	const reports: IParadisRelayDisconnectReport[] = [];
	const reporter = new ParadisRelayDisconnectReporter({
		reportDelayMs: REPORT_DELAY_MS,
		reportAfterAttempts: REPORT_AFTER_ATTEMPTS,
		getReconnectAttempt: () => reconnectAttempt.value,
		report: report => reports.push(report),
		clock,
	});
	return { reporter, clock, reconnectAttempt, reports };
}

suite('ParadisRelayDisconnectReporter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps waiting while fewer than five reconnect attempts have failed', () => {
		const { reporter, clock, reconnectAttempt, reports } = createHarness();
		try {
			reporter.arm('unexpected-close-1006', 'first failure', { close_code: 1006 });
			reconnectAttempt.value = 6;

			clock.advance(REPORT_DELAY_MS);

			assert.deepStrictEqual({ reports, timerCount: clock.timerCount }, { reports: [], timerCount: 1 });
		} finally {
			reporter.dispose();
		}
	});

	test('carries the first failure into the next grace period and reports when the fifth attempt arrives', () => {
		const { reporter, clock, reconnectAttempt, reports } = createHarness();
		try {
			reporter.arm('unexpected-close-1006', 'first failure', { close_code: 1006 });
			reporter.arm('connect-timeout', 'later failure', { close_code: 4002 });
			reconnectAttempt.value = 6;
			clock.advance(REPORT_DELAY_MS);

			reconnectAttempt.value = 7;
			clock.advance(REPORT_DELAY_MS);

			assert.deepStrictEqual(reports, [{
				operation: 'unexpected-close-1006',
				message: 'first failure',
				extras: {
					close_code: 1006,
					duration_ms: REPORT_DELAY_MS * 2,
					reconnect_count: 7,
					attempt: 5,
				},
			}]);
		} finally {
			reporter.dispose();
		}
	});

	test('reports the first failure once with attempts measured from when it was armed', () => {
		const { reporter, clock, reconnectAttempt, reports } = createHarness();
		try {
			reporter.arm('unexpected-close-1006', 'first failure', { close_code: 1006, safe_close_reason: '' });
			reporter.arm('connect-timeout', 'later failure', { close_code: 4002, safe_close_reason: 'connect timeout' });
			reconnectAttempt.value = 7;

			clock.advance(REPORT_DELAY_MS - 1);
			assert.deepStrictEqual(reports, []);
			clock.advance(1);
			clock.advance(REPORT_DELAY_MS * 2);

			assert.deepStrictEqual(reports, [{
				operation: 'unexpected-close-1006',
				message: 'first failure',
				extras: {
					close_code: 1006,
					safe_close_reason: '',
					duration_ms: REPORT_DELAY_MS,
					reconnect_count: 7,
					attempt: 5,
				},
			}]);
		} finally {
			reporter.dispose();
		}
	});

	test('recovery cancels a pending report', () => {
		const { reporter, clock, reconnectAttempt, reports } = createHarness();
		try {
			reporter.arm('unexpected-close-1006', 'failure', { close_code: 1006 });
			reconnectAttempt.value = 7;

			reporter.recovered();
			clock.advance(REPORT_DELAY_MS);

			assert.deepStrictEqual({ reports, timerCount: clock.timerCount }, { reports: [], timerCount: 0 });
		} finally {
			reporter.dispose();
		}
	});

	test('setting the service lifecycle to disabled cancels a pending report', () => {
		const { reporter, clock, reconnectAttempt, reports } = createHarness();
		try {
			reporter.arm('unexpected-close-1006', 'failure', { close_code: 1006 });
			reconnectAttempt.value = 7;

			reporter.setEnabled(false);
			clock.advance(REPORT_DELAY_MS);

			assert.deepStrictEqual({ reports, timerCount: clock.timerCount }, { reports: [], timerCount: 0 });
		} finally {
			reporter.dispose();
		}
	});

	test('dispose cancels a pending report and prevents another arm', () => {
		const { reporter, clock, reconnectAttempt, reports } = createHarness();
		reporter.arm('unexpected-close-1006', 'failure', { close_code: 1006 });
		reconnectAttempt.value = 7;

		reporter.dispose();
		reporter.arm('connect-timeout', 'after dispose', { close_code: 4002 });
		clock.advance(REPORT_DELAY_MS);

		assert.deepStrictEqual({ reports, timerCount: clock.timerCount }, { reports: [], timerCount: 0 });
	});

	test('allows a new incident after recovery', () => {
		const { reporter, clock, reconnectAttempt, reports } = createHarness();
		try {
			reporter.arm('unexpected-close-1006', 'recovered failure', { close_code: 1006 });
			reporter.recovered();
			reconnectAttempt.value = 10;

			reporter.arm('connect-timeout', 'new failure', { close_code: 4002 });
			reconnectAttempt.value = 15;
			clock.advance(REPORT_DELAY_MS);

			assert.deepStrictEqual(reports.map(report => report.operation), ['connect-timeout']);
		} finally {
			reporter.dispose();
		}
	});

	test('allows a new incident after the previous incident was reported', () => {
		const { reporter, clock, reconnectAttempt, reports } = createHarness();
		try {
			reporter.arm('unexpected-close-1006', 'first failure', { close_code: 1006 });
			reconnectAttempt.value = 7;
			clock.advance(REPORT_DELAY_MS);

			reporter.arm('connect-timeout', 'second failure', { close_code: 4002 });
			reconnectAttempt.value = 12;
			clock.advance(REPORT_DELAY_MS);

			assert.deepStrictEqual(reports.map(report => report.operation), ['unexpected-close-1006', 'connect-timeout']);
		} finally {
			reporter.dispose();
		}
	});
});
