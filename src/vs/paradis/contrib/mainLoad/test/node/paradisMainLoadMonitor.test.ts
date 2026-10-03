/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { tmpdir } from 'os';
import { EventLoopUtilization } from 'perf_hooks';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMainLoopPeriodSummary, paradisIsMainLoopCongested, paradisSplitStatRoundTrip, paradisSummarizeMainLoop } from '../../common/paradisMainLoad.js';
import { IParadisMainLoadDependencies, PARADIS_MAIN_LOAD_DEFAULTS, ParadisMainLoadMonitor, paradisCreateMainLoadChannel } from '../../node/paradisMainLoadMonitor.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';

interface IFakeHistogram {
	resolution: number;
	enabled: boolean;
	resets: number;
	p50: number;
	p99: number;
	max: number;
}

function createFakes() {
	const histograms: IFakeHistogram[] = [];
	const congested: string[] = [];
	let now = 1_000;
	let intervalMs: number | undefined;
	let cleared = false;
	let utilization = 0.25;
	const deps: Partial<IParadisMainLoadDependencies> = {
		createHistogram: resolution => {
			const state: IFakeHistogram = { resolution, enabled: false, resets: 0, p50: 2e6, p99: 30e6, max: 40e6 };
			histograms.push(state);
			return {
				get max() { return state.max; },
				percentile: (percentile: number) => percentile === 50 ? state.p50 : state.p99,
				enable: () => { state.enabled = true; },
				disable: () => { state.enabled = false; },
				reset: () => { state.resets++; },
			};
		},
		eventLoopUtilization: () => ({ idle: 0, active: 0, utilization } as EventLoopUtilization),
		now: () => now,
		setInterval: (_handler, ms) => { intervalMs = ms; return 1; },
		clearInterval: () => { cleared = true; },
	};
	const logService = new class extends NullLogService {
		override warn(message: string): void {
			congested.push(message);
		}
	};
	return {
		deps,
		logService,
		histograms,
		congested,
		advance: (ms: number) => { now += ms; },
		setUtilization: (value: number) => { utilization = value; },
		get intervalMs() { return intervalMs; },
		get cleared() { return cleared; },
	};
}

suite('ParadisMainLoad', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('summarizes nanosecond histograms into milliseconds and judges congestion', () => {
		const calm = paradisSummarizeMainLoop({ max: 12_340_000, percentile: p => p === 50 ? 1_000_000 : 9_990_000 }, 0.1234, 60_000.4);
		const busy = paradisSummarizeMainLoop({ max: 1_500_000_000, percentile: () => 50_000_000 }, 1.5, 10);
		assert.deepStrictEqual({ calm, busy, calmCongested: paradisIsMainLoopCongested(calm), busyCongested: paradisIsMainLoopCongested(busy) }, {
			calm: { p50Ms: 1, p99Ms: 10, maxMs: 12.3, busyPct: 12.3, durationMs: 60_000 },
			busy: { p50Ms: 50, p99Ms: 50, maxMs: 1500, busyPct: 100, durationMs: 10 },
			calmCongested: false,
			busyCongested: true,
		});
	});

	test('splits a stat round trip into the way to main, the time in main and the way back', () => {
		assert.deepStrictEqual({
			normal: paradisSplitStatRoundTrip(100, { receivedAt: 130, repliedAt: 180, fsMs: 42.6, ok: true }, 200),
			// 時計の粒度で 1ms 前後しても負にしない。
			jitter: paradisSplitStatRoundTrip(100, { receivedAt: 99, repliedAt: 99, fsMs: 0, ok: true }, 98),
			// 時計が飛んだ回は分布に混ぜない。
			clockJump: paradisSplitStatRoundTrip(10_000, { receivedAt: 1_000, repliedAt: 1_010, fsMs: 1, ok: true }, 10_020),
		}, {
			normal: { toMainMs: 30, mainMs: 50, backMs: 20, fsMs: 43 },
			jitter: { toMainMs: 0, mainMs: 0, backMs: 0, fsMs: 0 },
			clockJump: undefined,
		});
	});

	test('summarizes every period, keeps the last ten, and only reports congested ones', () => {
		const fakes = createFakes();
		const monitor = store.add(new ParadisMainLoadMonitor(fakes.logService, fakes.deps));
		const periodic = fakes.histograms[0];
		const summaries: IParadisMainLoopPeriodSummary[] = [];
		for (let i = 0; i < 12; i++) {
			fakes.advance(60_000);
			if (i === 11) {
				periodic.p99 = 250e6;
			}
			summaries.push(monitor.summarizePeriod());
		}
		monitor.dispose();
		assert.deepStrictEqual({
			resolution: periodic.resolution,
			intervalMs: fakes.intervalMs,
			resets: periodic.resets,
			first: summaries[0],
			congested: fakes.congested.map(message => JSON.parse(message.slice(message.indexOf('{'))).p99Ms),
			enabledAfterDispose: periodic.enabled,
			cleared: fakes.cleared,
		}, {
			resolution: PARADIS_MAIN_LOAD_DEFAULTS.periodicResolutionMs,
			intervalMs: PARADIS_MAIN_LOAD_DEFAULTS.periodMs,
			resets: 12,
			first: { p50Ms: 2, p99Ms: 30, maxMs: 40, busyPct: 25, durationMs: 60_000, endedAt: 61_000 },
			congested: [250],
			enabledAfterDispose: false,
			cleared: true,
		});
	});

	test('measures a switch window with its own histogram, caps unfinished windows per caller, and only lets the owner end one', async () => {
		const fakes = createFakes();
		const monitor = store.add(new ParadisMainLoadMonitor(fakes.logService, fakes.deps));
		const otherWindow = monitor.beginWindow('window:2');
		const ids: number[] = [];
		for (let i = 0; i < PARADIS_MAIN_LOAD_DEFAULTS.maxOpenWindows + 1; i++) {
			ids.push(monitor.beginWindow('window:1'));
		}
		fakes.advance(1_500);
		fakes.setUtilization(0.9);
		const dropped = monitor.endWindow('window:1', ids[0]);
		const notOwner = monitor.endWindow('window:2', ids[1]);
		const last = monitor.endWindow('window:1', ids[ids.length - 1]);
		// 別のウィンドウの連打で追い出されていない。
		const other = monitor.endWindow('window:2', otherWindow);
		assert.deepStrictEqual({
			windowResolutions: fakes.histograms.slice(1).map(histogram => histogram.resolution),
			dropped,
			notOwner,
			last,
			other: other?.durationMs,
			lastHistogramEnabled: fakes.histograms[fakes.histograms.length - 1].enabled,
			unknown: monitor.endWindow('window:1', 999),
		}, {
			windowResolutions: Array(PARADIS_MAIN_LOAD_DEFAULTS.maxOpenWindows + 2).fill(PARADIS_MAIN_LOAD_DEFAULTS.windowResolutionMs),
			dropped: undefined,
			notOwner: undefined,
			last: { p50Ms: 2, p99Ms: 30, maxMs: 40, busyPct: 90, durationMs: 1_500 },
			other: 1_500,
			lastHistogramEnabled: false,
			unknown: undefined,
		});
	});

	test('drops windows that were never ended once they are too old, and caps all windows together', () => {
		const fakes = createFakes();
		const monitor = store.add(new ParadisMainLoadMonitor(fakes.logService, fakes.deps));
		// 開いたまま消えたウィンドウ (クラッシュで endWindow が届かない)。
		const orphan = monitor.beginWindow('window:crashed');
		const orphanHistogram = fakes.histograms[fakes.histograms.length - 1];
		fakes.advance(PARADIS_MAIN_LOAD_DEFAULTS.maxWindowAgeMs + 1);
		const fresh = monitor.beginWindow('window:1');
		const afterAge = { orphan: monitor.endWindow('window:crashed', orphan), orphanEnabled: orphanHistogram.enabled };
		// 持ち主ごとの上限の内側でも、全体の上限で古い順に捨てる。
		const owners = Array.from({ length: PARADIS_MAIN_LOAD_DEFAULTS.maxOpenWindowsTotal }, (_, index) => `window:many-${index}`);
		const ids = owners.map(owner => monitor.beginWindow(owner));
		assert.deepStrictEqual({
			afterAge,
			freshDropped: monitor.endWindow('window:1', fresh),
			firstManyKept: monitor.endWindow(owners[0], ids[0]) !== undefined,
			lastKept: monitor.endWindow(owners[owners.length - 1], ids[ids.length - 1]) !== undefined,
			enabledLeft: fakes.histograms.slice(1).filter(histogram => histogram.enabled).length,
		}, {
			afterAge: { orphan: undefined, orphanEnabled: false },
			// 全体の上限に達したとき、いちばん古い区間 (fresh) から捨てる。
			freshDropped: undefined,
			firstManyKept: true,
			lastKept: true,
			enabledLeft: PARADIS_MAIN_LOAD_DEFAULTS.maxOpenWindowsTotal - 2,
		});
	});

	test('exposes only the four calls over the channel and passes the caller as the owner', async () => {
		const fakes = createFakes();
		const monitor = store.add(new ParadisMainLoadMonitor(fakes.logService, fakes.deps));
		const channel = paradisCreateMainLoadChannel(monitor);
		const id = await channel.call<number>('window:7', 'beginWindow', []);
		const fromOther = await channel.call('window:8', 'endWindow', [id]);
		const fromOwner = await channel.call<{ durationMs: number }>('window:7', 'endWindow', [id]);
		const summaries = await channel.call('window:7', 'getRecentSummaries', []);
		let hidden: string | undefined;
		try {
			await channel.call('window:7', 'summarizePeriod', []);
		} catch (error) {
			hidden = (error as Error).message;
		}
		assert.deepStrictEqual({ fromOther, fromOwnerMs: fromOwner?.durationMs, summaries, hidden }, {
			fromOther: undefined,
			fromOwnerMs: 0,
			summaries: [],
			hidden: 'Call not found: summarizePeriod',
		});
	});

	test('stats a local folder from main and refuses other schemes', async () => {
		const monitor = store.add(new ParadisMainLoadMonitor(new NullLogService()));
		const local = await monitor.probeStat(URI.file(tmpdir()).toJSON());
		const missing = await monitor.probeStat(URI.file(`${tmpdir()}/paradis-main-load-missing-${Date.now()}`).toJSON());
		const remote = await monitor.probeStat(URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/home' }).toJSON());
		assert.deepStrictEqual({
			localOk: local?.ok,
			localOrdered: local !== undefined && local.repliedAt >= local.receivedAt && local.fsMs >= 0,
			missingOk: missing?.ok,
			remote,
		}, { localOk: true, localOrdered: true, missingOk: false, remote: undefined });
	});
});
