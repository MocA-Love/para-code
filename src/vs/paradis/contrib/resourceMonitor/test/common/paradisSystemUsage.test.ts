/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisSystemUsageSample,
	ParadisRingBuffer,
	ParadisSystemUsageHistory,
	paradisDecodeSystemUsageSeries,
	paradisDownsampleSamples,
	paradisEncodeSystemUsageSeries,
	paradisIsSystemUsageUnsupportedError,
	paradisMergeSystemUsageSamples,
	paradisParseSystemUsageRequest,
	paradisSelectSystemUsageSamples,
	paradisSystemUsageRangeSpec,
	paradisSystemUsageWindow,
} from '../../common/paradisSystemUsage.js';

suite('ParadisSystemUsage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ring buffer keeps the newest items in order', () => {
		const ring = new ParadisRingBuffer<number>(3);
		const snapshots: number[][] = [];
		for (const value of [1, 2, 3, 4, 5]) {
			ring.push(value);
			snapshots.push(ring.toArray());
		}
		assert.deepStrictEqual({ snapshots, last: ring.last(), size: ring.size }, {
			snapshots: [[1], [1, 2], [1, 2, 3], [2, 3, 4], [3, 4, 5]],
			last: 5,
			size: 3,
		});
	});

	test('history rolls finished minutes into the coarse tier and ignores a clock going backwards', () => {
		const history = new ParadisSystemUsageHistory();
		// 0:00:50, 0:00:55 は 0 分目、1:00, 1:05 は 1 分目、2:00 で 1 分目が確定する
		for (const [t, cpu] of [[50_000, 10], [55_000, 30], [54_000, 99], [60_000, 50], [65_000, 70], [120_000, 0]] as const) {
			history.push({ t, cpu, netRx: cpu * 100 });
		}
		assert.deepStrictEqual({
			fine: history.samples('fine').map(sample => sample.t),
			coarse: history.samples('coarse'),
			latest: history.latest()?.t,
		}, {
			fine: [50_000, 55_000, 60_000, 65_000, 120_000],
			coarse: [
				{ t: 0, cpu: 20, netRx: 2000 },
				{ t: 60_000, cpu: 60, netRx: 6000 },
			],
			latest: 120_000,
		});
	});

	test('downsampling averages equal groups from the newest end, stamped with each group\'s last point', () => {
		const samples: IParadisSystemUsageSample[] = [1, 2, 3, 4, 5, 6, 7].map(i => ({ t: i * 1000, cpu: i * 10, diskRead: i }));
		assert.deepStrictEqual({
			two: paradisDownsampleSamples(samples, 3),
			untouched: paradisDownsampleSamples(samples, 10).length,
			missing: paradisDownsampleSamples([{ t: 1 }, { t: 2, mem: 40 }, { t: 3 }, { t: 4 }], 2),
		}, {
			// 3 点ずつの組を右から作る: [1] [2,3,4] [5,6,7]。時刻は組の末尾（最後の組は実際の最新の点）
			two: [
				{ t: 1000, cpu: 10, diskRead: 1 },
				{ t: 4000, cpu: 30, diskRead: 3 },
				{ t: 7000, cpu: 60, diskRead: 6 },
			],
			untouched: 7,
			// 値の無い点は平均に数えない
			missing: [{ t: 2, mem: 40 }, { t: 4 }],
		});
	});

	test('columnar series round-trip and reject malformed values', () => {
		const samples: IParadisSystemUsageSample[] = [{ t: 1, cpu: 12.5, swapUsed: 1024 }, { t: 2, mem: 40 }];
		const encoded = paradisEncodeSystemUsageSeries(samples);
		assert.deepStrictEqual({
			encoded,
			decoded: paradisDecodeSystemUsageSeries(JSON.parse(JSON.stringify(encoded))),
			hostile: paradisDecodeSystemUsageSeries({ t: [1, 'x', 3], cpu: ['50', 10, null], mem: 'no' }),
			notObject: paradisDecodeSystemUsageSeries(undefined),
		}, {
			encoded: {
				t: [1, 2],
				cpu: [12.5, null],
				mem: [null, 40],
				disk: [null, null],
				diskRead: [null, null],
				diskWrite: [null, null],
				netRx: [null, null],
				netTx: [null, null],
				swapUsed: [1024, null],
			},
			decoded: samples,
			hostile: [{ t: 1 }, { t: 3 }],
			notObject: [],
		});
	});

	test('merging appends only newer points, resets on demand and trims to capacity', () => {
		const existing: IParadisSystemUsageSample[] = [{ t: 1, cpu: 1 }, { t: 2, cpu: 2 }];
		assert.deepStrictEqual({
			append: paradisMergeSystemUsageSamples(existing, [{ t: 2, cpu: 99 }, { t: 3, cpu: 3 }], false, 10).map(sample => sample.cpu),
			reset: paradisMergeSystemUsageSamples(existing, [{ t: 5, cpu: 5 }], true, 10).map(sample => sample.cpu),
			trim: paradisMergeSystemUsageSamples(existing, [{ t: 3, cpu: 3 }, { t: 4, cpu: 4 }], false, 3).map(sample => sample.cpu),
		}, {
			append: [1, 2, 3],
			reset: [5],
			trim: [2, 3, 4],
		});
	});

	test('selecting points honours since only for the same measuring instance', () => {
		const all: IParadisSystemUsageSample[] = [{ t: 1 }, { t: 2 }, { t: 3 }];
		const pick = (request: Parameters<typeof paradisSelectSystemUsageSamples>[1]) => {
			const { samples, reset } = paradisSelectSystemUsageSamples(all, request, 'instance-a');
			return { t: samples.map(sample => sample.t), reset };
		};
		assert.deepStrictEqual([
			pick({ tier: 'fine' }),
			pick({ tier: 'fine', since: 2, instanceId: 'instance-a' }),
			pick({ tier: 'fine', since: 2, instanceId: 'instance-b' }),
			pick({ tier: 'fine', since: 3, instanceId: 'instance-a' }),
			pick({ tier: 'fine', maxPoints: 2 }),
		], [
			{ t: [1, 2, 3], reset: true },
			{ t: [3], reset: false },
			{ t: [1, 2, 3], reset: true },
			{ t: [], reset: false },
			{ t: [1, 3], reset: true },
		]);
	});

	test('the since right after a downsampled answer neither repeats nor skips points', () => {
		const all: IParadisSystemUsageSample[] = [1, 2, 3, 4, 5, 6].map(t => ({ t, cpu: t }));
		const first = paradisSelectSystemUsageSamples(all, { tier: 'coarse', maxPoints: 2 }, 'instance-a').samples;
		const since = first[first.length - 1].t;
		const grown = [...all, { t: 7, cpu: 7 }];
		assert.deepStrictEqual({
			first: first.map(sample => sample.t),
			next: paradisSelectSystemUsageSamples(grown, { tier: 'coarse', since, instanceId: 'instance-a' }, 'instance-a').samples.map(sample => sample.t),
		}, { first: [3, 6], next: [7] });
	});

	test('requests from the wire are clamped to safe values', () => {
		assert.deepStrictEqual([
			paradisParseSystemUsageRequest(undefined),
			paradisParseSystemUsageRequest({ tier: 'coarse', since: 10, instanceId: 'abc', maxPoints: 99_999 }),
			paradisParseSystemUsageRequest({ tier: 'weird', since: 'x', instanceId: 'x'.repeat(100), maxPoints: 0 }),
		], [
			{ tier: 'fine' },
			{ tier: 'coarse', since: 10, instanceId: 'abc', maxPoints: 1440 },
			{ tier: 'fine' },
		]);
	});

	test('ranges map to tiers and windows end at the newest point', () => {
		const samples: IParadisSystemUsageSample[] = [0, 100_000, 200_000, 300_000, 400_000].map(t => ({ t }));
		const window = paradisSystemUsageWindow(samples, paradisSystemUsageRangeSpec('5m').windowMs);
		assert.deepStrictEqual({
			specs: (['5m', '1h', '24h'] as const).map(range => paradisSystemUsageRangeSpec(range)),
			window: { t: window.samples.map(sample => sample.t), start: window.start, end: window.end },
			empty: paradisSystemUsageWindow([], 1000),
		}, {
			specs: [
				{ tier: 'fine', windowMs: 300_000, stepMs: 5_000 },
				{ tier: 'fine', windowMs: 3_600_000, stepMs: 5_000 },
				{ tier: 'coarse', windowMs: 86_400_000, stepMs: 60_000 },
			],
			window: { t: [100_000, 200_000, 300_000, 400_000], start: 100_000, end: 400_000 },
			empty: { samples: [], start: 0, end: 0 },
		});
	});

	test('recognises an old remote server that does not know the history command', () => {
		assert.deepStrictEqual([
			paradisIsSystemUsageUnsupportedError(new Error('Method not found: getSystemUsage')),
			paradisIsSystemUsageUnsupportedError({ message: 'Method not found: getSystemUsage' }),
			paradisIsSystemUsageUnsupportedError(new Error('Connection closed')),
		], [true, true, false]);
	});
});
