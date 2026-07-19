/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_TERMINAL_BINARY_DATA_ENCODING, paradisEncodeBinaryTerminalData, paradisEncodeNegotiatedBinaryTerminalData } from '../../common/paradisMobileTerminalData.js';

const metadata = {
	terminalKey: 'terminal-42',
	epoch: 7,
	seq: 9,
} as const;

suite('ParadisMobileTerminalData', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('encodes terminal metadata and UTF-8 text as reversible binary v1', () => {
		const snapshotMetadata = { ...metadata, snapshot: true as const, cols: 120, rows: 40, unicode: '11' };
		const data = ('\x1b[38;5;45m日本語🙂\x1b[0m\r\n').repeat(1000);
		const payload = paradisEncodeBinaryTerminalData(snapshotMetadata, data);
		assert.ok(payload !== undefined);
		assert.deepStrictEqual([...payload.subarray(0, 6)], [0x50, 0x54, 0x44, 0x01, 0, 0]);
		const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		const metadataLength = view.getUint16(6, false);
		const dataLength = view.getUint32(8, false);
		const decodedMetadata = JSON.parse(new TextDecoder().decode(payload.subarray(12, 12 + metadataLength)));
		const decodedData = new TextDecoder().decode(payload.subarray(12 + metadataLength));
		assert.deepStrictEqual(decodedMetadata, snapshotMetadata);
		assert.strictEqual(dataLength, new TextEncoder().encode(data).length);
		assert.strictEqual(decodedData, data);
		const legacy = new TextEncoder().encode(JSON.stringify({ t: 'data', data, ...snapshotMetadata }));
		assert.ok(payload.byteLength < legacy.byteLength * 0.72);
	});

	test('encodes only an exact explicit negotiation and falls back for unsafe input', () => {
		assert.strictEqual(PARADIS_TERMINAL_BINARY_DATA_ENCODING, 'terminal-binary-v1');
		assert.strictEqual(paradisEncodeNegotiatedBinaryTerminalData(undefined, metadata, 'x'), undefined);
		assert.strictEqual(paradisEncodeNegotiatedBinaryTerminalData('terminal-binary-v2', metadata, 'x'), undefined);
		assert.ok(paradisEncodeNegotiatedBinaryTerminalData(PARADIS_TERMINAL_BINARY_DATA_ENCODING, metadata, 'x') !== undefined);
		assert.strictEqual(paradisEncodeBinaryTerminalData({ ...metadata, terminalKey: '' }, 'x'), undefined);
		assert.strictEqual(paradisEncodeBinaryTerminalData({ ...metadata, epoch: 1.5 }, 'x'), undefined);
		assert.strictEqual(paradisEncodeBinaryTerminalData({ ...metadata, unicode: '\ud800' }, 'x'), undefined);
		assert.strictEqual(paradisEncodeBinaryTerminalData(metadata, '\ud800'), undefined);
	});
});
