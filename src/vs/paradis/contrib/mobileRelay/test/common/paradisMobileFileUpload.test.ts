/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_FS_BINARY_UPLOAD_ENCODING, paradisDecodeBinaryFsUpload } from '../../common/paradisMobileFileUpload.js';

function binaryUpload(metadata: object, data: Uint8Array): Uint8Array {
	const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
	const payload = new Uint8Array(12 + metadataBytes.length + data.length);
	payload.set([0x50, 0x46, 0x55, 0x01, 0, 0], 0);
	const view = new DataView(payload.buffer);
	view.setUint16(6, metadataBytes.length, false);
	view.setUint32(8, data.length, false);
	payload.set(metadataBytes, 12);
	payload.set(data, 12 + metadataBytes.length);
	return payload;
}

suite('ParadisMobileFileUpload', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('decodes routing metadata and preserves every raw file byte', () => {
		const metadata = { t: 'upload', id: 'request-42', protocolVersion: 3, desktopEpoch: 'desktop-epoch', windowId: 7, ws: 'repo:main', name: 'photo.jpg', base64Length: 8 };
		const data = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
		assert.strictEqual(PARADIS_FS_BINARY_UPLOAD_ENCODING, 'fs-binary-v1');
		assert.deepStrictEqual(paradisDecodeBinaryFsUpload(binaryUpload(metadata, data)), { ...metadata, data });
	});

	test('rejects JSON, malformed lengths, invalid routing metadata, and unknown versions', () => {
		const metadata = { t: 'upload', id: 'request-42', protocolVersion: 3, desktopEpoch: 'desktop-epoch', windowId: 7, ws: 'repo:main', name: 'photo.jpg', base64Length: 4 };
		const valid = binaryUpload(metadata, new Uint8Array([1, 2, 3]));
		assert.strictEqual(paradisDecodeBinaryFsUpload(new TextEncoder().encode('{}')), undefined);
		assert.strictEqual(paradisDecodeBinaryFsUpload(valid.subarray(0, valid.length - 1)), undefined);
		assert.strictEqual(paradisDecodeBinaryFsUpload(binaryUpload({ ...metadata, protocolVersion: 2 }, new Uint8Array())), undefined);
		assert.strictEqual(paradisDecodeBinaryFsUpload(binaryUpload({ ...metadata, id: '' }, new Uint8Array())), undefined);
		assert.strictEqual(paradisDecodeBinaryFsUpload(binaryUpload({ ...metadata, windowId: 1.5 }, new Uint8Array())), undefined);
		assert.strictEqual(paradisDecodeBinaryFsUpload(binaryUpload({ ...metadata, base64Length: 1 }, new Uint8Array([1, 2, 3]))), undefined);
		const unknownVersion = valid.slice();
		unknownVersion[3] = 2;
		assert.strictEqual(paradisDecodeBinaryFsUpload(unknownVersion), undefined);
	});
});
