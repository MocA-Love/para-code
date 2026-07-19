// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { TERMINAL_BINARY_DATA_ENCODING, decodeBinaryTerminalData, encodeBinaryTerminalData, isBinaryTerminalData } from '../src/terminalData.js';

const metadata = {
	terminalKey: 'terminal-42',
	epoch: 7,
	seq: 9,
} as const;

describe('binary terminal data', () => {
	test.each([
		['empty', ''],
		['plain ASCII', 'build completed'],
		['newlines and slashes', 'one\\two\r\nthree\n'],
		['ANSI controls', '\x1b[38;5;45mhello\x1b[0m\r\n'],
		['Unicode', '日本語🙂é'],
	])('round-trips %s terminal text without changing the string', (_name, data) => {
		const payload = encodeBinaryTerminalData(metadata, data);
		expect(payload).toBeDefined();
		expect(TERMINAL_BINARY_DATA_ENCODING).toBe('terminal-binary-v1');
		expect(isBinaryTerminalData(payload!)).toBe(true);
		expect(decodeBinaryTerminalData(payload!)).toEqual({ ...metadata, t: 'data', data });
	});

	test('preserves snapshot dimensions and removes JSON control-character expansion', () => {
		const snapshotMetadata = { ...metadata, snapshot: true as const, cols: 120, rows: 40, unicode: '11' };
		const data = ('\x1b[38;5;45mhello\x1b[0m\r\n').repeat(1000);
		const payload = encodeBinaryTerminalData(snapshotMetadata, data)!;
		const legacy = new TextEncoder().encode(JSON.stringify({ t: 'data', data, ...snapshotMetadata }));

		expect(decodeBinaryTerminalData(payload)).toEqual({ ...snapshotMetadata, t: 'data', data });
		expect(payload.byteLength).toBeLessThan(legacy.byteLength * 0.7);
	});

	test('falls back when metadata or UTF-16 text cannot be represented reversibly', () => {
		expect(encodeBinaryTerminalData({ ...metadata, terminalKey: '' }, 'x')).toBeUndefined();
		expect(encodeBinaryTerminalData({ ...metadata, epoch: 1.5 }, 'x')).toBeUndefined();
		expect(encodeBinaryTerminalData({ ...metadata, seq: -1 }, 'x')).toBeUndefined();
		expect(encodeBinaryTerminalData({ ...metadata, cols: 0 }, 'x')).toBeUndefined();
		expect(encodeBinaryTerminalData({ ...metadata, unicode: '\ud800' }, 'x')).toBeUndefined();
		expect(encodeBinaryTerminalData(metadata, '\ud800')).toBeUndefined();
	});

	test('rejects unrelated, truncated, length-mismatched, and unknown payloads', () => {
		const payload = encodeBinaryTerminalData(metadata, 'hello')!;
		expect(decodeBinaryTerminalData(new TextEncoder().encode('{}'))).toBeUndefined();
		expect(decodeBinaryTerminalData(payload.subarray(0, payload.length - 1))).toBeUndefined();

		const wrongDataLength = payload.slice();
		new DataView(wrongDataLength.buffer).setUint32(8, 100, false);
		expect(decodeBinaryTerminalData(wrongDataLength)).toBeUndefined();

		const unknownVersion = payload.slice();
		unknownVersion[3] = 2;
		expect(isBinaryTerminalData(unknownVersion)).toBe(false);
		expect(decodeBinaryTerminalData(unknownVersion)).toBeUndefined();

		const nonzeroReserved = payload.slice();
		nonzeroReserved[4] = 1;
		expect(decodeBinaryTerminalData(nonzeroReserved)).toBeUndefined();

		const invalidMetadata = binaryTerminalDataForTest({ ...metadata, epoch: '7' }, 'hello');
		expect(decodeBinaryTerminalData(invalidMetadata)).toBeUndefined();
	});
});

function binaryTerminalDataForTest(metadataValue: object, data: string): Uint8Array {
	const encoder = new TextEncoder();
	const metadataBytes = encoder.encode(JSON.stringify(metadataValue));
	const dataBytes = encoder.encode(data);
	const payload = new Uint8Array(12 + metadataBytes.length + dataBytes.length);
	payload.set([0x50, 0x54, 0x44, 0x01, 0, 0], 0);
	const view = new DataView(payload.buffer);
	view.setUint16(6, metadataBytes.length, false);
	view.setUint32(8, dataBytes.length, false);
	payload.set(metadataBytes, 12);
	payload.set(dataBytes, 12 + metadataBytes.length);
	return payload;
}
