/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_CONTENT_HASH_ENCODING, paradisContentHashResponse } from '../../common/paradisMobileContentHash.js';
import { PARADIS_JSON_GZIP_RESPONSE_ENCODING, paradisEncodeJsonResponsePayload } from '../../common/paradisMobileGzipJson.js';

suite('ParadisMobileContentHash', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves the exact legacy response without negotiation', async () => {
		const body = { t: 'read', content: '日本語🙂', truncated: false, size: 13 };
		const response = await paradisContentHashResponse(undefined, undefined, body);
		assert.strictEqual(response, body);
		assert.strictEqual((response as { readonly contentHash?: string }).contentHash, undefined);
	});

	test('adds a deterministic SHA-256 hash and returns a minimal match response', async () => {
		const body = { t: 'xlsx', html: '<table>日本🙂</table>', sheets: ['Sheet1'], sheet: 0 };
		const full = await paradisContentHashResponse(PARADIS_CONTENT_HASH_ENCODING, undefined, body) as typeof body & { readonly contentHash: string };
		assert.match(full.contentHash, /^[a-f0-9]{64}$/);
		assert.deepStrictEqual(await paradisContentHashResponse(PARADIS_CONTENT_HASH_ENCODING, full.contentHash, body), {
			t: 'xlsx', notModified: true, contentHash: full.contentHash,
		});
		assert.strictEqual((await paradisContentHashResponse(PARADIS_CONTENT_HASH_ENCODING, full.contentHash, { ...body, html: '<table>changed</table>' }) as { readonly notModified?: boolean }).notModified, undefined);
	});

	test('never accepts malformed or non-exact negotiation values', async () => {
		const body = { t: 'read', content: 'same', truncated: false, size: 4 };
		const unknown = await paradisContentHashResponse('content-hash-v2', 'a'.repeat(64), body);
		assert.strictEqual(unknown, body);
		const malformed = await paradisContentHashResponse(PARADIS_CONTENT_HASH_ENCODING, 'A'.repeat(64), body);
		assert.strictEqual((malformed as { readonly notModified?: boolean }).notModified, undefined);
		assert.match((malformed as { readonly contentHash: string }).contentHash, /^[a-f0-9]{64}$/);
	});

	test('reduces a repeated large xlsx response even against the negotiated gzip baseline', async () => {
		const rows: string[] = [];
		for (let index = 0; index < 20_000; index++) {
			rows.push(`<tr><td>${index}</td><td>cell-${Math.imul(index, 2_246_822_519).toString(16)}</td></tr>`);
		}
		const body = { t: 'xlsx', html: `<table>${rows.join('')}</table>`, sheets: ['Sheet1', 'Summary'], sheet: 0 };
		const full = await paradisContentHashResponse(PARADIS_CONTENT_HASH_ENCODING, undefined, body) as typeof body & { readonly contentHash: string };
		const matched = await paradisContentHashResponse(PARADIS_CONTENT_HASH_ENCODING, full.contentHash, body);
		const fullWire = await paradisEncodeJsonResponsePayload('fs', 'xlsx', PARADIS_JSON_GZIP_RESPONSE_ENCODING, new TextEncoder().encode(JSON.stringify({ id: 'request-1', ...full })));
		const matchedWire = await paradisEncodeJsonResponsePayload('fs', 'xlsx', PARADIS_JSON_GZIP_RESPONSE_ENCODING, new TextEncoder().encode(JSON.stringify({ id: 'request-2', ...matched })));
		assert.ok(matchedWire.byteLength < fullWire.byteLength * 0.01, `expected matched=${matchedWire.byteLength} to be under 1% of gzip full=${fullWire.byteLength}`);
	});
});
