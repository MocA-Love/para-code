/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_JSON_GZIP_RESPONSE_ENCODING, paradisEncodeGzipJsonResponse, paradisEncodeJsonResponsePayload, paradisEncodeNegotiatedGzipJsonResponse, paradisIsGzipWorthwhile, paradisShouldCompressJsonResponse } from '../../common/paradisMobileGzipJson.js';

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

	test('judges whether gzip saves enough to be worth decompressing on the phone', () => {
		assert.deepStrictEqual([
			paradisIsGzipWorthwhile(10_000, 8_000),
			paradisIsGzipWorthwhile(10_000, 8_001),
			paradisIsGzipWorthwhile(10_000, 2_000),
			paradisIsGzipWorthwhile(1_000, 800),
			paradisIsGzipWorthwhile(500, 380),
			paradisIsGzipWorthwhile(21_185_805, 15_206_755),
		], [true, false, true, true, false, true]);
	});

	test('sends incompressible content as plain JSON', async () => {
		// `"` と `\` を除く印字可能な ASCII 92 種を xorshift32 で一様に並べる。1 文字あたり約 6.5 ビットの
		// 情報なので、gzip しても 8 割強にしか縮まない。
		const alphabet: number[] = [];
		for (let code = 0x21; code < 0x7f; code++) {
			if (code !== 0x22 && code !== 0x5c) {
				alphabet.push(code);
			}
		}
		let seed = 1;
		let noise = '';
		for (let i = 0; i < 20_000; i++) {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			noise += String.fromCharCode(alphabet[(seed >>> 0) % alphabet.length]);
		}
		const json = new TextEncoder().encode(JSON.stringify({ id: 'request-1', t: 'read', content: noise }));
		assert.strictEqual(await paradisEncodeGzipJsonResponse(json), undefined);
		assert.strictEqual(await paradisEncodeJsonResponsePayload('fs', 'read', PARADIS_JSON_GZIP_RESPONSE_ENCODING, json), json);
	});

	test('still compresses binary read as text, whose JSON is full of U+FFFD and escapes', async () => {
		let seed = 7;
		let binary = '';
		for (let i = 0; i < 20_000; i++) {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			binary += String.fromCharCode((seed >>> 0) % 256);
		}
		// fileService の toString() と同じく、バイナリを UTF-8 として読んだ文字列にする。
		const text = new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
		const json = new TextEncoder().encode(JSON.stringify({ id: 'request-1', t: 'read', content: text }));
		const compressed = await paradisEncodeJsonResponsePayload('fs', 'read', PARADIS_JSON_GZIP_RESPONSE_ENCODING, json);
		assert.deepStrictEqual([...compressed.subarray(0, 4)], [0x50, 0x43, 0x4a, 0x01]);
		assert.deepStrictEqual(await gunzip(compressed.subarray(12)), json);
	});

});
