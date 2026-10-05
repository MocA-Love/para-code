/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPushRequest, PARADIS_PUSH_OUTBOX_LIMIT, PARADIS_PUSH_OUTBOX_MAX_AGE_MS, PARADIS_PUSH_OUTBOX_RESEND_AFTER_MS, ParadisPushOutbox, paradisParsePushOutbox } from '../../common/paradisPushOutbox.js';

interface IHarness {
	readonly outbox: ParadisPushOutbox;
	readonly sent: string[];
	readonly files: string[];
	readonly timers: (() => void)[];
	open: boolean;
	now: number;
	deviceId: string | undefined;
}

function harness(initialFile?: string): IHarness {
	let counter = 0;
	const state = {
		sent: [] as string[],
		files: [] as string[],
		timers: [] as (() => void)[],
		open: true,
		now: 1_000_000,
		deviceId: 'device-1' as string | undefined,
	};
	const outbox = new ParadisPushOutbox({
		read: async () => initialFile,
		write: async content => { state.files.push(content); },
		deviceId: () => state.deviceId,
		send: request => {
			if (!state.open) {
				return false;
			}
			state.sent.push(`${request.requestId}:${request.payload}`);
			return true;
		},
		newRequestId: () => `request-${++counter}`,
		warn: () => undefined,
		now: () => state.now,
		setTimeout: handler => { state.timers.push(handler); return state.timers.length; },
		clearTimeout: () => undefined,
	});
	return Object.assign(state, { outbox });
}

const PUSH: IParadisPushRequest = { mobileId: 'mobile-1', payload: 'sealed', collapseId: 'collapse-1' };

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

suite('ParadisPushOutbox', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('writes a request to disk before sending it, and keeps it until the relay acknowledges', async () => {
		const h = harness();
		await h.outbox.submit(PUSH);
		await settle();
		const writtenBeforeSend = paradisParsePushOutbox(h.files[0]).entries.map(entry => `${entry.requestId}:${entry.sends}`);
		const pendingAfterSend = h.outbox.pending.map(entry => `${entry.requestId}:${entry.sends}`);
		await h.outbox.ack('request-1');
		h.outbox.dispose();

		assert.deepStrictEqual({ writtenBeforeSend, sent: h.sent, pendingAfterSend, pendingAfterAck: h.outbox.pending.length, relayAcks: paradisParsePushOutbox(h.files.at(-1)).relayAcks }, {
			writtenBeforeSend: ['request-1:0'],
			sent: ['request-1:sealed'],
			pendingAfterSend: ['request-1:1'],
			pendingAfterAck: 0,
			relayAcks: true,
		});
	});

	test('sends a request queued while the relay socket was closed once it opens', async () => {
		const h = harness();
		h.open = false;
		await h.outbox.submit(PUSH);
		await settle();
		const whileClosed = [...h.sent];
		h.open = true;
		h.outbox.flush();
		await settle();
		h.outbox.dispose();

		assert.deepStrictEqual({ whileClosed, afterOpen: h.sent }, { whileClosed: [], afterOpen: ['request-1:sealed'] });
	});

	test('resends an unacknowledged request with the same id only to a relay known to acknowledge', async () => {
		const legacy = harness();
		await legacy.outbox.submit(PUSH);
		legacy.now += PARADIS_PUSH_OUTBOX_RESEND_AFTER_MS;
		legacy.outbox.flush();
		await settle();
		legacy.outbox.dispose();

		const acking = harness(JSON.stringify({ relayAcks: true, entries: [] }));
		await acking.outbox.submit(PUSH);
		acking.now += PARADIS_PUSH_OUTBOX_RESEND_AFTER_MS;
		acking.outbox.flush();
		await settle();
		acking.outbox.dispose();

		assert.deepStrictEqual({ legacy: legacy.sent, acking: acking.sent }, {
			legacy: ['request-1:sealed'],
			acking: ['request-1:sealed', 'request-1:sealed'],
		});
	});

	test('drops requests older than ten minutes or addressed to a previous registration, and keeps at most 50', async () => {
		const h = harness();
		h.open = false;
		for (let i = 0; i < PARADIS_PUSH_OUTBOX_LIMIT + 2; i++) {
			await h.outbox.submit({ ...PUSH, payload: `p${i}` });
		}
		await settle();
		const capped = h.outbox.pending.length;
		h.now += PARADIS_PUSH_OUTBOX_MAX_AGE_MS;
		await h.outbox.submit({ ...PUSH, payload: 'fresh' });
		await settle();
		const afterExpiry = h.outbox.pending.map(entry => entry.payload);
		h.deviceId = 'device-2';
		h.outbox.flush();
		await settle();
		h.outbox.dispose();

		assert.deepStrictEqual({ capped, afterExpiry, afterReregister: h.outbox.pending.length }, { capped: PARADIS_PUSH_OUTBOX_LIMIT, afterExpiry: ['fresh'], afterReregister: 0 });
	});

	test('reads back a saved outbox and ignores malformed entries', () => {
		const parsed = paradisParsePushOutbox(JSON.stringify({
			relayAcks: true,
			entries: [
				{ requestId: 'request-ok', deviceId: 'd', mobileId: 'm', payload: 'x', since: 1, sends: 2, lastSentAt: 3 },
				{ requestId: 'bad id!', deviceId: 'd', mobileId: 'm', payload: 'x', since: 1 },
				{ requestId: 'request-2', deviceId: 'd', mobileId: 'm', since: 1 },
			],
		}));
		assert.deepStrictEqual(parsed, {
			relayAcks: true,
			entries: [{ requestId: 'request-ok', deviceId: 'd', mobileId: 'm', payload: 'x', since: 1, sends: 2, lastSentAt: 3 }],
		});
	});
});
