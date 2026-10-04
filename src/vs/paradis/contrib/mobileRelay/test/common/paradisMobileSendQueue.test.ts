/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobileSendTransfer, ParadisMobileSendPriority, ParadisMobileSendQueue, paradisMobileSendPriorityOf } from '../../common/paradisMobileSendQueue.js';

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
			{ priority: ParadisMobileSendPriority.Voice },
			{ priority: ParadisMobileSendPriority.Screen, replaceKey: 'screencast' },
			{ priority: ParadisMobileSendPriority.Screen, replaceKey: 'screencast' },
			{ priority: ParadisMobileSendPriority.Control },
			{ priority: ParadisMobileSendPriority.Control },
		]);
	});
});
