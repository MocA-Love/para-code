/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobileSendTransfer, PARADIS_MOBILE_FALLBACK_PACE_BYTES_PER_SECOND, PARADIS_MOBILE_SCREEN_MAX_WAIT_MS, PARADIS_MOBILE_STUCK_BUFFER_MS, ParadisMobileSendPriority, ParadisMobileSendQueue, paradisMobileSendPriorityOf } from '../../common/paradisMobileSendQueue.js';

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
			// 1 本まるごとの voice-clip は数 MB になりうるので音声の列を塞がない
			{ priority: ParadisMobileSendPriority.Control },
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
});
