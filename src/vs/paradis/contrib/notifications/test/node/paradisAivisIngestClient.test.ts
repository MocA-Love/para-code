/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { PassThrough, Writable } from 'stream';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisIngestChild, ParadisAivisIngestClient } from '../../node/paradisAivisIngestClient.js';
import { paradisEncodeIngestAudio, paradisEncodeIngestControl, ParadisIngestFrameDecoder } from '../../node/paradisAivisIngestFrames.js';

/** 親が書いた枠を読む（テスト側。音声の枠も読む）。 */
function readFrames(data: Buffer): Array<{ readonly control?: Record<string, unknown>; readonly audio?: { readonly id: string; readonly bytes: number } }> {
	const frames: Array<{ readonly control?: Record<string, unknown>; readonly audio?: { readonly id: string; readonly bytes: number } }> = [];
	let offset = 0;
	while (offset + 5 <= data.length) {
		const type = data.readUInt8(offset);
		const length = data.readUInt32BE(offset + 1);
		const payload = data.subarray(offset + 5, offset + 5 + length);
		offset += 5 + length;
		if (type === 1) {
			frames.push({ control: JSON.parse(payload.toString('utf8')) });
		} else {
			const idLength = payload.readUInt8(0);
			frames.push({ audio: { id: payload.subarray(1, 1 + idLength).toString('utf8'), bytes: payload.length - 1 - idLength } });
		}
	}
	return frames;
}

class FakeIngestChild implements IParadisIngestChild {
	readonly written: Buffer[] = [];
	/** 書き込みの完了を止めておく（drain を待つかの確認用）。 */
	holdWrites = false;
	private readonly heldCallbacks: Array<() => void> = [];
	readonly stdin: Writable;
	readonly stdout = new PassThrough();
	private readonly exitListeners: Array<(code: number | null) => void> = [];
	killed = false;
	/** 標準入力を閉じられた（止めるよう頼まれた）。 */
	ended = false;

	constructor() {
		this.stdin = new Writable({
			highWaterMark: 1,
			final: callback => {
				this.ended = true;
				callback();
			},
			write: (chunk: Buffer, _encoding, callback) => {
				this.written.push(chunk);
				// 生きている確認には答える
				const ping = readFrames(chunk).find(frame => frame.control?.type === 'ping');
				if (ping) {
					this.say({ type: 'pong', requestId: ping.control!.requestId });
				}
				if (this.holdWrites) {
					this.heldCallbacks.push(() => callback());
				} else {
					callback();
				}
			},
		});
	}

	releaseWrites(): void {
		this.holdWrites = false;
		for (const callback of this.heldCallbacks.splice(0)) {
			callback();
		}
	}

	controls(): Array<Record<string, unknown>> {
		return readFrames(Buffer.concat(this.written)).flatMap(frame => frame.control ? [frame.control] : []);
	}

	audioBytes(): number {
		return readFrames(Buffer.concat(this.written)).reduce((sum, frame) => sum + (frame.audio?.bytes ?? 0), 0);
	}

	say(message: Record<string, unknown> & { type: string }): void {
		this.stdout.write(paradisEncodeIngestControl(message));
	}

	onExit(listener: (code: number | null) => void): void {
		this.exitListeners.push(listener);
	}

	onError(): void { }

	kill(): void {
		this.killed = true;
		this.exit(null);
	}

	exit(code: number | null): void {
		for (const listener of this.exitListeners.splice(0)) {
			listener(code);
		}
	}
}

suite('ParadisAivisIngestClient', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let clock: sinon.SinonFakeTimers;

	setup(() => {
		clock = sinon.useFakeTimers();
	});

	teardown(() => sinon.restore());

	function createClient(options: { version?: string; lock?: 'alive' | 'gone' | 'unknown' } = {}) {
		const children: FakeIngestChild[] = [];
		const spawned: string[][] = [];
		let version = options.version ?? 'aivis-mcp v2.5.0\n';
		const client = store.add(new ParadisAivisIngestClient({
			getEnv: async () => ({}),
			preludeDirs: () => ['/sounds'],
			logService: new NullLogService(),
			probeVersion: async () => version,
			probeWorkerLock: async () => options.lock === 'alive' ? true : options.lock === 'unknown' ? undefined : false,
			spawnIngest: args => {
				spawned.push([...args]);
				const child = new FakeIngestChild();
				children.push(child);
				return child;
			},
			now: () => Date.now(),
		}));
		return { client, children, spawned, setVersion: (value: string) => { version = value; } };
	}

	async function startReady(context: ReturnType<typeof createClient>): Promise<FakeIngestChild> {
		context.client.start();
		await clock.tickAsync(0);
		const child = context.children.at(-1)!;
		child.say({ type: 'hello', protocol: 1, version: '2.5.0' });
		await clock.tickAsync(0);
		return child;
	}

	test('frames round-trip and the decoder accepts chunks split anywhere', () => {
		const frame = Buffer.concat([paradisEncodeIngestControl({ type: 'hello', protocol: 1, version: '2.5.0' }), paradisEncodeIngestControl({ type: 'pong', requestId: 1 })]);
		const decoder = new ParadisIngestFrameDecoder();
		const messages = [...decoder.push(frame.subarray(0, 3)), ...decoder.push(frame.subarray(3, 20)), ...decoder.push(frame.subarray(20))];
		assert.deepStrictEqual({
			messages,
			audio: readFrames(paradisEncodeIngestAudio('abc', new Uint8Array([1, 2, 3, 4]))),
			audioRejected: (() => { try { new ParadisIngestFrameDecoder().push(paradisEncodeIngestAudio('x', new Uint8Array([1]))); return false; } catch { return true; } })(),
		}, {
			messages: [{ type: 'hello', protocol: 1, version: '2.5.0' }, { type: 'pong', requestId: 1 }],
			audio: [{ audio: { id: 'abc', bytes: 4 } }],
			audioRejected: true,
		});
	});

	test('starts --ingest only for 2.5.0 or later and becomes usable after hello', async () => {
		const old = createClient({ version: 'aivis-mcp v2.4.3' });
		old.client.start();
		await clock.tickAsync(0);
		const context = createClient();
		const child = await startReady(context);
		assert.deepStrictEqual({
			oldState: old.client.state,
			oldSpawned: old.spawned.length,
			oldHasLocal: await old.client.hasLocalAivis(0),
			state: context.client.state,
			usable: context.client.isUsable(),
			args: context.spawned[0],
			sentAfterHello: child.controls().map(control => control.type),
		}, {
			oldState: 'unsupported',
			oldSpawned: 0,
			oldHasLocal: true,
			state: 'ready',
			usable: true,
			args: ['--ingest', '--prelude-dir', '/sounds'],
			sentAfterHello: ['gain?'],
		});
	});

	test('hands off at queued and reports a failure before queued as not handed off', async () => {
		const context = createClient();
		const child = await startReady(context);
		const first = context.client.open({ priority: 'high', gainKey: 'aivis:m:default', volumeDb: -6, prelude: { path: '/sounds/a.mp3', volume: 0.5 } })!;
		await first.write(new Uint8Array(300 * 1024));
		await first.end();
		child.say({ type: 'accepted', id: first.id });
		child.say({ type: 'status', id: first.id, status: 'queued' });
		await clock.tickAsync(0);
		const second = context.client.open({ priority: 'normal' })!;
		await clock.tickAsync(0);
		child.exit(1);
		const opens = child.controls().filter(control => control.type === 'open');
		assert.deepStrictEqual({
			firstHandoff: await first.handoff,
			secondHandoff: await second.handoff,
			secondFinished: await second.finished,
			open: { ...opens[0], id: 'x' },
			audioBytes: child.audioBytes(),
			audioFrames: readFrames(Buffer.concat(child.written)).filter(frame => frame.audio).length,
			ended: child.controls().some(control => control.type === 'end' && control.id === first.id),
		}, {
			firstHandoff: true,
			secondHandoff: false,
			secondFinished: { status: 'failed', reason: 'ingest-exited' },
			open: { type: 'open', id: 'x', kind: 'stream', priority: 'high', gainKey: 'aivis:m:default', volumeDb: -6, prelude: { path: '/sounds/a.mp3', volume: 0.5 } },
			audioBytes: 300 * 1024,
			audioFrames: 2,
			ended: true,
		});
	});

	test('waits for drain before writing the next frame', async () => {
		const context = createClient();
		const child = await startReady(context);
		const stream = context.client.open({ priority: 'normal' })!;
		await clock.tickAsync(0);
		child.holdWrites = true;
		let firstDone = false;
		let secondDone = false;
		void stream.write(new Uint8Array(10)).then(() => { firstDone = true; });
		void stream.write(new Uint8Array(10)).then(() => { secondDone = true; });
		await clock.tickAsync(0);
		const before = { firstDone, secondDone, writes: child.written.length };
		child.releaseWrites();
		await clock.tickAsync(0);
		child.releaseWrites();
		await clock.tickAsync(0);
		assert.deepStrictEqual({ before, after: { firstDone, secondDone } }, {
			// 1 つ目は標準入力へ渡した時点で終わり、2 つ目は drain を待つ
			before: { firstDone: true, secondDone: false, writes: before.writes },
			after: { firstDone: true, secondDone: true },
		});
		assert.ok(before.writes >= 3, 'the first audio frame was written but the second one waited');
	});

	test('restarts after 1, 2, 4, 8 seconds and switches to afplay after 5 failures when the worker lock is gone', async () => {
		const context = createClient({ lock: 'gone' });
		context.client.start();
		await clock.tickAsync(0);
		const spawnTimes: number[] = [Date.now()];
		for (let i = 0; i < 4; i++) {
			context.children.at(-1)!.exit(1);
			const before = context.children.length;
			while (context.children.length === before) {
				await clock.tickAsync(500);
			}
			spawnTimes.push(Date.now());
		}
		context.children.at(-1)!.exit(1);
		await clock.tickAsync(0);
		assert.deepStrictEqual({
			delays: spawnTimes.slice(1).map((time, index) => time - spawnTimes[index]),
			state: context.client.state,
			ready: await context.client.whenReady(1000),
		}, {
			delays: [1000, 2000, 4000, 8000],
			state: 'fallback',
			ready: false,
		});
	});

	test('keeps restarting instead of switching to afplay while the worker lock is alive', async () => {
		const context = createClient({ lock: 'alive' });
		context.client.start();
		await clock.tickAsync(0);
		for (let i = 0; i < 5; i++) {
			context.children.at(-1)!.exit(1);
			await clock.tickAsync(8_000);
		}
		assert.deepStrictEqual({ state: context.client.state, spawned: context.children.length }, { state: 'starting', spawned: 6 });
	});

	test('renews the hold every 20 seconds, re-applies it after a restart and clears it when released', async () => {
		const context = createClient();
		const child = await startReady(context);
		context.client.setHold('voice-input', true);
		await clock.tickAsync(40_000);
		const holdsBefore = child.controls().filter(control => control.type === 'hold').length;
		child.exit(1);
		await clock.tickAsync(1_000);
		const next = context.children.at(-1)!;
		next.say({ type: 'hello', protocol: 1, version: '2.5.0' });
		await clock.tickAsync(0);
		const reapplied = next.controls().filter(control => control.type === 'hold');
		context.client.setHold('voice-input', false);
		await clock.tickAsync(40_000);
		assert.deepStrictEqual({
			holdsBefore,
			reapplied,
			after: next.controls().filter(control => control.type === 'hold').slice(1),
		}, {
			holdsBefore: 3,
			reapplied: [{ type: 'hold', owner: 'voice-input', active: true }],
			after: [{ type: 'hold', owner: 'voice-input', active: false }],
		});
	});

	test('on a version change, waits for open streams, starts the new child and stops the old one only after the new hello', async () => {
		const context = createClient();
		const child = await startReady(context);
		context.client.setHold('voice-input', true);
		const stream = context.client.open({ priority: 'normal' })!;
		context.setVersion('aivis-mcp v2.5.1');
		await clock.tickAsync(10 * 60_000);
		const whileBusy = context.children.length;
		await stream.end();
		await clock.tickAsync(1_000);
		const next = context.children.at(-1)!;
		const oldStoppedBeforeHello = child.ended;
		next.say({ type: 'hello', protocol: 1, version: '2.5.1' });
		await clock.tickAsync(0);
		const oldStoppedAfterHello = child.ended;
		child.exit(0);
		await clock.tickAsync(0);
		assert.deepStrictEqual({
			whileBusy,
			spawned: context.children.length,
			oldStoppedBeforeHello,
			oldStoppedAfterHello,
			state: context.client.state,
			// 古い子が終わってから hold を掛け直す（古い子は終わるときに同じ持ち主の hold を外す）
			newHolds: next.controls().filter(control => control.type === 'hold').length,
		}, {
			whileBusy: 1,
			spawned: 2,
			oldStoppedBeforeHello: false,
			oldStoppedAfterHello: true,
			state: 'ready',
			newHolds: 2,
		});
	});

	test('stops using --ingest when aivis-mcp is downgraded to 2.4', async () => {
		const context = createClient();
		const child = await startReady(context);
		context.setVersion('aivis-mcp v2.4.3');
		await clock.tickAsync(10 * 60_000);
		child.exit(0);
		await clock.tickAsync(10_000);
		assert.deepStrictEqual({ state: context.client.state, spawned: context.children.length, stopped: child.ended }, { state: 'unsupported', spawned: 1, stopped: true });
	});

	test('does not kill the child for a ping stuck behind backpressure, and sends control frames before queued audio', async () => {
		const context = createClient();
		const child = await startReady(context);
		const stream = context.client.open({ priority: 'normal' })!;
		await clock.tickAsync(0);
		child.holdWrites = true;
		void stream.write(new Uint8Array(10));
		void stream.write(new Uint8Array(10));
		void stream.write(new Uint8Array(10));
		await clock.tickAsync(0);
		context.client.setHold('voice-input', true);
		// 30 秒の確認の時刻を過ぎても、書けずにいる間は返事を待つ時計を掛けない
		await clock.tickAsync(60_000);
		const killedWhileStuck = child.killed;
		const before = child.written.length;
		child.releaseWrites();
		await clock.tickAsync(0);
		child.releaseWrites();
		await clock.tickAsync(0);
		const frames = readFrames(Buffer.concat(child.written.slice(before)));
		const firstAudio = frames.findIndex(frame => frame.audio);
		assert.deepStrictEqual({
			killedWhileStuck,
			// 書けずにいた音声の後ろに並ばず、hold と ping が先に出る
			controlFirst: [...new Set(frames.slice(0, firstAudio).map(frame => frame.control?.type))].sort(),
			audioAfter: frames.slice(firstAudio).filter(frame => frame.audio).length,
		}, { killedWhileStuck: false, controlFirst: ['hold', 'ping'], audioAfter: 2 });
	});

	test('asks the next child to withdraw jobs queued before the crash and reports only removed ones as withdrawn', async () => {
		const context = createClient();
		const child = await startReady(context);
		const first = context.client.open({ priority: 'normal' })!;
		const second = context.client.open({ priority: 'normal' })!;
		const playing = context.client.open({ priority: 'normal' })!;
		for (const stream of [first, second, playing]) {
			child.say({ type: 'status', id: stream.id, status: 'queued' });
		}
		child.say({ type: 'status', id: playing.id, status: 'playing' });
		await clock.tickAsync(0);
		child.exit(1);
		await clock.tickAsync(1_000);
		const next = context.children.at(-1)!;
		next.say({ type: 'hello', protocol: 1, version: '2.5.0' });
		await clock.tickAsync(0);
		const withdraws = next.controls().filter(control => control.type === 'withdraw').map(control => control.id);
		next.say({ type: 'withdrawn', id: first.id, removed: true });
		next.say({ type: 'withdrawn', id: second.id, removed: false });
		await clock.tickAsync(0);
		assert.deepStrictEqual({
			withdraws: withdraws.map(id => id === first.id ? 'first' : id === second.id ? 'second' : 'other'),
			first: await first.finished,
			second: await second.finished,
			playing: await playing.finished,
		}, {
			withdraws: ['first', 'second'],
			first: { status: 'failed', reason: 'ingest-exited', withdrawn: true },
			second: { status: 'failed', reason: 'ingest-exited' },
			playing: { status: 'failed', reason: 'ingest-exited' },
		});
	});

	test('does not switch to afplay while the worker lock cannot be checked, until that happens five times in a row', async () => {
		const context = createClient({ lock: 'unknown' });
		context.client.start();
		await clock.tickAsync(0);
		const states: string[] = [];
		for (let i = 0; i < 9; i++) {
			context.children.at(-1)!.exit(1);
			await clock.tickAsync(8_000);
			states.push(context.client.state);
		}
		assert.deepStrictEqual(states, ['starting', 'starting', 'starting', 'starting', 'starting', 'starting', 'starting', 'starting', 'fallback']);
	});

	test('stops restarting --ingest when aivis-mcp is downgraded to 2.4 while no child is running', async () => {
		const context = createClient();
		await startReady(context);
		await clock.tickAsync(10 * 60_000 - 500);
		// 子が落ちて、起動し直しを待っている間に 2.4 へ戻された
		context.children.at(-1)!.exit(1);
		context.setVersion('aivis-mcp v2.4.3');
		await clock.tickAsync(500);
		await clock.tickAsync(30_000);
		assert.deepStrictEqual({ state: context.client.state, spawned: context.children.length }, { state: 'unsupported', spawned: 1 });
	});

	test('stops handing off after the worker fails three times in a row', async () => {
		const context = createClient();
		const child = await startReady(context);
		for (let i = 0; i < 3; i++) {
			const stream = context.client.open({ priority: 'normal' })!;
			child.say({ type: 'status', id: stream.id, status: 'queued' });
			child.say({ type: 'status', id: stream.id, status: 'failed', reason: i === 2 ? 'worker-stopped' : 'player-exited' });
			await clock.tickAsync(0);
			await stream.finished;
		}
		const degraded = context.client.isUsable();
		await clock.tickAsync(5 * 60_000);
		assert.deepStrictEqual({ degraded, recovered: context.client.isUsable() }, { degraded: false, recovered: true });
	});
});
