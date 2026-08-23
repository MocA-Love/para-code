/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPortEntry, paradisIsRiskyPortAddress } from '../../common/paradisPortList.js';
import { ParadisPortListServerService, loadConnectionTable, loadListeningConnections, loadSocketOwners, parseHexAddress, registerParadisPortListForServer, resolveRemotePortEntries } from '../../node/paradisPortListChannelServer.js';

const batchEntries: readonly IParadisPortEntry[] = [
	{ port: 3000, proto: 'TCP', pid: 10, processName: 'node', address: '127.0.0.1', risky: false },
	{ port: 3001, proto: 'TCP', pid: process.pid, processName: 'remote-server', address: '127.0.0.1', risky: false },
	{ port: 3002, proto: 'TCP', pid: process.ppid, processName: 'remote-parent', address: '127.0.0.1', risky: false },
];

interface ICapturedChannel {
	call<T>(context: undefined, command: string, arg?: unknown): Promise<T>;
}

suite('ParadisPortList (remote) - batch kill', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('collects once and protects the remote server and parent when killing all', async () => {
		let collections = 0;
		const signalled: number[] = [];
		const service = new ParadisPortListServerService(
			{} as never,
			async () => { collections++; return batchEntries; },
			pid => { signalled.push(pid); },
		);

		const result = await service.killAll(batchEntries);
		assert.strictEqual(collections, 1);
		assert.deepStrictEqual(signalled, [10]);
		assert.deepStrictEqual(result, { failed: 2 });
	});

	test('forwards a killAll IPC array to the registered remote channel', async () => {
		let captured: ICapturedChannel | undefined;
		const service = new ParadisPortListServerService({} as never, async () => batchEntries, () => { });
		const server = {
			registerChannel: (_name: string, channel: ICapturedChannel) => captured = channel,
		};
		registerParadisPortListForServer(server as never, {} as never, service);

		const result = await captured!.call<{ readonly failed: number }>(undefined, 'killAll', [[batchEntries[0]]]);
		assert.deepStrictEqual(result, { failed: 0 });
	});
});

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

	test('merges multiple stdouts (e.g. tcp and tcp6) and dedupes identical socket inodes', () => {
		const tcp = [HEADER, LISTEN_ROW].join('\n');
		assert.deepStrictEqual(loadListeningConnections(tcp, tcp), [
			{ socket: 12345, ip: '127.0.0.1', port: 8080 },
		]);
	});

	test('retains distinct socket inodes listening on the same endpoint', () => {
		const first = '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0';
		const second = '   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 67890 1 0000000000000000 100 0 0 10 0';
		assert.deepStrictEqual(loadListeningConnections([HEADER, first, second].join('\n')), [
			{ socket: 12345, ip: '127.0.0.1', port: 8080 },
			{ socket: 67890, ip: '127.0.0.1', port: 8080 },
		]);
	});

	test('returns an empty array when given empty input for every stream', () => {
		assert.deepStrictEqual(loadListeningConnections('', ''), []);
	});
});

suite('ParadisPortList (remote) - socket owners', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('retains every PID that owns the same socket inode', () => {
		const owners = loadSocketOwners([
			'lrwx------ 1 user user 64 Aug 24 00:00 /proc/444/fd/6 -> socket:[67890]',
			'lrwx------ 1 user user 64 Aug 24 00:00 /proc/222/fd/4 -> socket:[12345]',
			'lrwx------ 1 user user 64 Aug 24 00:00 /proc/111/fd/3 -> socket:[12345]',
			'lrwx------ 1 user user 64 Aug 24 00:00 /proc/111/fd/5 -> socket:[12345]',
		].join('\n'));
		assert.deepStrictEqual([...owners].map(([socket, pids]) => [socket, [...pids]]), [
			[12345, [111, 222]],
			[67890, [444]],
		]);
		assert.deepStrictEqual(resolveRemotePortEntries(
			[{ socket: 12345, ip: '0.0.0.0', port: 8080 }],
			owners,
			new Map([[111, 'worker-a'], [222, 'worker-b']]),
		), [
			{ port: 8080, proto: 'TCP', pid: 111, processName: 'worker-a', address: '0.0.0.0', risky: true },
			{ port: 8080, proto: 'TCP', pid: 222, processName: 'worker-b', address: '0.0.0.0', risky: true },
		]);
	});

	test('preserves the parsed IPv6 address and TCP protocol in resolved entries', () => {
		assert.deepStrictEqual(resolveRemotePortEntries(
			[{ socket: 45678, ip: '0:0:0:0:0:0:0:1', port: 3000 }],
			new Map([[45678, new Set([333])]]),
			new Map([[333, 'node']]),
		), [
			{ port: 3000, proto: 'TCP', pid: 333, processName: 'node', address: '0:0:0:0:0:0:0:1', risky: false },
		]);
	});
});
