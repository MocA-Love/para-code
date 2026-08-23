/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPortEntry } from '../../common/paradisPortList.js';
import { ParadisPortListService, parseLsofOutput, parseNetstatOutput, registerParadisPortList } from '../../node/paradisPortListChannel.js';

const batchEntries: readonly IParadisPortEntry[] = [
	{ port: 3000, proto: 'TCP', pid: 10, processName: 'node', address: '127.0.0.1', risky: false },
	{ port: 3001, proto: 'TCP', pid: process.pid, processName: 'shared-process', address: '127.0.0.1', risky: false },
];

interface ICapturedChannel {
	call<T>(context: undefined, command: string, arg?: unknown): Promise<T>;
}

suite('ParadisPortList - batch kill', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('collects once and protects the shared process when killing all', async () => {
		let collections = 0;
		const signalled: number[] = [];
		const service = new ParadisPortListService(
			{} as never,
			async () => { collections++; return batchEntries; },
			pid => { signalled.push(pid); },
		);

		const result = await service.killAll([batchEntries[0], batchEntries[1]]);
		assert.strictEqual(collections, 1);
		assert.deepStrictEqual(signalled, [10]);
		assert.deepStrictEqual(result, { failed: 1 });
	});

	test('forwards a killAll IPC array to the registered channel', async () => {
		let captured: ICapturedChannel | undefined;
		const service = new ParadisPortListService({} as never, async () => batchEntries, () => { });
		const server = {
			registerChannel: (_name: string, channel: ICapturedChannel) => captured = channel,
		};
		registerParadisPortList(server as never, {} as never, service);

		const result = await captured!.call<{ readonly failed: number }>(undefined, 'killAll', [[batchEntries[0]]]);
		assert.deepStrictEqual(result, { failed: 0 });
	});
});

suite('ParadisPortList - parseLsofOutput', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a plain LISTEN line', () => {
		const stdout = [
			'COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
			'node      82913 magu   20u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:5173 (LISTEN)',
		].join('\n');
		assert.deepStrictEqual(parseLsofOutput(stdout), [
			{ port: 5173, proto: 'TCP', pid: 82913, processName: 'node', address: '127.0.0.1', risky: false },
		]);
	});

	test('strips brackets from an IPv6 address and does not misparse the embedded colons as the port separator', () => {
		const stdout = 'node      82913 magu   20u  IPv6 0x1234567890abcdef      0t0  TCP [::1]:8080 (LISTEN)';
		assert.deepStrictEqual(parseLsofOutput(stdout), [
			{ port: 8080, proto: 'TCP', pid: 82913, processName: 'node', address: '::1', risky: false },
		]);
	});

	test('marks a wildcard/0.0.0.0 bind as risky', () => {
		const stdout = [
			'node      1 magu   1u  IPv4 0x1 0t0 TCP *:3000 (LISTEN)',
			'node      2 magu   1u  IPv4 0x2 0t0 TCP 0.0.0.0:3001 (LISTEN)',
		].join('\n');
		const entries = parseLsofOutput(stdout);
		assert.strictEqual(entries.length, 2);
		assert.ok(entries.every(entry => entry.risky));
	});

	test('skips a wildcard port (":*")', () => {
		const stdout = 'sshd      1 root   1u  IPv4 0x1 0t0 TCP *:* (LISTEN)';
		assert.deepStrictEqual(parseLsofOutput(stdout), []);
	});

	test('ignores the header row and blank lines', () => {
		const stdout = [
			'COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
			'',
			'   ',
		].join('\n');
		assert.deepStrictEqual(parseLsofOutput(stdout), []);
	});

	test('drops a listen line whose PID cannot be a real target (pid<=0)', () => {
		// lsof normally never emits PID 0, but this guards the parser itself against ever
		// producing an entry that kill() would otherwise treat as safe to act on.
		const stdout = 'kernel_task 0 root   1u  IPv4 0x1 0t0 TCP 127.0.0.1:9000 (LISTEN)';
		assert.deepStrictEqual(parseLsofOutput(stdout), []);
	});

	test('deduplicates identical proto/port/pid rows (e.g. IPv4 and IPv6 dual-stack entries reported twice)', () => {
		const stdout = [
			'node      1 magu   1u  IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)',
			'node      1 magu   2u  IPv4 0x2 0t0 TCP 127.0.0.1:3000 (LISTEN)',
		].join('\n');
		assert.strictEqual(parseLsofOutput(stdout).length, 1);
	});
});

suite('ParadisPortList - parseNetstatOutput', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a LISTENING row and extracts the PID', () => {
		const stdout = [
			'Proto  Local Address          Foreign Address        State           PID',
			'TCP    127.0.0.1:5354         0.0.0.0:0              LISTENING       1234',
		].join('\n');
		assert.deepStrictEqual(parseNetstatOutput(stdout), [
			{ pid: 1234, port: 5354, address: '127.0.0.1' },
		]);
	});

	test('ignores non-LISTENING rows (e.g. ESTABLISHED)', () => {
		const stdout = 'TCP    10.0.0.5:51000         93.184.216.34:443      ESTABLISHED     4321';
		assert.deepStrictEqual(parseNetstatOutput(stdout), []);
	});

	// Regression test for the CRITICAL finding: netstat can report LISTENING rows owned by
	// PID 0 (unassigned) or PID 4 (System on Windows). process.kill(0, sig) signals this
	// process's entire process group, so these must never reach the kill() validation as
	// a plausible target.
	test('drops LISTENING rows owned by PID 0 or PID 4 (System)', () => {
		const stdout = [
			'TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       4',
			'TCP    [::]:135               [::]:0                 LISTENING       0',
		].join('\n');
		assert.deepStrictEqual(parseNetstatOutput(stdout), []);
	});

	test('ignores the header row', () => {
		const stdout = 'Proto  Local Address          Foreign Address        State           PID';
		assert.deepStrictEqual(parseNetstatOutput(stdout), []);
	});
});
