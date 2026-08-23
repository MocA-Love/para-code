/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsRiskyPortAddress } from '../../common/paradisPortList.js';
import { loadConnectionTable, loadListeningConnections, parseHexAddress } from '../../node/paradisPortListChannelServer.js';

suite('ParadisPortList (remote) - parseHexAddress', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('decodes an IPv4 address (little-endian 8-hex-digit form)', () => {
		assert.strictEqual(parseHexAddress('0100007F'), '127.0.0.1');
	});

	test('decodes an all-zero IPv4 address', () => {
		assert.strictEqual(parseHexAddress('00000000'), '0.0.0.0');
	});

	test('decodes IPv6 loopback (::1) into its expanded form', () => {
		// /proc/net/tcp6 represents ::1 as this 32-hex-digit string (per-word little-endian);
		// see the reference linked from the upstream extHostTunnelService.ts implementation.
		assert.strictEqual(parseHexAddress('00000000000000000000000001000000'), '0:0:0:0:0:0:0:1');
	});

	test('decodes the IPv6 unspecified address (::) into its expanded all-zero form', () => {
		assert.strictEqual(parseHexAddress('00000000000000000000000000000000'), '0:0:0:0:0:0:0:0');
		// paradisIsRiskyPortAddress must recognize this exact expanded form, since it never
		// comes back as the compressed '::' notation from this parser.
		assert.strictEqual(paradisIsRiskyPortAddress('0:0:0:0:0:0:0:0'), true);
	});
});

suite('ParadisPortList (remote) - loadConnectionTable', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

	test('parses a /proc/net/tcp-style table into named fields', () => {
		const stdout = [
			HEADER,
			'   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0',
		].join('\n');
		const rows = loadConnectionTable(stdout);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].local_address, '0100007F:1F90');
		assert.strictEqual(rows[0].st, '0A');
		assert.strictEqual(rows[0].inode, '12345');
	});

	test('returns an empty array for empty input', () => {
		assert.deepStrictEqual(loadConnectionTable(''), []);
	});
});

suite('ParadisPortList (remote) - loadListeningConnections', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
	const LISTEN_ROW = '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0';
	const ESTABLISHED_ROW = '   1: 00000000:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000000000000000 100 0 0 10 0';

	test('keeps only LISTEN (st=0A) rows and decodes address/port/inode', () => {
		const tcp = [HEADER, LISTEN_ROW, ESTABLISHED_ROW].join('\n');
		assert.deepStrictEqual(loadListeningConnections(tcp), [
			{ socket: 12345, ip: '127.0.0.1', port: 8080 },
		]);
	});

	test('merges multiple stdouts (e.g. tcp and tcp6) and dedupes identical ip:port pairs', () => {
		const tcp = [HEADER, LISTEN_ROW].join('\n');
		assert.deepStrictEqual(loadListeningConnections(tcp, tcp), [
			{ socket: 12345, ip: '127.0.0.1', port: 8080 },
		]);
	});

	test('returns an empty array when given empty input for every stream', () => {
		assert.deepStrictEqual(loadListeningConnections('', ''), []);
	});
});
