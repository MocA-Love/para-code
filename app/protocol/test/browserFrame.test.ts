// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { BROWSER_JPEG_BINARY_ENCODING, decodeBinaryBrowserJpegFrame, isBinaryBrowserJpegFrame } from '../src/browserFrame.js';

describe('binary browser JPEG frame', () => {
	test('decodes the versioned header and preserves every JPEG byte', () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0xd9]);
		const payload = new Uint8Array(12 + jpeg.length);
		payload.set([0x50, 0x4a, 0x46, 0x01], 0);
		const view = new DataView(payload.buffer);
		view.setUint32(4, 1200, false);
		view.setUint32(8, 800, false);
		payload.set(jpeg, 12);

		expect(BROWSER_JPEG_BINARY_ENCODING).toBe('jpeg-binary-v1');
		expect(isBinaryBrowserJpegFrame(payload)).toBe(true);
		expect(decodeBinaryBrowserJpegFrame(payload)).toEqual({
			data: '/9gAAX+A/v/Z',
			w: 1200,
			h: 800,
		});
	});

	test('rejects legacy JSON, truncated headers, unknown versions, and empty JPEGs', () => {
		const json = new TextEncoder().encode('{"t":"frame","data":"AAAA","w":1,"h":1}');
		expect(isBinaryBrowserJpegFrame(json)).toBe(false);
		expect(decodeBinaryBrowserJpegFrame(json)).toBeUndefined();
		expect(decodeBinaryBrowserJpegFrame(new Uint8Array([0x50, 0x4a, 0x46, 0x01]))).toBeUndefined();

		const unknown = new Uint8Array(13);
		unknown.set([0x50, 0x4a, 0x46, 0x02], 0);
		expect(decodeBinaryBrowserJpegFrame(unknown)).toBeUndefined();

		const empty = new Uint8Array(12);
		empty.set([0x50, 0x4a, 0x46, 0x01], 0);
		expect(decodeBinaryBrowserJpegFrame(empty)).toBeUndefined();
	});

	test('restores standard Base64 padding for every byte-length remainder', () => {
		const oneByte = new Uint8Array(13);
		oneByte.set([0x50, 0x4a, 0x46, 0x01], 0);
		oneByte[12] = 0xff;
		expect(decodeBinaryBrowserJpegFrame(oneByte)?.data).toBe('/w==');

		const twoBytes = new Uint8Array(14);
		twoBytes.set([0x50, 0x4a, 0x46, 0x01], 0);
		twoBytes.set([0xff, 0xd8], 12);
		expect(decodeBinaryBrowserJpegFrame(twoBytes)?.data).toBe('/9g=');
	});
});
