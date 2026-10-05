/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisIngestOpenOptions, IParadisIngestStream, IParadisIngestTerminal } from '../../common/paradisVoiceIngest.js';
import { AivisError } from '../../node/paradisAudioScheduler.js';
import { paradisHandoffVoice } from '../../node/paradisVoiceHandoff.js';
import { ParadisVoiceRetentionBudget } from '../../common/paradisVoiceRetention.js';

class FakeStream implements IParadisIngestStream {
	readonly id = 'job';
	private readonly preludeListeners: Array<(reason: string) => void> = [];
	onDidRejectPrelude(listener: (reason: string) => void): void { this.preludeListeners.push(listener); }
	rejectPrelude(reason: string): void { this.preludeListeners.forEach(listener => listener(reason)); }
	readonly events: string[] = [];
	readonly handoffGate = new DeferredPromise<boolean>();
	readonly finishedGate = new DeferredPromise<IParadisIngestTerminal>();
	readonly handoff = this.handoffGate.p;
	readonly finished = this.finishedGate.p;
	private readonly startListeners: Array<() => void> = [];
	onDidStart(listener: () => void): void { this.startListeners.push(listener); }
	start(): void { this.startListeners.forEach(listener => listener()); }
	writeMode: 'ok' | 'block' | 'fail-second' = 'ok';
	readonly writeGate = new DeferredPromise<void>();
	private writes = 0;
	async write(chunk: Uint8Array): Promise<void> {
		this.events.push(`write:${chunk.byteLength}`);
		this.writes++;
		if (this.writeMode === 'fail-second' && this.writes === 2) {
			throw new Error('stdin closed');
		}
		if (this.writeMode === 'block') {
			await this.writeGate.p;
		}
	}
	async end(): Promise<void> { this.events.push('end'); }
	async abort(reason: string): Promise<void> { this.events.push(`abort:${reason}`); }
	withdraw?: () => Promise<boolean | undefined>;
}

async function* body(...parts: number[]): AsyncGenerator<Uint8Array> {
	for (const size of parts) {
		yield new Uint8Array(size);
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
}

suite('paradisHandoffVoice', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function port(stream: FakeStream | undefined, ready = true) {
		const opened: IParadisIngestOpenOptions[] = [];
		return {
			opened,
			ingest: {
				whenReady: async () => ready,
				open: (options: IParadisIngestOpenOptions) => { opened.push(options); return stream; },
			},
		};
	}

	const prelude = { path: '/sounds/chime.mp3', volume: 0.4 };

	test('releases at queued while the synthesis keeps streaming, and sends the full clip to mobile', async () => {
		const stream = new FakeStream();
		const { ingest, opened } = port(stream);
		const completed: number[] = [];
		const pending = paradisHandoffVoice({
			ingest,
			open: { priority: 'high', gainKey: 'aivis:m:default', volumeDb: -3, prelude },
			synthesize: async () => ({ body: body(100, 200) }),
			onComplete: audio => completed.push(audio.byteLength),
			onPlayLocally: () => assert.fail('the worker played it'),
		});
		stream.handoffGate.complete(true);
		const result = await pending;
		await flush();
		stream.finishedGate.complete({ status: 'done' });
		await flush();
		assert.deepStrictEqual({ result: { kind: result.kind, settled: result.kind === 'released' ? await result.settled : undefined }, opened, events: stream.events, completed }, {
			result: { kind: 'released', settled: {} },
			opened: [{ priority: 'high', gainKey: 'aivis:m:default', volumeDb: -3, prelude }],
			events: ['write:100', 'write:200', 'end'],
			completed: [300],
		});
	});

	test('returns the received audio for afplay when --ingest fails before queued', async () => {
		const stream = new FakeStream();
		const pending = paradisHandoffVoice({
			ingest: port(stream).ingest,
			open: { priority: 'normal' },
			synthesize: async () => ({ body: body(10, 20) }),
			onPlayLocally: () => { },
		});
		await flush();
		stream.handoffGate.complete(false);
		const result = await pending;
		assert.deepStrictEqual({ kind: result.kind, bytes: result.kind === 'fallback' ? result.audio?.byteLength : undefined }, { kind: 'fallback', bytes: 30 });
	});

	test('plays locally only what the worker withdrew or gave up on before any audio frame was written', async () => {
		const played: string[] = [];
		const run = async (name: string, terminal: IParadisIngestTerminal, synthesizeAfterFinish: boolean) => {
			const stream = new FakeStream();
			const audio = new DeferredPromise<void>();
			const pending = paradisHandoffVoice({
				ingest: port(stream).ingest,
				open: { priority: 'normal' },
				synthesize: async () => ({
					body: (async function* () {
						if (synthesizeAfterFinish) {
							await audio.p;
						}
						yield new Uint8Array(40);
					})(),
				}),
				onPlayLocally: clip => played.push(`${name}:${clip.byteLength}`),
			});
			stream.handoffGate.complete(true);
			await pending;
			if (!synthesizeAfterFinish) {
				await flush();
			}
			stream.finishedGate.complete(terminal);
			await flush();
			audio.complete();
			await flush();
		};
		await run('withdrawn', { status: 'failed', reason: 'worker-unavailable', withdrawn: true }, false);
		await run('first-audio-before-write', { status: 'failed', reason: 'first-audio-timeout' }, true);
		await run('first-audio-after-write', { status: 'failed', reason: 'first-audio-timeout' }, false);
		await run('lost', { status: 'failed', reason: 'lost' }, false);
		// 最初の音を待ちきれなかった件は、書いた量に関係なく worker は声を鳴らしていない（L2）
		assert.deepStrictEqual(played, ['withdrawn:40', 'first-audio-before-write:40', 'first-audio-after-write:40']);
	});

	test('aborts the job and rethrows when the synthesis fails, reporting whether the worker had started', async () => {
		const stream = new FakeStream();
		const { ingest, opened } = port(stream);
		let started = false;
		await assert.rejects(paradisHandoffVoice({
			ingest,
			open: { priority: 'normal', prelude },
			synthesize: async () => {
				stream.start();
				throw new AivisError('retryable', 'timeout');
			},
			onStarted: () => { started = true; },
			onPlayLocally: () => { },
		}), AivisError);
		const notReady = await paradisHandoffVoice({ ingest: port(undefined, false).ingest, open: { priority: 'normal' }, synthesize: async () => ({ body: body(1) }), onPlayLocally: () => { } });
		assert.deepStrictEqual({ opened, events: stream.events, started, notReady }, {
			opened: [{ priority: 'normal', prelude }],
			events: ['abort:synth-failed'],
			started: true,
			notReady: { kind: 'fallback' },
		});
	});

	test('waits briefly after a synthesis failure to learn whether the worker had started the ringtone', async () => {
		const stream = new FakeStream();
		let started = false;
		await assert.rejects(paradisHandoffVoice({
			ingest: port(stream).ingest,
			open: { priority: 'normal', prelude },
			synthesize: async () => {
				// 中断を送った直後に、worker から鳴り始めの知らせが届く
				setTimeout(() => stream.start(), 50);
				throw new AivisError('retryable', 'timeout');
			},
			onStarted: () => { started = true; },
			onPlayLocally: () => { },
		}), AivisError);
		assert.deepStrictEqual({ started, events: stream.events }, { started: true, events: ['abort:synth-failed'] });
	});

	test('keeps reading the synthesis while the --ingest write is slow or fails, so the mobile stream is not cut', async () => {
		const outcomes: unknown[] = [];
		for (const writeMode of ['block', 'fail-second'] as const) {
			const stream = new FakeStream();
			stream.writeMode = writeMode;
			const { ingest } = port(stream);
			const consumed: number[] = [];
			async function* tracked(): AsyncGenerator<Uint8Array> {
				for (const size of [100, 200, 300]) {
					consumed.push(size);
					yield new Uint8Array(size);
				}
			}
			const pending = paradisHandoffVoice({
				ingest,
				open: { priority: 'normal' },
				synthesize: async () => ({ body: tracked() }),
				onPlayLocally: () => { },
			});
			stream.handoffGate.complete(true);
			await pending;
			await flush();
			// 手元の 1 つ目の書き込みが止まっていても、本文は最後まで読み終えている
			const readWhileStuck = [...consumed];
			stream.writeGate.complete();
			await flush();
			stream.finishedGate.complete({ status: 'done' });
			await flush();
			outcomes.push({ writeMode, readWhileStuck, events: stream.events });
		}
		assert.deepStrictEqual(outcomes, [
			{ writeMode: 'block', readWhileStuck: [100, 200, 300], events: ['write:100', 'write:200', 'write:300', 'end'] },
			{ writeMode: 'fail-second', readWhileStuck: [100, 200, 300], events: ['write:100', 'write:200', 'abort:write-failed'] },
		]);
	});
	test('defers instead of falling back while the worker may still be alive (H5)', async () => {
		const results: unknown[] = [];
		for (const direct of [false, true]) {
			results.push(await paradisHandoffVoice({
				ingest: { whenReady: async () => false, open: () => undefined, mayPlayDirectly: () => direct },
				open: { priority: 'normal' },
				synthesize: async () => ({ body: body(1) }),
				onPlayLocally: () => { },
			}));
		}
		assert.deepStrictEqual(results, [{ kind: 'defer' }, { kind: 'fallback' }]);
	});

	test('asks the scheduler to retry when the synthesis breaks before the first audio byte after the handoff (M6)', async () => {
		const stream = new FakeStream();
		const pending = paradisHandoffVoice({
			ingest: port(stream).ingest,
			open: { priority: 'normal' },
			synthesize: async () => ({
				body: (async function* (): AsyncGenerator<Uint8Array> {
					throw new AivisError('retryable', 'reset');
				})(),
			}),
			onPlayLocally: () => assert.fail('nothing to play'),
		});
		stream.handoffGate.complete(true);
		const result = await pending;
		const settled = result.kind === 'released' ? await result.settled : undefined;
		assert.deepStrictEqual({ kind: result.kind, retry: settled?.retry?.kind, events: stream.events }, { kind: 'released', retry: 'retryable', events: ['abort:synth-failed'] });
	});

	test('keeps the replay copy only within the retention budget and drops it once the worker starts (H4)', async () => {
		const budget = new ParadisVoiceRetentionBudget(150, 4);
		const outcomes: unknown[] = [];
		for (const [name, sizes, startEarly] of [['over-budget', [100, 100], false], ['started', [40], true], ['kept', [60], false]] as const) {
			const stream = new FakeStream();
			const played: number[] = [];
			const gate = new DeferredPromise<void>();
			const pending = paradisHandoffVoice({
				ingest: port(stream).ingest,
				open: { priority: 'normal' },
				synthesize: async () => ({
					body: (async function* () {
						for (const size of sizes) {
							yield new Uint8Array(size);
						}
						await gate.p;
					})(),
				}),
				retention: () => budget.open(),
				onPlayLocally: clip => played.push(clip.byteLength),
			});
			stream.handoffGate.complete(true);
			await pending;
			await flush();
			const during = budget.usage.bytes;
			if (startEarly) {
				stream.start();
			}
			gate.complete();
			await flush();
			stream.finishedGate.complete({ status: 'failed', reason: 'worker-unavailable', withdrawn: true });
			await flush();
			outcomes.push({ name, during, played, after: budget.usage });
		}
		assert.deepStrictEqual(outcomes, [
			// 枠を超えたら控えずに手放す（鳴らし直しはできない）
			{ name: 'over-budget', during: 0, played: [], after: { bytes: 0, count: 0 } },
			{ name: 'started', during: 40, played: [], after: { bytes: 0, count: 0 } },
			{ name: 'kept', during: 60, played: [60], after: { bytes: 0, count: 0 } },
		]);
	});

	test('reports a rejected prelude so the caller plays the ringtone (M4)', async () => {
		const stream = new FakeStream();
		let rejected = 0;
		const pending = paradisHandoffVoice({
			ingest: port(stream).ingest,
			open: { priority: 'normal', prelude },
			synthesize: async () => ({ body: body(10) }),
			onPreludeRejected: () => rejected++,
			onPlayLocally: () => { },
		});
		await flush();
		stream.rejectPrelude('too-large');
		stream.handoffGate.complete(true);
		await pending;
		assert.strictEqual(rejected, 1);
	});

	test('keeps the rate limit of a synthesis that could not be handed off (M8)', async () => {
		const stream = new FakeStream();
		const rateLimit = { remaining: 0, resetSeconds: 30, capturedAt: 1 };
		const pending = paradisHandoffVoice({
			ingest: port(stream).ingest,
			open: { priority: 'normal' },
			synthesize: async () => ({ body: body(5), rateLimit }),
			onPlayLocally: () => { },
		});
		await flush();
		stream.handoffGate.complete(false);
		const result = await pending;
		assert.deepStrictEqual(result.kind === 'fallback' ? { bytes: result.audio?.byteLength, rateLimit: result.rateLimit } : undefined, { bytes: 5, rateLimit });
	});
	test('withdraws a job whose queued does not arrive in time and plays it only when it was removed (aivis-mcp 2.5.1)', async () => {
		const outcomes: unknown[] = [];
		for (const removed of [true, false, undefined]) {
			const stream = new FakeStream();
			if (removed !== undefined) {
				stream.withdraw = async () => {
					stream.events.push('withdraw');
					if (removed) {
						stream.handoffGate.complete(false);
						stream.finishedGate.complete({ status: 'skipped', reason: 'withdrawn', withdrawn: true });
					}
					return removed;
				};
			}
			const result = await paradisHandoffVoice({
				ingest: port(stream).ingest,
				open: { priority: 'normal' },
				synthesize: async () => ({ body: body(7) }),
				onPlayLocally: () => { },
				queuedWaitMs: 10,
			});
			outcomes.push({ kind: result.kind, bytes: result.kind === 'fallback' ? result.audio?.byteLength : undefined, withdrew: stream.events.includes('withdraw') });
		}
		assert.deepStrictEqual(outcomes, [
			{ kind: 'fallback', bytes: 7, withdrew: true },
			{ kind: 'released', bytes: undefined, withdrew: true },
			{ kind: 'released', bytes: undefined, withdrew: false },
		]);
	});
});
