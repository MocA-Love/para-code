// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { decodeNotify, decodeNotifyControl, encodeNotify, encodeNotifyDismiss, encodeNotifyDismissed, type NotifyPayload } from '../src/notify.js';

describe('notify codec', () => {
	test('roundtrips a full payload', () => {
		const payload: NotifyPayload = { kind: 'agent-question', id: 'n1', title: 'claude — para-code', body: '確認を求めています', ws: 'repo:1', terminalId: 2, at: 1783000000000 };
		const decoded = decodeNotify(encodeNotify(payload));
		expect(decoded).toEqual(payload);
	});

	test('roundtrips without optional fields', () => {
		const payload: NotifyPayload = { kind: 'disconnected', id: 'n2', title: 'PC', body: 'オフラインになりました', at: 1783000000001 };
		const decoded = decodeNotify(encodeNotify(payload));
		expect(decoded.ws).toBeUndefined();
		expect(decoded.terminalId).toBeUndefined();
		expect(decoded.kind).toBe('disconnected');
	});

	test('rejects malformed / unknown kind', () => {
		expect(() => decodeNotify(new TextEncoder().encode('{"kind":"bogus","id":"x","title":"a","body":"b","at":1}'))).toThrow();
		expect(() => decodeNotify(new TextEncoder().encode('not json'))).toThrow();
	});
});

describe('notify control messages (dismiss sync)', () => {
	test('roundtrips a dismiss message', () => {
		expect(decodeNotifyControl(encodeNotifyDismiss('n1'))).toEqual({ t: 'dismiss', id: 'n1' });
	});

	test('roundtrips a dismissed message', () => {
		expect(decodeNotifyControl(encodeNotifyDismissed('n1'))).toEqual({ t: 'dismissed', id: 'n1' });
	});

	test('does not mistake a NotifyPayload for a control message', () => {
		const payload: NotifyPayload = { kind: 'agent-question', id: 'n1', title: 't', body: 'b', at: 1 };
		expect(decodeNotifyControl(encodeNotify(payload))).toBeUndefined();
	});

	test('returns undefined for malformed / unrelated JSON', () => {
		expect(decodeNotifyControl(new TextEncoder().encode('not json'))).toBeUndefined();
		expect(decodeNotifyControl(new TextEncoder().encode('{"t":"prefs","agentDone":true}'))).toBeUndefined();
	});
});
