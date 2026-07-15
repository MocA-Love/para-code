/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese benchmark comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentTerminalHintParser } from '../../common/paradisAgentTerminalHints.js';
import { IParadisTerminalRelayPendingState, paradisCreateAgentTerminalHintConsumer, paradisCreateTerminalOutputConsumer, paradisQueueTerminalRelayOutput, ParadisTerminalOutputConsumer } from '../../common/paradisTerminalOutputHotPath.js';

interface BenchmarkCondition {
	readonly relayEnabled: boolean;
	readonly subscribed: boolean;
	readonly agent: boolean;
}

interface BenchmarkResult {
	readonly baselineP95Ms: number;
	readonly conditionP95Ms: number;
}

interface BenchmarkOutputRoute {
	readonly consume: ParadisTerminalOutputConsumer;
	dispose(): void;
}

const OUTPUT_CHUNK = '\x1b[32mcompose-service\x1b[0m | request completed status=200 duration=12ms\r\n'.repeat(8);
// Node 24のwarmup後にrelay-off baselineが概ね1〜3msになる固定量。
const CHUNKS_PER_SLICE = 768;
const WARMUP_SLICES = 12;
const MEASURED_SLICES = 50;
const REPETITIONS_PER_SLICE = 7;
let rendererWorkSink = 0;

suite('ParadisTerminalOutputPerformance', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the input-to-echo event-loop p95 proxy within 10% and 5ms for every output route', async function () {
		this.timeout(30_000);
		const conditions: BenchmarkCondition[] = [];
		for (const relayEnabled of [false, true]) {
			for (const subscribed of [false, true]) {
				for (const agent of [false, true]) {
					conditions.push({ relayEnabled, subscribed, agent });
				}
			}
		}

		for (const condition of conditions) {
			const result = await benchmarkAgainstRelayOff(condition);
			const relativeLimit = result.baselineP95Ms * 1.10;
			const absoluteDelta = result.conditionP95Ms - result.baselineP95Ms;
			assert.ok(
				result.conditionP95Ms <= relativeLimit,
				`${formatCondition(condition)} p95 ${result.conditionP95Ms.toFixed(3)}ms exceeded relay-off baseline ${result.baselineP95Ms.toFixed(3)}ms by more than 10%`,
			);
			assert.ok(
				absoluteDelta <= 5,
				`${formatCondition(condition)} added ${absoluteDelta.toFixed(3)}ms to the relay-off p95`,
			);
		}
		assert.notStrictEqual(rendererWorkSink, 0, 'the Renderer workload must remain observable to the JIT');
	});
});

/**
 * 実PTY/Electron/xtermをunit runnerへ持ち込むとhost負荷でflakyになるため、ここで測るのは
 * 「大量onDataと別terminal echo callbackが同じRenderer event loopを共有する」slice proxy。
 * Para側はproduction dispatch/relay queue/hint parserそのものを通す。xterm描画は全条件で同一の
 * 文字走査に置換しているため、Renderer/PTY Host固有の遅延は実アプリprofileの対象として残る。
 */
async function benchmarkAgainstRelayOff(condition: BenchmarkCondition): Promise<BenchmarkResult> {
	const candidate = createOutputRoute(condition);
	if (candidate === undefined) {
		// productionではconsumerがなければonData listener自体が存在しないため、候補経路は
		// baselineと同一。別々に測ってscheduler/GC差を「機能overhead」と誤認しない。
		for (let index = 0; index < WARMUP_SLICES; index++) {
			await yieldToEventLoop();
			measureSynchronousBlocking(undefined);
		}
		const latencies: number[] = [];
		for (let index = 0; index < MEASURED_SLICES; index++) {
			await yieldToEventLoop();
			latencies.push(measureSynchronousBlocking(undefined));
		}
		const p95 = percentile95(latencies);
		return { baselineP95Ms: p95, conditionP95Ms: p95 };
	}
	try {
		for (let index = 0; index < WARMUP_SLICES; index++) {
			await measurePairedEventLoopSlice(candidate.consume, index % 2 === 1);
		}

		const baselineLatencies: number[] = [];
		const conditionLatencies: number[] = [];
		for (let index = 0; index < MEASURED_SLICES; index++) {
			const [baseline, measured] = await measurePairedEventLoopSlice(candidate.consume, index % 2 === 1);
			baselineLatencies.push(baseline);
			conditionLatencies.push(measured);
		}
		return { baselineP95Ms: percentile95(baselineLatencies), conditionP95Ms: percentile95(conditionLatencies) };
	} finally {
		candidate.dispose();
	}
}

function createOutputRoute(condition: BenchmarkCondition): BenchmarkOutputRoute | undefined {
	const hintConsumer = condition.relayEnabled && condition.agent
		? paradisCreateAgentTerminalHintConsumer(new ParadisAgentTerminalHintParser(Date.now), () => { })
		: undefined;
	const relayState: IParadisTerminalRelayPendingState & { coalesceTimer: number | undefined } = {
		suspended: false,
		droppedWhileSuspended: false,
		pending: [],
		pendingChars: 0,
		coalesceTimer: undefined,
	};
	const relayConsumer = condition.relayEnabled && condition.subscribed
		? (data: string) => paradisQueueTerminalRelayOutput(
			relayState,
			data,
			() => {
				relayState.pending = [];
				relayState.pendingChars = 0;
				relayState.coalesceTimer = undefined;
			},
			() => { relayState.coalesceTimer = 1; },
		)
		: undefined;
	const consume = paradisCreateTerminalOutputConsumer(relayConsumer, hintConsumer?.accept);
	if (consume === undefined) {
		return undefined;
	}
	return {
		consume,
		dispose: () => hintConsumer?.dispose(),
	};
}

async function measurePairedEventLoopSlice(outputRoute: ParadisTerminalOutputConsumer, candidateFirst: boolean): Promise<readonly [number, number]> {
	await yieldToEventLoop();
	const baseline: number[] = [];
	const candidate: number[] = [];
	for (let index = 0; index < REPETITIONS_PER_SLICE; index++) {
		if ((index + (candidateFirst ? 1 : 0)) % 2 === 0) {
			baseline.push(measureSynchronousBlocking(undefined));
			candidate.push(measureSynchronousBlocking(outputRoute));
		} else {
			candidate.push(measureSynchronousBlocking(outputRoute));
			baseline.push(measureSynchronousBlocking(undefined));
		}
	}
	return [median(baseline), median(candidate)];
}

function measureSynchronousBlocking(outputRoute: ParadisTerminalOutputConsumer | undefined): number {
	const startedAt = performance.now();
	let rendererChecksum = 0;
	for (let chunkIndex = 0; chunkIndex < CHUNKS_PER_SLICE; chunkIndex++) {
		// 実xtermはunit runnerへ持ち込めないため、ANSI state・style・cell更新を含む固定走査で
		// 同じRenderer負荷を両経路へ与える。単純な加算loopより実際のparse形状に近い。
		rendererChecksum = (rendererChecksum + simulateRendererOutput(OUTPUT_CHUNK)) >>> 0;
		outputRoute?.(OUTPUT_CHUNK);
	}
	const blockingMs = performance.now() - startedAt;
	rendererWorkSink = (rendererWorkSink + rendererChecksum) >>> 0;
	return blockingMs;
}

function simulateRendererOutput(data: string): number {
	let state = 0;
	let style = 0;
	let column = 0;
	let checksum = 2_166_136_261;
	for (let index = 0; index < data.length; index++) {
		const code = data.charCodeAt(index);
		if (state === 0) {
			if (code === 0x1b) {
				state = 1;
			} else if (code === 0x0a) {
				column = 0;
				checksum = (checksum ^ 0x9e3779b9) >>> 0;
			} else {
				column = (column + 1) % 240;
				checksum = Math.imul(checksum ^ (code + column + style), 16_777_619) >>> 0;
			}
		} else if (state === 1) {
			state = code === 0x5b ? 2 : 0;
		} else if (code >= 0x40 && code <= 0x7e) {
			style = (style + code) & 0xff;
			state = 0;
		} else {
			checksum = (checksum + Math.imul(code, 31)) >>> 0;
		}
	}
	return (checksum ^ column ^ style ^ state) >>> 0;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise<void>(resolve => setImmediate(resolve));
}

function median(values: number[]): number {
	values.sort((a, b) => a - b);
	return values[Math.floor(values.length / 2)];
}

function percentile95(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function formatCondition(condition: BenchmarkCondition): string {
	return `relay=${condition.relayEnabled ? 'on' : 'off'},subscription=${condition.subscribed ? 'on' : 'off'},agent=${condition.agent ? 'yes' : 'no'}`;
}
