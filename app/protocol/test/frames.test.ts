// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { Channels, decodeFrame, encodeFrame } from '../src/frames.js';

describe('frame codec', () => {
	test('roundtrip with workspace and binary payload', () => {
		const payload = new Uint8Array([0, 1, 2, 255, 254]);
		const bytes = encodeFrame({ ch: Channels.Terminal, ws: 'para-code', seq: 42, payload });
		const frame = decodeFrame(bytes);
		expect(frame.ch).toBe('term');
		expect(frame.ws).toBe('para-code');
		expect(frame.seq).toBe(42);
		expect(Array.from(frame.payload)).toEqual([0, 1, 2, 255, 254]);
	});

	test('roundtrip without workspace', () => {
		const bytes = encodeFrame({ ch: Channels.Notify, seq: 0, payload: new Uint8Array(0) });
		const frame = decodeFrame(bytes);
		expect(frame.ws).toBeUndefined();
		expect(frame.payload.length).toBe(0);
	});

	test('rejects unknown channel and malformed input', () => {
		expect(() => decodeFrame(encodeFrame({ ch: 'bogus' as never, seq: 1, payload: new Uint8Array(0) }))).toThrow(/channel/);
		expect(() => decodeFrame(new Uint8Array([0xc0]))).toThrow(); // msgpack nil
	});
});
