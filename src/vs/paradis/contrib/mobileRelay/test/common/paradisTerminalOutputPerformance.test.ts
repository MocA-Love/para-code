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
	/** 区切りごとの「候補 ÷ 基準」の中央値。毎回かかる上乗せを見る。 */
	readonly ratio: number;
	/** 区切りごとの「候補 − 基準」の p95（ms）。ときどき固まる上乗せ（裾）を見る。 */
	readonly deltaP95Ms: number;
	/** 参考に出す、基準の区切りの中央値（ms）。 */
	readonly baselineMs: number;
}

interface BenchmarkVerdict {
	readonly passed: boolean;
	readonly rounds: readonly BenchmarkResult[];
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
// 1 条件を最大 3 回測り、過半数（2 回）の回が範囲に入れば通す。CI の負荷の波に 1 回だけ当たった
// 外れは許し、毎回出る上乗せも裾の上乗せも 3 回のうち 2 回以上に出るので落ちる。
const ROUNDS = 3;
const MAJORITY = 2;
// docs の設計（2026-07-14 の terminal recovery performance）の基準: relay 無効時に対して 10% 以内かつ 5ms 以内。
const RELATIVE_LIMIT = 1.10;
const ABSOLUTE_P95_LIMIT_MS = 5;
// 判定が裾を見ていることを確かめる偽の経路: 4 区切りに 1 回だけ、区切りまるごと 20ms 遅くする。
const SPIKE_EVERY_SLICES = 4;
const SPIKE_MS = 20;
let rendererWorkSink = 0;

suite('ParadisTerminalOutputPerformance', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the input-to-echo event-loop proxy within 10% and 5ms for every output route', async function () {
		this.timeout(60_000);
		const conditions: BenchmarkCondition[] = [];
		for (const relayEnabled of [false, true]) {
			for (const subscribed of [false, true]) {
				for (const agent of [false, true]) {
					conditions.push({ relayEnabled, subscribed, agent });
				}
			}
		}

		for (const condition of conditions) {
			const verdict = await judge(() => createOutputRoute(condition));
			assert.ok(verdict.passed, `${formatCondition(condition)} exceeded 10% (median of the paired ratios) or 5ms (p95 of the paired differences) in more than one of ${ROUNDS} rounds: ${formatRounds(verdict.rounds)}`);
		}
		assert.notStrictEqual(rendererWorkSink, 0, 'the Renderer workload must remain observable to the JIT');
	});

	test('rejects an output route that blocks only some of the slices', async function () {
		this.timeout(60_000);
		const verdict = await judge(() => createSpikingRoute());
		assert.ok(!verdict.passed, `a route that adds ${SPIKE_MS}ms to every ${SPIKE_EVERY_SLICES}th slice passed: ${formatRounds(verdict.rounds)}`);
	});
});

/** 過半数の回が範囲に入るかを、決まった時点で打ち切りながら測る。 */
async function judge(createRoute: () => BenchmarkOutputRoute | undefined): Promise<BenchmarkVerdict> {
	const rounds: BenchmarkResult[] = [];
	let passedRounds = 0;
	while (rounds.length < ROUNDS && passedRounds < MAJORITY && rounds.length - passedRounds <= ROUNDS - MAJORITY) {
		const result = await benchmarkAgainstRelayOff(createRoute);
		rounds.push(result);
		if (withinLimits(result)) {
			passedRounds++;
		}
	}
	return { passed: passedRounds >= MAJORITY, rounds };
}

/**
 * 基準（relay off）と候補を同じ区切りの中で交互に測り、区切りごとに組にして比べる。毎回かかる
 * 上乗せは比の中央値、ときどき固まる上乗せは差の p95 で見る。2 本の列から別々に p95 を取ると、
 * GC や CI の CPU の取り合いで片方の列にだけ入った外れ値（50 件の p95 は上から 3 番目の値）で
 * 落ちてしまう。同じ区切りの中の外れは両方に効くので、組にすると打ち消される。
 *
 * 実PTY/Electron/xtermをunit runnerへ持ち込むとhost負荷でflakyになるため、ここで測るのは
 * 「大量onDataと別terminal echo callbackが同じRenderer event loopを共有する」slice proxy。
 * Para側はproduction dispatch/relay queue/hint parserそのものを通す。xterm描画は全条件で同一の
 * 文字走査に置換しているため、Renderer/PTY Host固有の遅延は実アプリprofileの対象として残る。
 */
async function benchmarkAgainstRelayOff(createRoute: () => BenchmarkOutputRoute | undefined): Promise<BenchmarkResult> {
	const candidate = createRoute();
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
		return { ratio: 1, deltaP95Ms: 0, baselineMs: median(latencies) };
	}
	try {
		for (let index = 0; index < WARMUP_SLICES; index++) {
			await measurePairedEventLoopSlice(candidate.consume, index % 2 === 1);
		}

		const baselineLatencies: number[] = [];
		const ratios: number[] = [];
		const deltas: number[] = [];
		for (let index = 0; index < MEASURED_SLICES; index++) {
			const [baseline, measured] = await measurePairedEventLoopSlice(candidate.consume, index % 2 === 1);
			baselineLatencies.push(baseline);
			ratios.push(measured / baseline);
			deltas.push(measured - baseline);
		}
		return { ratio: median(ratios), deltaP95Ms: percentile95(deltas), baselineMs: median(baselineLatencies) };
	} finally {
		candidate.dispose();
	}
}

function withinLimits(result: BenchmarkResult): boolean {
	return result.ratio <= RELATIVE_LIMIT && result.deltaP95Ms <= ABSOLUTE_P95_LIMIT_MS;
}

/** 区切りの番号を数え、`SPIKE_EVERY_SLICES` 区切りに 1 回だけ、その区切りの候補の計測をまるごと遅くする。 */
function createSpikingRoute(): BenchmarkOutputRoute {
	const callsPerSlice = CHUNKS_PER_SLICE * REPETITIONS_PER_SLICE;
	const perCallMs = SPIKE_MS / CHUNKS_PER_SLICE;
	let calls = 0;
	return {
		consume: () => {
			const slice = Math.floor(calls / callsPerSlice);
			calls++;
			if (slice % SPIKE_EVERY_SLICES === 0) {
				const until = performance.now() + perCallMs;
				while (performance.now() < until) {
					// 区切りを遅くする
				}
			}
		},
		dispose: () => { },
	};
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
	// 区切りの中の 7 回のうち一番速い回を使う。OS が CPU を他へ回した分（負荷のある CI では 1 回の
	// 計測が数 ms 伸びる）は片方の回にだけ足されるので、最小値で落とす。経路そのものの上乗せは
	// どの回にもかかるので最小値にも残り、区切りまるごとの固まりも残る。
	return [Math.min(...baseline), Math.min(...candidate)];
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

function formatRounds(rounds: readonly BenchmarkResult[]): string {
	return rounds.map(round => `+${((round.ratio - 1) * 100).toFixed(1)}% median, +${round.deltaP95Ms.toFixed(3)}ms p95 over ${round.baselineMs.toFixed(3)}ms`).join('; ');
}

function formatCondition(condition: BenchmarkCondition): string {
	return `relay=${condition.relayEnabled ? 'on' : 'off'},subscription=${condition.subscribed ? 'on' : 'off'},agent=${condition.agent ? 'yes' : 'no'}`;
}
