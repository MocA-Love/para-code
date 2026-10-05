/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobileSendTransfer, PARADIS_MOBILE_FALLBACK_PACE_BYTES_PER_SECOND, PARADIS_MOBILE_FRAGMENT_BYTES, PARADIS_MOBILE_PACING_MAX_BYTES, PARADIS_MOBILE_SCREEN_MAX_WAIT_MS, PARADIS_MOBILE_STUCK_BUFFER_MS, ParadisMobileSendPriority, ParadisMobileSendQueue, paradisMobileSendPriorityOf } from '../../common/paradisMobileSendQueue.js';
import { ParadisMobileLinkMetrics } from '../../common/paradisMobileLinkMetrics.js';

function transfer(owner: object, name: string, fragmentCount: number, log: string[], priority: ParadisMobileSendPriority = ParadisMobileSendPriority.Control, sealLog?: string[]): IParadisMobileSendTransfer {
	return {
		owner,
		priority,
		fragmentCount,
		bytes: fragmentCount * 10,
		sealFragment: async index => {
			sealLog?.push(`${name}${index}`);
			return new Uint8Array([index]);
		},
		sendSealed: (_sealed, index) => { log.push(`${name}${index}`); },
	};
}

suite('ParadisMobileSendQueue', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('serves the mobiles one fragment at a time within a priority and keeps each mobile in order', async () => {
		const queue = new ParadisMobileSendQueue();
		const log: string[] = [];
		const seals: string[] = [];
		const mobileA = {};
		const mobileB = {};
		await Promise.all([
			queue.enqueue(transfer(mobileA, 'a', 3, log, ParadisMobileSendPriority.Control, seals)),
			queue.enqueue(transfer(mobileA, 'A', 1, log, ParadisMobileSendPriority.Control, seals)),
			queue.enqueue(transfer(mobileB, 'b', 2, log, ParadisMobileSendPriority.Control, seals)),
		]);

		// 封緘（nonce を採る）順と送る順が同じ
		assert.deepStrictEqual({ log, seals }, { log: ['a0', 'b0', 'a1', 'b1', 'a2', 'A0'], seals: ['a0', 'b0', 'a1', 'b1', 'a2', 'A0'] });
	});

	test('rejects a transfer whose sealing failed and keeps sending the rest', async () => {
		const queue = new ParadisMobileSendQueue();
		const log: string[] = [];
		const owner = {};
		const failing: IParadisMobileSendTransfer = { ...transfer(owner, 'x', 2, log), sealFragment: async () => { throw new Error('seal failed'); } };
		const results = await Promise.allSettled([queue.enqueue(failing), queue.enqueue(transfer(owner, 'y', 1, log))]);

		assert.deepStrictEqual({ statuses: results.map(result => result.status), log, pending: queue.pendingBytes }, { statuses: ['rejected', 'fulfilled'], log: ['y0'], pending: 0 });
	});

	test('classifies browser payloads by their leading bytes', () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		assert.deepStrictEqual([
			paradisMobileSendPriorityOf('browser', new Uint8Array([0x50, 0x56, 0x53, 0x01, 0])),
			paradisMobileSendPriorityOf('browser', encode('{"t":"voice-stream-start","sid":"s"}')),
			paradisMobileSendPriorityOf('browser', encode('{"t":"voice-clip","sid":"s"}')),
			paradisMobileSendPriorityOf('browser', new Uint8Array([0x50, 0x4a, 0x46, 0x01, 0])),
			paradisMobileSendPriorityOf('browser', encode('{"t":"frame","data":""}')),
			paradisMobileSendPriorityOf('browser', encode('{"id":"1","ok":true}')),
			paradisMobileSendPriorityOf('term', new Uint8Array([0x50, 0x56, 0x53, 0x01])),
		], [
			{ priority: ParadisMobileSendPriority.Voice },
			{ priority: ParadisMobileSendPriority.Voice },
			// 1 本まるごとの voice-clip（詰まったときの救済）は音声の列の中の順を守り、操作・状態と交互に送る（L4・M-5）
			{ priority: ParadisMobileSendPriority.Voice, interleave: true },
			{ priority: ParadisMobileSendPriority.Screen, replaceKey: 'screencast' },
			{ priority: ParadisMobileSendPriority.Screen, replaceKey: 'screencast' },
			{ priority: ParadisMobileSendPriority.Control },
			{ priority: ParadisMobileSendPriority.Control },
		]);
	});

	/** 封緘を手で終わらせる送信（封緘の await 中に差し替え・取り下げを重ねる）。 */
	function gatedTransfer(owner: object, name: string, log: string[], options: { priority?: ParadisMobileSendPriority; replaceKey?: string; fragmentCount?: number } = {}) {
		const gates: (() => void)[] = [];
		const value: IParadisMobileSendTransfer = {
			owner,
			priority: options.priority ?? ParadisMobileSendPriority.Screen,
			...(options.replaceKey !== undefined ? { replaceKey: options.replaceKey } : {}),
			fragmentCount: options.fragmentCount ?? 1,
			bytes: (options.fragmentCount ?? 1) * 10,
			sealFragment: index => new Promise<Uint8Array>(resolve => {
				log.push(`seal:${name}${index}`);
				gates.push(() => resolve(new Uint8Array([index])));
			}),
			sendSealed: (_sealed, index) => { log.push(`send:${name}${index}`); },
		};
		return { value, release: () => gates.shift()?.() };
	}

	test('never replaces a screen JPEG whose fragment is being sealed, so no nonce is skipped', async () => {
		const queue = new ParadisMobileSendQueue();
		const log: string[] = [];
		const owner = {};
		const first = gatedTransfer(owner, 'old', log, { replaceKey: 'screencast' });
		const queued = gatedTransfer(owner, 'mid', log, { replaceKey: 'screencast' });
		const newest = gatedTransfer(owner, 'new', log, { replaceKey: 'screencast' });
		const results = [queue.enqueue(first.value)];
		// old は封緘中（nonce を採った）。mid は待っているだけなので new に差し替わる
		results.push(queue.enqueue(queued.value), queue.enqueue(newest.value));
		first.release();
		await new Promise(resolve => setTimeout(resolve, 0));
		newest.release();

		assert.deepStrictEqual({ results: await Promise.all(results), log, pending: queue.pendingBytes }, {
			results: [true, false, true],
			log: ['seal:old0', 'send:old0', 'seal:new0', 'send:new0'],
			pending: 0,
		});
	});

	test('drops the sealed bytes of a transfer cancelled while sealing, and counts its bytes once', async () => {
		const queue = new ParadisMobileSendQueue();
		const log: string[] = [];
		const owner = {};
		const sealing = gatedTransfer(owner, 'x', log, { priority: ParadisMobileSendPriority.Control, fragmentCount: 3 });
		const result = queue.enqueue(sealing.value);
		queue.cancelOwner(owner);
		sealing.release();
		const next = queue.enqueue(transfer({}, 'y', 1, log));

		assert.deepStrictEqual({ results: [await result, await next], log, pending: queue.pendingBytes }, {
			results: [false, true],
			log: ['seal:x0', 'y0'],
			pending: 0,
		});
	});

	test('a rejected seal after cancelOwner does not count the bytes twice', async () => {
		const queue = new ParadisMobileSendQueue();
		const owner = {};
		let fail: (error: Error) => void = () => { };
		const failing: IParadisMobileSendTransfer = {
			owner, priority: ParadisMobileSendPriority.Control, fragmentCount: 1, bytes: 10,
			sealFragment: () => new Promise<Uint8Array>((_resolve, reject) => { fail = reject; }),
			sendSealed: () => { },
		};
		const result = queue.enqueue(failing);
		queue.cancelOwner(owner);
		fail(new Error('seal failed'));

		assert.deepStrictEqual({ result: await result, pending: queue.pendingBytes }, { result: false, pending: 0 });
	});

	test('sends an aged screen JPEG fragment even while control frames keep coming', async () => {
		let now = 0;
		const queue = new ParadisMobileSendQueue({ now: () => now });
		const log: string[] = [];
		const screen = gatedTransfer({}, 'jpeg', log, { fragmentCount: 1 });
		const control = gatedTransfer({}, 'state', log, { priority: ParadisMobileSendPriority.Control, fragmentCount: 2 });
		const results = [queue.enqueue(control.value), queue.enqueue(screen.value)];
		now = PARADIS_MOBILE_SCREEN_MAX_WAIT_MS;
		control.release();
		await new Promise(resolve => setTimeout(resolve, 0));
		screen.release();
		await new Promise(resolve => setTimeout(resolve, 0));
		control.release();
		await Promise.all(results);

		assert.deepStrictEqual(log, ['seal:state0', 'send:state0', 'seal:jpeg0', 'send:jpeg0', 'seal:state1', 'send:state1']);
	});

	test('counts only the socket buffer and the voice lane as congestion', async () => {
		const queue = new ParadisMobileSendQueue({ bufferedAmount: () => 100 });
		const log: string[] = [];
		const voice = gatedTransfer({}, 'v', log, { priority: ParadisMobileSendPriority.Voice });
		const results = [queue.enqueue(voice.value), queue.enqueue({ ...transfer({}, 'jpeg', 4, log, ParadisMobileSendPriority.Screen) }), queue.enqueue(transfer({}, 'file', 4, log))];
		const congestion = queue.congestionBytes();
		voice.release();
		await Promise.all(results);

		assert.deepStrictEqual(congestion, 100 + 10);
	});

	test('stops trusting a bufferedAmount stuck above 32 KiB for 2 seconds and paces at 256 KiB/s instead', async () => {
		let now = 0;
		const waits: number[] = [];
		const timers: (() => void)[] = [];
		const queue = new ParadisMobileSendQueue({
			bufferedAmount: () => 64 * 1024,
			now: () => now,
			setTimeout: (handler, ms) => { waits.push(ms); timers.push(handler); },
		});
		const log: string[] = [];
		const sent = Promise.all([queue.enqueue(transfer({}, 'a', 1, log)), queue.enqueue(transfer({}, 'b', 1, log))]);
		await new Promise(resolve => setTimeout(resolve, 0));
		const beforeStuck = { log: [...log], pacing: queue.isPacing };
		now = PARADIS_MOBILE_STUCK_BUFFER_MS;
		timers.shift()!();
		await new Promise(resolve => setTimeout(resolve, 0));
		const afterFirst = { log: [...log], pacing: queue.isPacing, wait: waits[waits.length - 1] };
		now += 10_000;
		timers.shift()!();
		await sent;

		assert.deepStrictEqual({ beforeStuck, afterFirst, log }, {
			beforeStuck: { log: [], pacing: false },
			// 1 つ目は今すぐ送り、2 つ目は (10 + 64) バイトぶんの時間を空ける
			afterFirst: { log: ['a0'], pacing: true, wait: (10 + 64) * 1000 / PARADIS_MOBILE_FALLBACK_PACE_BYTES_PER_SECOND },
			log: ['a0', 'b0'],
		});
	});

	test('forgets the last served mobile when it is cancelled, and keeps pumping after the queue empties', async () => {
		const queue = new ParadisMobileSendQueue();
		const log: string[] = [];
		const a = {};
		await queue.enqueue(transfer(a, 'a', 1, log));
		queue.cancelOwner(a);
		// 列が空になった後に積んでもすぐ送る（pumping が同期で戻っている）
		const result = queue.enqueue(transfer({}, 'b', 1, log));
		assert.deepStrictEqual({ result: await result, log }, { result: true, log: ['a0', 'b0'] });
	});

	test('a screen JPEG replaced every 200 ms keeps its waiting time and still goes out after 500 ms of control traffic', async () => {
		let now = 0;
		const queue = new ParadisMobileSendQueue({ now: () => now });
		const log: string[] = [];
		const owner = {};
		const control = gatedTransfer({}, 'state', log, { priority: ParadisMobileSendPriority.Control, fragmentCount: 4 });
		const results: Promise<boolean>[] = [queue.enqueue(control.value)];
		const jpegs = [0, 1, 2].map(n => gatedTransfer(owner, `jpeg${n}-`, log, { replaceKey: 'screencast' }));
		results.push(queue.enqueue(jpegs[0].value));
		for (const n of [1, 2]) {
			now += 200;
			control.release();
			await new Promise(resolve => setTimeout(resolve, 0));
			results.push(queue.enqueue(jpegs[n].value));
		}
		// 最初の JPEG を積んでから 500ms。差し替えても待った時間は引き継がれている（引き継がなければ 100ms しか待っていない）
		now += 100;
		control.release();
		await new Promise(resolve => setTimeout(resolve, 0));
		jpegs[2].release();
		await new Promise(resolve => setTimeout(resolve, 0));
		control.release();
		await Promise.all(results);

		assert.deepStrictEqual(log, ['seal:state0', 'send:state0', 'seal:state1', 'send:state1', 'seal:state2', 'send:state2', 'seal:jpeg2-0', 'send:jpeg2-0', 'seal:state3', 'send:state3']);
	});
	test('keeps a voice clip behind the voice stream fragments queued before it for the same mobile (L4)', async () => {
		const queue = new ParadisMobileSendQueue();
		const log: string[] = [];
		const owner = {};
		await Promise.all([
			queue.enqueue(transfer(owner, 'stream', 2, log, ParadisMobileSendPriority.Voice)),
			queue.enqueue({ ...transfer(owner, 'clip', 3, log, ParadisMobileSendPriority.Voice), interleave: paradisMobileSendPriorityOf('browser', new TextEncoder().encode('{"t":"voice-clip","sid":"s"}')).interleave }),
			queue.enqueue(transfer(owner, 'state', 2, log)),
		]);
		// clip は先に始まった流れを追い越さず、操作・状態と 1 断片ずつ交互に送る（M-5）
		assert.deepStrictEqual(log, ['stream0', 'stream1', 'clip0', 'state0', 'clip1', 'state1', 'clip2']);
	});

	test('sends a promoted screen JPEG to its last fragment before control frames (F3)', async () => {
		let now = 0;
		const queue = new ParadisMobileSendQueue({ now: () => now });
		const log: string[] = [];
		const control = gatedTransfer({}, 'state', log, { priority: ParadisMobileSendPriority.Control, fragmentCount: 3 });
		const screen = gatedTransfer({}, 'jpeg', log, { fragmentCount: 3 });
		const results = [queue.enqueue(control.value), queue.enqueue(screen.value)];
		now = PARADIS_MOBILE_SCREEN_MAX_WAIT_MS;
		control.release();
		for (let i = 0; i < 3; i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
			screen.release();
		}
		for (let i = 0; i < 2; i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
			control.release();
		}
		await Promise.all(results);
		assert.deepStrictEqual(log.filter(entry => entry.startsWith('send:')), ['send:state0', 'send:jpeg0', 'send:jpeg1', 'send:jpeg2', 'send:state1', 'send:state2']);
	});

	test('stops pacing after 2 MiB while bufferedAmount stays stuck, and resumes once it moves (F2)', async () => {
		let now = 0;
		let buffered = 64 * 1024;
		const timers: (() => void)[] = [];
		const queue = new ParadisMobileSendQueue({
			bufferedAmount: () => buffered,
			now: () => now,
			setTimeout: handler => { timers.push(handler); },
		});
		const log: string[] = [];
		const fragments = Math.ceil(PARADIS_MOBILE_PACING_MAX_BYTES / (PARADIS_MOBILE_FRAGMENT_BYTES + 64)) + 4;
		const big: IParadisMobileSendTransfer = {
			owner: {},
			priority: ParadisMobileSendPriority.Control,
			fragmentCount: fragments,
			bytes: fragments * PARADIS_MOBILE_FRAGMENT_BYTES,
			sealFragment: async index => new Uint8Array([index]),
			sendSealed: (_sealed, index) => { log.push(`f${index}`); },
		};
		const sent = queue.enqueue(big);
		await new Promise(resolve => setTimeout(resolve, 0));
		now = PARADIS_MOBILE_STUCK_BUFFER_MS;
		// 時間で送る速さに切り替えたまま、時計を進めて待ちを解き続ける
		for (let i = 0; i < fragments * 3 && timers.length > 0; i++) {
			now += 1_000;
			timers.shift()!();
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		const whileStuck = log.length;
		buffered = 0;
		while (timers.length > 0) {
			timers.shift()!();
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		await sent;
		assert.deepStrictEqual({ whileStuck, after: log.length }, { whileStuck: Math.ceil(PARADIS_MOBILE_PACING_MAX_BYTES / (PARADIS_MOBILE_FRAGMENT_BYTES + 64)), after: fragments });
	});

	test('measures the wait, sealing and socket depth of each transfer only while measuring is on', async () => {
		const metrics = new ParadisMobileLinkMetrics();
		const queue = new ParadisMobileSendQueue({ bufferedAmount: () => 100, metrics });
		const log: string[] = [];
		await queue.enqueue(transfer({}, 'off', 1, log));
		metrics.setEnabled(true);
		await Promise.all([
			queue.enqueue(transfer({}, 'c', 2, log)),
			queue.enqueue(transfer({}, 'v', 1, log, ParadisMobileSendPriority.Voice)),
		]);
		const snapshot = metrics.snapshot();
		const counts: Record<string, number> = {};
		for (const [name, summary] of Object.entries(snapshot.histograms)) {
			counts[name] = summary.count;
		}

		assert.deepStrictEqual({ counts, bytes: snapshot.histograms['pc.queue.control.bytes']?.max, socket: snapshot.histograms['pc.socket.bufferedBytes']?.max }, {
			counts: {
				'pc.queue.control.bytes': 1,
				'pc.queue.control.totalMs': 1,
				'pc.queue.control.waitMs': 1,
				'pc.queue.sealMs': 3,
				'pc.queue.unsentBytesAtEnqueue': 2,
				'pc.queue.voice.bytes': 1,
				'pc.queue.voice.totalMs': 1,
				'pc.queue.voice.waitMs': 1,
				'pc.socket.bufferedBytes': 3,
			},
			bytes: 20,
			socket: 100,
		});
	});
});
