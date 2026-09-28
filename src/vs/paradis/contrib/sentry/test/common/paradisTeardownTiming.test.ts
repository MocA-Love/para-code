/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisTeardownStepRecord,
	paradisDescribeTeardownStep,
	paradisIsSlowTeardownStep,
	paradisTimeBoundedTeardownStep,
	paradisTimeTeardownStep,
	PARADIS_TEARDOWN_SLOW_MS,
} from '../../common/paradisTeardownTiming.js';

function recorder() {
	const lines: string[] = [];
	const reports: IParadisTeardownStepRecord[] = [];
	let clock = 0;
	return {
		lines,
		reports,
		advance: (ms: number) => { clock += ms; },
		options: (waitsForUser?: boolean) => ({
			log: { trace: (message: string) => lines.push(`trace ${message}`), warn: (message: string) => lines.push(`warn ${message}`) },
			report: (record: IParadisTeardownStepRecord) => reports.push(record),
			now: () => clock,
			waitsForUser,
		}),
	};
}

suite('paradisTeardownTiming', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a fast step is traced and not reported; a slow one is warned and reported with its name', async () => {
		const r = recorder();
		await paradisTimeTeardownStep('fast.step', Promise.resolve(1), r.options());
		const slow = new DeferredPromise<number>();
		const pending = paradisTimeTeardownStep('slow.step', slow.p, r.options());
		r.advance(PARADIS_TEARDOWN_SLOW_MS + 500);
		slow.complete(2);
		assert.deepStrictEqual({ value: await pending, lines: r.lines, reports: r.reports }, {
			value: 2,
			lines: [
				'trace [paradisTeardown] fast.step: settled after 0ms',
				'warn [paradisTeardown] slow.step: settled after 1500ms',
			],
			reports: [{ step: 'slow.step', durationMs: 1500, outcome: 'settled', waitsForUser: undefined }],
		});
	});

	test('a failure is recorded as failed and rethrown unchanged', async () => {
		const r = recorder();
		const error = new Error('boom');
		await assert.rejects(paradisTimeTeardownStep('failing.step', Promise.reject(error), r.options()), candidate => candidate === error);
		assert.deepStrictEqual(r.reports.map(report => report.outcome), ['failed']);
	});

	test('waiting for the user is logged but never reported', async () => {
		const r = recorder();
		const answer = new DeferredPromise<boolean>();
		const pending = paradisTimeTeardownStep('ask.user', answer.p, r.options(true));
		r.advance(20_000);
		answer.complete(true);
		await pending;
		assert.deepStrictEqual({ lines: r.lines, reports: r.reports }, {
			lines: ['warn [paradisTeardown] ask.user: settled after 20000ms (waited for the user)'],
			reports: [],
		});
	});

	test('a bounded step that hits its existing bound is recorded as timed-out and calls onTimeout', async () => {
		const r = recorder();
		let timedOut = 0;
		const never = new DeferredPromise<void>();
		const result = await paradisTimeBoundedTeardownStep('bounded.step', never.p, 5, { ...r.options(), onTimeout: () => timedOut++ });
		never.complete();
		assert.deepStrictEqual({ result, timedOut, reports: r.reports.map(report => ({ outcome: report.outcome, boundMs: report.boundMs })) }, {
			result: undefined,
			timedOut: 1,
			reports: [{ outcome: 'timed-out', boundMs: 5 }],
		});
	});

	test('slowness and the log line', () => {
		assert.deepStrictEqual([
			paradisIsSlowTeardownStep({ step: 'a', durationMs: 10, outcome: 'settled' }),
			paradisIsSlowTeardownStep({ step: 'a', durationMs: 10, outcome: 'timed-out' }),
			paradisIsSlowTeardownStep({ step: 'a', durationMs: PARADIS_TEARDOWN_SLOW_MS, outcome: 'settled' }),
			paradisDescribeTeardownStep({ step: 'a.b', durationMs: 2000, outcome: 'timed-out', boundMs: 2000 }),
		], [false, true, true, '[paradisTeardown] a.b: timed-out after 2000ms (bound 2000ms)']);
	});
});
