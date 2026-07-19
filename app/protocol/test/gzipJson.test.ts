// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { JSON_GZIP_RESPONSE_ENCODING, decodeGzipJsonResponse, isGzipJsonResponse } from '../src/gzipJson.js';

const encoder = new TextEncoder();

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const writerInput = new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(writerInput).arrayBuffer());
}

async function responsePayload(json: Uint8Array): Promise<Uint8Array> {
	const compressed = await gzip(json);
	const payload = new Uint8Array(12 + compressed.length);
	payload.set([0x50, 0x43, 0x4a, 0x01, 0x01, 0, 0, 0], 0);
	new DataView(payload.buffer).setUint32(8, json.length, false);
	payload.set(compressed, 12);
	return payload;
}

describe('gzip JSON response', () => {
	test.each([
		['ASCII', JSON.stringify({ id: '1', t: 'read', content: 'hello\nworld' })],
		['Unicode', JSON.stringify({ id: '2', t: 'diff', diff: '日本語🙂\r\n+追加' })],
		['HTML', JSON.stringify({ id: '3', t: 'xlsx', html: '<table><tr><td>値</td></tr></table>'.repeat(100) })],
	])('restores the exact %s JSON bytes', async (_name, text) => {
		const json = encoder.encode(text);
		const payload = await responsePayload(json);

		expect(JSON_GZIP_RESPONSE_ENCODING).toBe('json-gzip-v1');
		expect(isGzipJsonResponse(payload)).toBe(true);
		expect(decodeGzipJsonResponse(payload)).toEqual(json);
	});

	test('rejects unrelated, truncated, unknown, reserved, length-mismatched, and invalid payloads', async () => {
		const valid = await responsePayload(encoder.encode('{"id":"request-1","t":"read","content":"hello"}'));
		expect(decodeGzipJsonResponse(encoder.encode('{}'))).toBeUndefined();
		expect(decodeGzipJsonResponse(valid.subarray(0, 11))).toBeUndefined();

		const unknownVersion = valid.slice();
		unknownVersion[3] = 2;
		expect(isGzipJsonResponse(unknownVersion)).toBe(false);
		expect(decodeGzipJsonResponse(unknownVersion)).toBeUndefined();

		const unknownAlgorithm = valid.slice();
		unknownAlgorithm[4] = 2;
		expect(decodeGzipJsonResponse(unknownAlgorithm)).toBeUndefined();

		const nonzeroReserved = valid.slice();
		nonzeroReserved[5] = 1;
		expect(decodeGzipJsonResponse(nonzeroReserved)).toBeUndefined();

		const zeroLength = valid.slice();
		new DataView(zeroLength.buffer).setUint32(8, 0, false);
		expect(decodeGzipJsonResponse(zeroLength)).toBeUndefined();

		const oversized = valid.slice();
		new DataView(oversized.buffer).setUint32(8, 32 * 1024 * 1024 + 1, false);
		expect(decodeGzipJsonResponse(oversized)).toBeUndefined();

		const wrongLength = valid.slice();
		new DataView(wrongLength.buffer).setUint32(8, 1, false);
		expect(decodeGzipJsonResponse(wrongLength)).toBeUndefined();

		const invalidGzip = valid.slice();
		invalidGzip.fill(0, 12);
		expect(decodeGzipJsonResponse(invalidGzip)).toBeUndefined();
	});
});
