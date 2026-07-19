/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_FS_BINARY_RESPONSE_ENCODING, paradisEncodeBinaryFsResponse, paradisEncodeNegotiatedBinaryFsResponse } from '../../common/paradisMobileFileResponse.js';

suite('ParadisMobileFileResponse', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('encodes negotiated file responses as reversible binary v1 for every supported kind', () => {
		const data = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
		for (const [type, kind] of [['pdf', 1], ['docx', 2], ['media', 3]] as const) {
			const payload = paradisEncodeBinaryFsResponse(type, 'request-42', 123456, data);
			assert.ok(payload !== undefined);
			assert.deepStrictEqual([...payload.subarray(0, 6)], [0x50, 0x46, 0x42, 0x01, kind, 0]);
			const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
			assert.strictEqual(view.getUint16(6, false), 10);
			assert.strictEqual(view.getUint32(8, false), 123456);
			assert.strictEqual(new TextDecoder().decode(payload.subarray(12, 22)), 'request-42');
			assert.deepStrictEqual([...payload.subarray(22)], [...data]);
			const legacy = new TextEncoder().encode(JSON.stringify({ id: 'request-42', t: type, data: 'AAF/gP7/', size: 123456 }));
			assert.ok(payload.byteLength < legacy.byteLength);
		}
	});

	test('falls back when binary response metadata cannot be represented safely', () => {
		assert.strictEqual(paradisEncodeBinaryFsResponse('pdf', '', 0, new Uint8Array()), undefined);
		assert.strictEqual(paradisEncodeBinaryFsResponse('pdf', 'x'.repeat(0x10000), 0, new Uint8Array()), undefined);
		assert.strictEqual(paradisEncodeBinaryFsResponse('pdf', 'r-1', -1, new Uint8Array()), undefined);
		assert.strictEqual(paradisEncodeBinaryFsResponse('pdf', 'r-1', 0x1_0000_0000, new Uint8Array()), undefined);
	});

	test('encodes only when the mobile explicitly negotiates the exact wire version', () => {
		const data = new Uint8Array([0xff]);
		assert.strictEqual(paradisEncodeNegotiatedBinaryFsResponse(undefined, 'pdf', 'r-1', 1, data), undefined);
		assert.strictEqual(paradisEncodeNegotiatedBinaryFsResponse('fs-binary-v2', 'pdf', 'r-1', 1, data), undefined);
		assert.ok(paradisEncodeNegotiatedBinaryFsResponse(PARADIS_FS_BINARY_RESPONSE_ENCODING, 'pdf', 'r-1', 1, data) !== undefined);
	});
});
