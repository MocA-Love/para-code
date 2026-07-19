/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_JSON_GZIP_RESPONSE_ENCODING, paradisEncodeGzipJsonResponse, paradisEncodeJsonResponsePayload, paradisEncodeNegotiatedGzipJsonResponse, paradisShouldCompressJsonResponse } from '../../common/paradisMobileGzipJson.js';

async function gunzip(payload: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([payload.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

suite('ParadisMobileGzipJson', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('encodes negotiated repetitive JSON as reversible gzip v1', async () => {
		const json = new TextEncoder().encode(JSON.stringify({ id: 'request-1', t: 'xlsx', html: '<table><tr><td>日本語🙂</td></tr></table>'.repeat(2_000) }));
		const payload = await paradisEncodeNegotiatedGzipJsonResponse(PARADIS_JSON_GZIP_RESPONSE_ENCODING, json);
		assert.ok(payload !== undefined);
		assert.deepStrictEqual([...payload.subarray(0, 8)], [0x50, 0x43, 0x4a, 0x01, 1, 0, 0, 0]);
		assert.strictEqual(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(8, false), json.length);
		assert.ok(payload.length <= json.length - 128);
		assert.deepStrictEqual(await gunzip(payload.subarray(12)), json);
	});

	test('requires exact negotiation and avoids small or oversized inputs', async () => {
		const compressible = new TextEncoder().encode('x'.repeat(2_000));
		assert.strictEqual(PARADIS_JSON_GZIP_RESPONSE_ENCODING, 'json-gzip-v1');
		assert.strictEqual(await paradisEncodeNegotiatedGzipJsonResponse(undefined, compressible), undefined);
		assert.strictEqual(await paradisEncodeNegotiatedGzipJsonResponse('json-gzip-v2', compressible), undefined);
		assert.strictEqual(await paradisEncodeGzipJsonResponse(new Uint8Array(1_023)), undefined);
		assert.strictEqual(await paradisEncodeGzipJsonResponse(new Uint8Array(32 * 1024 * 1024 + 1)), undefined);
	});

	test('falls back when CompressionStream fails', async () => {
		const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream');
		Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: class { constructor() { throw new Error('unavailable'); } } });
		try {
			assert.strictEqual(await paradisEncodeGzipJsonResponse(new TextEncoder().encode('x'.repeat(2_000))), undefined);
		} finally {
			if (originalDescriptor) {
				Object.defineProperty(globalThis, 'CompressionStream', originalDescriptor);
			} else {
				delete (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
			}
		}
	});

	test('selects only the four negotiated heavy response types', () => {
		assert.strictEqual(paradisShouldCompressJsonResponse('scm', 'diff'), true);
		assert.strictEqual(paradisShouldCompressJsonResponse('scm', 'xlsxDiff'), true);
		assert.strictEqual(paradisShouldCompressJsonResponse('fs', 'read'), true);
		assert.strictEqual(paradisShouldCompressJsonResponse('fs', 'xlsx'), true);
		assert.strictEqual(paradisShouldCompressJsonResponse('scm', 'status'), false);
		assert.strictEqual(paradisShouldCompressJsonResponse('fs', 'pdf'), false);
		assert.strictEqual(paradisShouldCompressJsonResponse('agent', 'snapshot'), false);
	});

	test('returns compressed bytes only for a selected exact negotiation and otherwise preserves JSON bytes', async () => {
		const json = new TextEncoder().encode(JSON.stringify({ id: 'request-1', t: 'diff', diff: '+line\n'.repeat(1_000) }));
		const selected = await paradisEncodeJsonResponsePayload('scm', 'diff', PARADIS_JSON_GZIP_RESPONSE_ENCODING, json);
		assert.deepStrictEqual([...selected.subarray(0, 4)], [0x50, 0x43, 0x4a, 0x01]);
		assert.deepStrictEqual(await gunzip(selected.subarray(12)), json);
		assert.strictEqual(await paradisEncodeJsonResponsePayload('scm', 'status', PARADIS_JSON_GZIP_RESPONSE_ENCODING, json), json);
		assert.strictEqual(await paradisEncodeJsonResponsePayload('scm', 'diff', undefined, json), json);
	});
});
