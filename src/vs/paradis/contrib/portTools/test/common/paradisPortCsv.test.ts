/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TunnelProtocol } from '../../../../../platform/tunnel/common/tunnel.js';
import { Tunnel, TunnelSource } from '../../../../../workbench/services/remote/common/tunnelModel.js';
import { PARADIS_PORT_CSV_COLUMNS, paradisParseCsv, paradisPortCsvExportRows, paradisPortCsvLocalPortsToCheck, paradisPortCsvPlan, paradisPortCsvRead, paradisPortCsvSerialize } from '../../common/paradisPortCsv.js';
import { paradisDefaultCleanUpForwards, paradisIsLoopbackLocalAddress, paradisMismatchedForwards, paradisNotListeningUserForwards, paradisPortLocalHostAllowed } from '../../common/paradisPortSelection.js';

function tunnel(remotePort: number, localPort: number, options: { readonly source?: TunnelSource; readonly listening?: boolean; readonly name?: string; readonly host?: string } = {}): Tunnel {
	return {
		remoteHost: options.host ?? 'localhost',
		remotePort,
		localAddress: `localhost:${localPort}`,
		localUri: URI.parse(`http://localhost:${localPort}`),
		protocol: TunnelProtocol.Http,
		localPort,
		name: options.name,
		closeable: true,
		privacy: 'private',
		runningProcess: options.listening ? 'node "server.js", --port=1' : undefined,
		hasRunningProcess: options.listening === true,
		pid: undefined,
		source: { source: options.source ?? TunnelSource.User, description: 'User Forwarded' },
	};
}

suite('ParadisPortCsv', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('writes a BOM, CRLF and quotes, and reads its own output back', () => {
		const text = paradisPortCsvSerialize(PARADIS_PORT_CSV_COLUMNS, paradisPortCsvExportRows([tunnel(21004, 65459), tunnel(21002, 21002, { listening: true, name: 'vite, dev' })], true));
		assert.ok(text.startsWith('\uFEFFremote_host,remote_port,local_port,label,protocol,source,local_address,listening,process\r\n'));
		assert.deepStrictEqual(paradisParseCsv(text).slice(1).map(row => row.cells), [
			['localhost', '21002', '21002', 'vite, dev', 'http', 'user', 'localhost:21002', 'true', 'node "server.js", --port=1'],
			['localhost', '21004', '65459', '', 'http', 'user', 'localhost:65459', 'false', ''],
		]);
		const read = paradisPortCsvRead(text);
		assert.deepStrictEqual(read.ok && read.rows.map(row => row.kind === 'entry' ? [row.line, row.remotePort, row.localPort, row.label] : row.error), [[2, 21002, 21002, 'vite, dev'], [3, 21004, 65459, undefined]]);
	});

	test('numbers rows by the line they start on, across quoted newlines and blank lines', () => {
		assert.deepStrictEqual(paradisParseCsv('a,b\r\n"x\ny",1\r\n\r\nz,2').map(row => [row.line, row.cells]), [[1, ['a', 'b']], [2, ['x\ny', '1']], [5, ['z', '2']]]);
	});

	test('keeps spreadsheet formulas from running, and reads the label back unchanged', () => {
		const text = paradisPortCsvSerialize(['remote_port', 'label'], [['21004', '=HYPERLINK("x")'], ['21005', '-dev']]);
		assert.strictEqual(text, '\uFEFFremote_port,label\r\n21004,"\'=HYPERLINK(""x"")"\r\n21005,\'-dev\r\n');
		const read = paradisPortCsvRead(text);
		assert.deepStrictEqual(read.ok && read.rows.map(row => row.kind === 'entry' ? row.label : row.error), ['=HYPERLINK("x")', '-dev']);
	});

	test('opens forwards only on 127.0.0.1', () => {
		assert.deepStrictEqual({
			hosts: [undefined, '', 'localhost', 'allInterfaces'].map(paradisPortLocalHostAllowed),
			addresses: ['127.0.0.1:21004', 'localhost:65459', '[::1]:3000', 'http://127.0.0.1:8080/', '0.0.0.0:21004', '192.168.1.5:21004'].map(paradisIsLoopbackLocalAddress),
		}, { hosts: [true, true, true, false], addresses: [true, true, true, true, false, false] });
	});

	test('checks each row and judges it against the current forwards', () => {
		const csv = [
			'remote_port,local_port,remote_host,protocol',
			'21002,21002,,',
			'21004,21004,,',
			'21040,,localhost,https',
			'21041,21041,127.0.0.1,',
			'abc,,,',
			'21040,21140,,',
			'21050,21050,10.0.0.5,',
			'21051,21040,,',
			'',
			'21052,0,,',
		].join('\n');
		const read = paradisPortCsvRead(csv);
		assert.ok(read.ok);
		const forwarded = [tunnel(21002, 21002), tunnel(21004, 65459)];
		assert.deepStrictEqual(paradisPortCsvLocalPortsToCheck(read.rows, forwarded), [21004, 21040, 21041, 21140]);
		const plan = paradisPortCsvPlan(read.rows, forwarded, new Set([21041]));
		assert.deepStrictEqual(plan.map(item => [item.row.line, item.verdict]), [
			[2, { kind: 'done' }],
			[3, { kind: 'mismatch', currentLocalPort: 65459, localInUse: false }],
			[4, { kind: 'add' }],
			[5, { kind: 'localInUse' }],
			[6, { kind: 'error', error: 'remotePortInvalid' }],
			[7, { kind: 'duplicate', firstLine: 4 }],
			[8, { kind: 'error', error: 'remoteHostNotLocal' }],
			[9, { kind: 'localInUse' }],
			[11, { kind: 'error', error: 'localPortInvalid' }],
		]);
		assert.deepStrictEqual([paradisPortCsvRead('label\nx').ok, paradisPortCsvRead('').ok], [false, false]);
	});

	test('selects the same forwards for the dialog and for the MCP clean-up', () => {
		const forwarded = [
			tunnel(21004, 65459),
			tunnel(33355, 33355),
			tunnel(32767, 32767),
			tunnel(40000, 40000, { listening: true }),
			tunnel(45000, 45000, { source: TunnelSource.Auto }),
			tunnel(50000, 50001, { source: TunnelSource.Extension }),
			tunnel(51000, 51000, { host: '10.0.0.5' }),
		];
		assert.deepStrictEqual({
			notListening: paradisNotListeningUserForwards(forwarded).map(item => item.remotePort),
			defaults: paradisDefaultCleanUpForwards(forwarded).map(item => item.remotePort),
			mismatched: paradisMismatchedForwards(forwarded).map(item => item.remotePort),
		}, {
			notListening: [21004, 33355, 32767],
			defaults: [33355],
			mismatched: [21004],
		});
	});
});
