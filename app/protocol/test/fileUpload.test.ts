// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { FS_BINARY_UPLOAD_ENCODING, decodeBinaryFsUpload, encodeBinaryFsUpload, isBinaryFsUpload } from '../src/fileUpload.js';

const metadata = {
	id: 'request-42',
	protocolVersion: 3 as const,
	desktopEpoch: 'desktop-epoch',
	windowId: 7,
	ws: 'repo:main',
	name: 'photo.jpg',
};

describe('binary fs upload', () => {
	test.each([
		['', []],
		['AA==', [0x00]],
		['AAE=', [0x00, 0x01]],
		['AAF/gP7/', [0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]],
	] as const)('round-trips standard base64 %s without changing file bytes', (base64, expected) => {
		const payload = encodeBinaryFsUpload(metadata, base64);
		expect(payload).toBeDefined();
		expect(FS_BINARY_UPLOAD_ENCODING).toBe('fs-binary-v1');
		expect(isBinaryFsUpload(payload!)).toBe(true);
		expect(decodeBinaryFsUpload(payload!)).toEqual({ ...metadata, t: 'upload', base64Length: base64.length, data: new Uint8Array(expected) });
	});

	test('is smaller than legacy JSON while preserving routing metadata', () => {
		const data = new Uint8Array(1024 * 1024).fill(0xab);
		const base64 = Buffer.from(data).toString('base64');
		const payload = encodeBinaryFsUpload(metadata, base64)!;
		const legacy = new TextEncoder().encode(JSON.stringify({ ...metadata, t: 'upload', data: base64 }));

		expect(decodeBinaryFsUpload(payload)?.data).toEqual(data);
		expect(payload.byteLength).toBeLessThan(legacy.byteLength * 0.76);
	});

	test('returns undefined for data or metadata that cannot be encoded safely', () => {
		expect(encodeBinaryFsUpload(metadata, 'not base64!')).toBeUndefined();
		expect(encodeBinaryFsUpload({ ...metadata, id: '' }, 'AA==')).toBeUndefined();
		expect(encodeBinaryFsUpload({ ...metadata, windowId: 1.5 }, 'AA==')).toBeUndefined();
		expect(encodeBinaryFsUpload({ ...metadata, name: 'x'.repeat(0x10000) }, 'AA==')).toBeUndefined();
	});

	test('rejects unrelated, truncated, length-mismatched, and unknown-version payloads', () => {
		const payload = encodeBinaryFsUpload(metadata, 'AAF/gP7/')!;
		expect(decodeBinaryFsUpload(new TextEncoder().encode('{}'))).toBeUndefined();
		expect(decodeBinaryFsUpload(payload.subarray(0, payload.length - 1))).toBeUndefined();

		const wrongLength = payload.slice();
		new DataView(wrongLength.buffer).setUint32(8, 100, false);
		expect(decodeBinaryFsUpload(wrongLength)).toBeUndefined();
		const dishonestMetadata = binaryUploadForTest({ ...metadata, t: 'upload', base64Length: 1 }, new Uint8Array([1, 2, 3]));
		expect(decodeBinaryFsUpload(dishonestMetadata)).toBeUndefined();

		const unknownVersion = payload.slice();
		unknownVersion[3] = 2;
		expect(isBinaryFsUpload(unknownVersion)).toBe(false);
		expect(decodeBinaryFsUpload(unknownVersion)).toBeUndefined();
	});
});

function binaryUploadForTest(metadataValue: object, data: Uint8Array): Uint8Array {
	const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataValue));
	const payload = new Uint8Array(12 + metadataBytes.length + data.length);
	payload.set([0x50, 0x46, 0x55, 0x01, 0, 0], 0);
	const view = new DataView(payload.buffer);
	view.setUint16(6, metadataBytes.length, false);
	view.setUint32(8, data.length, false);
	payload.set(metadataBytes, 12);
	payload.set(data, 12 + metadataBytes.length);
	return payload;
}
