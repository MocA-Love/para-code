/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_MOBILE_LINK_METRICS_MAX_SERIES,
	ParadisMobileEchoTracker,
	ParadisMobileLinkMetrics,
	paradisEncodeMetricsPing,
	paradisEncodeMetricsPong,
	paradisIsMetricsPingPayload,
	paradisIsMetricsPongPayload,
	paradisLinkMetricsBucketOf,
	paradisLinkMetricsBucketValue,
	paradisParseMetricsPing,
	paradisParseMetricsPong,
} from '../../common/paradisMobileLinkMetrics.js';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
	let value = start;
	return { now: () => value, advance: ms => { value += ms; } };
}

suite('ParadisMobileLinkMetrics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('records nothing while off and starts from a clean slate when turned on', () => {
		const metrics = new ParadisMobileLinkMetrics(() => 1_000, () => 0);
		metrics.observe('pc.rx.openMs', 1);
		metrics.count('pc.rtt.pings');
		const before = metrics.snapshot();
		metrics.setEnabled(true);
		metrics.observe('pc.rx.openMs', 2);
		const after = metrics.snapshot();
		metrics.setEnabled(false);
		metrics.setEnabled(true);

		assert.deepStrictEqual({
			before: { enabled: before.enabled, histograms: before.histograms, counters: before.counters },
			after: { enabled: after.enabled, startedAt: after.startedAt, count: after.histograms['pc.rx.openMs']?.count },
			restarted: metrics.snapshot().histograms,
		}, {
			before: { enabled: false, histograms: {}, counters: {} },
			after: { enabled: true, startedAt: 1_000, count: 1 },
			restarted: {},
		});
	});

	test('summarizes percentiles within the bucket error and keeps exact min, max and mean', () => {
		const metrics = new ParadisMobileLinkMetrics();
		metrics.setEnabled(true);
		for (let value = 1; value <= 100; value++) {
			metrics.observe('app.rtt.ms', value);
		}
		const summary = metrics.snapshot().histograms['app.rtt.ms']!;
		const near = (actual: number, expected: number) => Math.abs(actual - expected) / expected <= 0.1;

		assert.deepStrictEqual({
			count: summary.count, min: summary.min, max: summary.max, mean: summary.mean,
			p50: near(summary.p50, 50), p95: near(summary.p95, 95), p99: near(summary.p99, 99),
		}, { count: 100, min: 1, max: 100, mean: 50.5, p50: true, p95: true, p99: true });
	});

	test('maps values to monotonic buckets whose representative stays inside the bucket', () => {
		const values = [0, -1, Number.NaN, 0.0001, 0.001, 0.5, 1, 1.09, 16_384, 1e15];
		const buckets = values.map(paradisLinkMetricsBucketOf);
		assert.deepStrictEqual({
			buckets,
			oneRoundTrips: paradisLinkMetricsBucketOf(paradisLinkMetricsBucketValue(paradisLinkMetricsBucketOf(1))) === paradisLinkMetricsBucketOf(1),
		}, {
			buckets: [0, 0, 0, 1, 1, 73, 81, 81, 193, 400],
			oneRoundTrips: true,
		});
	});

	test('measures elapsed time with its own monotonic clock and freezes the duration when stopped', () => {
		const time = clock(10);
		const metrics = new ParadisMobileLinkMetrics(() => 5, time.now);
		metrics.setEnabled(true);
		const startedAt = metrics.now();
		time.advance(25);
		metrics.observeSince('pc.authority.waitMs', startedAt);
		metrics.setEnabled(false);
		time.advance(1_000);
		const snapshot = metrics.snapshot();

		assert.deepStrictEqual({ durationMs: snapshot.durationMs, max: snapshot.histograms['pc.authority.waitMs']?.max }, { durationMs: 25, max: 25 });
	});

	test('merges raw values from another process and rejects malformed ones', () => {
		const renderer = new ParadisMobileLinkMetrics();
		renderer.setEnabled(true);
		renderer.observe('renderer.term.echo.ptyMs', 4);
		renderer.observe('renderer.term.echo.ptyMs', 8);
		renderer.count('renderer.term.out.suspended');
		const raw = renderer.raw(true);

		const shared = new ParadisMobileLinkMetrics();
		shared.setEnabled(true);
		shared.observe('renderer.term.echo.ptyMs', 2);
		shared.merge(raw);
		shared.merge({ histograms: { 'renderer.bad': { count: 2, sum: 1, min: 0, max: 1, buckets: { 3: 1 } } }, counters: { 'renderer.neg': -1 } });
		shared.merge({ histograms: { 'Not A Name': { count: 1, sum: 1, min: 1, max: 1, buckets: { 81: 1 } } } });
		shared.merge('garbage');
		const snapshot = shared.snapshot();

		assert.deepStrictEqual({
			drained: renderer.raw(),
			echo: { count: snapshot.histograms['renderer.term.echo.ptyMs']?.count, min: snapshot.histograms['renderer.term.echo.ptyMs']?.min, max: snapshot.histograms['renderer.term.echo.ptyMs']?.max },
			names: Object.keys(snapshot.histograms),
			counters: snapshot.counters,
		}, {
			drained: { histograms: {}, counters: {} },
			echo: { count: 3, min: 2, max: 8 },
			names: ['renderer.term.echo.ptyMs'],
			counters: { 'renderer.term.out.suspended': 1 },
		});
	});

	test('caps the number of series and reports what it dropped', () => {
		const metrics = new ParadisMobileLinkMetrics();
		metrics.setEnabled(true);
		for (let i = 0; i < PARADIS_MOBILE_LINK_METRICS_MAX_SERIES + 3; i++) {
			metrics.observe(`pc.series${i}`, 1);
		}
		const snapshot = metrics.snapshot();
		assert.deepStrictEqual({ series: Object.keys(snapshot.histograms).length, dropped: snapshot.selfCost.droppedSeries, observations: snapshot.selfCost.observations },
			{ series: PARADIS_MOBILE_LINK_METRICS_MAX_SERIES, dropped: 3, observations: PARADIS_MOBILE_LINK_METRICS_MAX_SERIES + 3 });
	});
});

suite('ParadisMobileEchoTracker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('measures from the first input to the next output and forgets stale or evicted marks', () => {
		const tracker = new ParadisMobileEchoTracker(1_000, 2);
		tracker.mark('a', 0);
		tracker.mark('a', 5);
		const first = tracker.take('a', 12);
		const again = tracker.take('a', 13);
		tracker.mark('b', 0);
		const stale = tracker.take('b', 2_000);
		tracker.mark('c', 0);
		tracker.mark('d', 0);
		tracker.mark('e', 0);
		assert.deepStrictEqual({ first, again, stale, evicted: tracker.take('c', 1), kept: tracker.take('e', 1) }, { first: 12, again: undefined, stale: undefined, evicted: undefined, kept: 1 });
	});
});

suite('ParadisMobileMetricsPing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips the ping and pong and rejects foreign or oversized payloads', () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		const ping = paradisEncodeMetricsPing({ id: 7, rttMs: 123.456 });
		const pong = paradisEncodeMetricsPong(7);
		assert.deepStrictEqual({
			ping: paradisParseMetricsPing(ping),
			noRtt: paradisParseMetricsPing(paradisEncodeMetricsPing({ id: 1 })),
			badRtt: paradisParseMetricsPing('{"t":"metrics-ping","id":1,"rttMs":-5}'),
			badId: paradisParseMetricsPing('{"t":"metrics-ping","id":-1}'),
			pong: paradisParseMetricsPong(pong),
			wrongType: paradisParseMetricsPong(ping),
			isPing: [paradisIsMetricsPingPayload(encode(ping)), paradisIsMetricsPingPayload(encode(pong)), paradisIsMetricsPingPayload(encode(`${ping}${' '.repeat(200)}`))],
			isPong: [paradisIsMetricsPongPayload(encode(pong)), paradisIsMetricsPongPayload(encode('{"t":"frame"}'))],
		}, {
			ping: { id: 7, rttMs: 123.5 },
			noRtt: { id: 1 },
			badRtt: { id: 1 },
			badId: undefined,
			pong: 7,
			wrongType: undefined,
			isPing: [true, false, false],
			isPong: [true, false],
		});
	});
});
