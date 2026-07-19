// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { FS_BINARY_RESPONSE_ENCODING, decodeBinaryFsResponse, isBinaryFsResponse } from '../src/fileResponse.js';

function binaryResponse(kind: number, id: string, size: number, data: Uint8Array): Uint8Array {
	const idBytes = new TextEncoder().encode(id);
	const payload = new Uint8Array(12 + idBytes.length + data.length);
	payload.set([0x50, 0x46, 0x42, 0x01, kind, 0], 0);
	const view = new DataView(payload.buffer);
	view.setUint16(6, idBytes.length, false);
	view.setUint32(8, size, false);
	payload.set(idBytes, 12);
	payload.set(data, 12 + idBytes.length);
	return payload;
}

describe('binary fs response', () => {
	test.each([
		[1, 'pdf'],
		[2, 'docx'],
		[3, 'media'],
	] as const)('decodes kind %i as %s and preserves every file byte', (kind, type) => {
		const data = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
		const payload = binaryResponse(kind, 'request-42', 123456, data);

		expect(FS_BINARY_RESPONSE_ENCODING).toBe('fs-binary-v1');
		expect(isBinaryFsResponse(payload)).toBe(true);
		expect(decodeBinaryFsResponse(payload)).toEqual({
			id: 'request-42',
			t: type,
			size: 123456,
			data,
		});
	});

	test('accepts an empty file while rejecting unrelated and malformed payloads', () => {
		const empty = binaryResponse(1, 'r-0', 0, new Uint8Array());
		expect(decodeBinaryFsResponse(empty)).toEqual({ id: 'r-0', t: 'pdf', size: 0, data: new Uint8Array() });

		const json = new TextEncoder().encode('{"id":"r-0","t":"pdf","data":""}');
		expect(isBinaryFsResponse(json)).toBe(false);
		expect(decodeBinaryFsResponse(json)).toBeUndefined();
		expect(decodeBinaryFsResponse(new Uint8Array([0x50, 0x46, 0x42, 0x01]))).toBeUndefined();

		const unknownVersion = binaryResponse(1, 'r-0', 0, new Uint8Array());
		unknownVersion[3] = 2;
		expect(decodeBinaryFsResponse(unknownVersion)).toBeUndefined();

		const unknownKind = binaryResponse(4, 'r-0', 0, new Uint8Array());
		expect(decodeBinaryFsResponse(unknownKind)).toBeUndefined();

		const nonzeroReserved = binaryResponse(1, 'r-0', 0, new Uint8Array());
		nonzeroReserved[5] = 1;
		expect(decodeBinaryFsResponse(nonzeroReserved)).toBeUndefined();

		const emptyId = binaryResponse(1, '', 0, new Uint8Array());
		expect(decodeBinaryFsResponse(emptyId)).toBeUndefined();

		const truncatedId = binaryResponse(1, 'r-0', 0, new Uint8Array());
		new DataView(truncatedId.buffer).setUint16(6, 100, false);
		expect(decodeBinaryFsResponse(truncatedId)).toBeUndefined();
	});
});
