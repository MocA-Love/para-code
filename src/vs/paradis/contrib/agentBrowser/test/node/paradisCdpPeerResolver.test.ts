/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisPeerProcessProbe,
	IParadisProcessInfo,
	ParadisPeerProbeError,
	paradisClassifyPeer,
	paradisParseProcessTable,
	paradisPeerIsOneOf,
	paradisParseLsofPeerPids,
	paradisParseNetstatPeerPids,
	paradisParseSsPeerPids,
	paradisParseWindowsPeerSnapshot,
	paradisResolvePaneTokenForPeerPort,
} from '../../node/paradisCdpPeerResolver.js';

const SERVER_PORT = 47286;
const OWN_PID = 100;

function probe(peerPids: readonly number[], table: Record<number, IParadisProcessInfo>): IParadisPeerProcessProbe {
	return {
		findPeerPids: async () => peerPids,
		readProcess: async pid => table[pid],
		// never read a real process environment in tests
		readTokenFromEnv: async () => undefined,
	};
}

suite('paradisCdpPeerResolver', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lsof: only the exact IPv4 client -> server tuple counts, not an IPv6 connection with the same port', () => {
		// The victim (lower PID, listed first) has [::1]:49768; the attacker bound 127.0.0.1:49768 to reach this server.
		const stdout = [
			'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
			'node      201 user   23u  IPv6 0x1111111111111111      0t0  TCP [::1]:49768->[::1]:49767 (ESTABLISHED)',
			'node      202 user   24u  IPv4 0x2222222222222222      0t0  TCP 127.0.0.1:49768->127.0.0.1:5173 (ESTABLISHED)',
			'attacker  303 user   25u  IPv4 0x3333333333333333      0t0  TCP 127.0.0.1:49768->127.0.0.1:47286 (ESTABLISHED)',
			'Para      100 user   26u  IPv4 0x4444444444444444      0t0  TCP 127.0.0.1:47286->127.0.0.1:49768 (ESTABLISHED)',
		].join('\n');
		assert.deepStrictEqual(paradisParseLsofPeerPids(stdout, 49768, SERVER_PORT, OWN_PID), [303]);
	});

	test('ss and netstat: the same tuple rule', () => {
		const ss = [
			'0      0      [::1]:49768          [::1]:49767     users:(("node",pid=201,fd=23))',
			'0      0      127.0.0.1:49768      127.0.0.1:47286 users:(("curl",pid=303,fd=5),("sh",pid=304,fd=5))',
			'0      0      127.0.0.1:47286      127.0.0.1:49768 users:(("para",pid=100,fd=9))',
		].join('\n');
		const netstat = [
			'  TCP    [::1]:49768            [::1]:49767            ESTABLISHED     201',
			'  TCP    127.0.0.1:49768        127.0.0.1:47286        ESTABLISHED     303',
			'  TCP    127.0.0.1:49768        127.0.0.1:9222         ESTABLISHED     404',
			'  TCP    127.0.0.1:47286        127.0.0.1:49768        ESTABLISHED     100',
		].join('\r\n');
		assert.deepStrictEqual([
			paradisParseSsPeerPids(ss, 49768, SERVER_PORT, OWN_PID),
			paradisParseNetstatPeerPids(netstat, 49768, SERVER_PORT, OWN_PID),
		], [[303, 304], [303]]);
	});

	test('classifies a local pane by its shell ancestry and an SSH pane only by the exact tunnel process', async () => {
		const table: Record<number, IParadisProcessInfo> = {
			// shell 50 -> claude 60 -> curl 70; the tunnel ssh is 110 (child of the shared process 100);
			// git 120 (also a child of the shared process) runs a repository hook 130; an unrelated process 80 -> 1
			50: { ppid: 40 }, 60: { ppid: 50 }, 70: { ppid: 60 }, 110: { ppid: OWN_PID }, 120: { ppid: OWN_PID }, 130: { ppid: 120 }, 80: { ppid: 1 },
		};
		const local = { ancestorPid: 50 };
		const remote = { tunnelPid: 110 };
		assert.deepStrictEqual([
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, local, probe([70], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, local, probe([70, 60], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, local, probe([70, 80], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, local, probe([110], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, remote, probe([110], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, remote, probe([130], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, remote, probe([70], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, local, probe([], table)),
		], ['descendant', 'descendant', 'unknown', 'unknown', 'tunnel', 'unknown', 'unknown', 'unknown']);
	});

	test('Windows: one snapshot carries the connection owners and the process table', () => {
		const snapshot = paradisParseWindowsPeerSnapshot(['C 303', 'P 303 60 638600000000000000', 'P 60 50 638500000000000000', 'P 4 0 0', 'noise'].join('\r\n'));
		assert.deepStrictEqual({ peers: snapshot.peerPids, processes: [...snapshot.processes] }, {
			peers: [303],
			processes: [[303, { ppid: 60, startTime: 638600000000000000 }], [60, { ppid: 50, startTime: 638500000000000000 }], [4, { ppid: undefined }]],
		});
	});

	test('a parent that started after its child is a reused PID, not an ancestor', async () => {
		const table: Record<number, IParadisProcessInfo> = {
			70: { ppid: 50, startTime: 1_000 },
			// PID 50 now belongs to a process started after 70: the original parent is gone
			50: { ppid: 40, startTime: 2_000 },
		};
		assert.strictEqual(await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, { ancestorPid: 50 }, probe([70], table)), 'unknown');
	});

	test('the CDP gateway resolves a token only when every process holding the connection agrees', async () => {
		const table: Record<number, IParadisProcessInfo> = { 70: { ppid: 50 }, 90: { ppid: 55 } };
		const shells: Record<number, string> = { 50: 'token-a', 55: 'token-b' };
		const lookup = { getTokenForShellPid: (pid: number) => shells[pid] };
		assert.deepStrictEqual([
			await paradisResolvePaneTokenForPeerPort(49768, OWN_PID, lookup, SERVER_PORT, probe([70], table)),
			await paradisResolvePaneTokenForPeerPort(49768, OWN_PID, lookup, SERVER_PORT, probe([70, 90], table)),
			await paradisResolvePaneTokenForPeerPort(49768, OWN_PID, lookup, undefined, probe([70], table)),
		], ['token-a', undefined, undefined]);
	});
	test('a failed or timed-out probe is retried with a longer wait, but a peer that is not a descendant is not', async () => {
		const table: Record<number, IParadisProcessInfo> = { 70: { ppid: 60 }, 60: { ppid: 50 }, 80: { ppid: 1 } };
		const options = (log: string[]) => ({
			now: () => 0,
			sleep: async () => { log.push('sleep'); },
			probeFor: (attempt: number, timeoutMs: number): IParadisPeerProcessProbe => {
				log.push(`probe ${attempt} ${timeoutMs}`);
				return {
					findPeerPids: async () => {
						if (attempt === 0) {
							throw new ParadisPeerProbeError('lsof timed out');
						}
						return log[0] === 'negative' ? [80] : [70];
					},
					readProcess: async pid => table[pid],
					readTokenFromEnv: async () => undefined,
				};
			},
		});
		const retried: string[] = [];
		const negative: string[] = ['negative'];
		const failing: string[] = [];
		assert.deepStrictEqual({
			retried: [await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, { ancestorPid: 50 }, undefined, options(retried)), retried],
			negative: [await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, { ancestorPid: 50 }, undefined, options(negative)), negative],
			gaveUp: [await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, { ancestorPid: 50 }, {
				findPeerPids: async () => { failing.push('lsof'); throw new ParadisPeerProbeError('lsof timed out'); },
				readProcess: async pid => table[pid],
				readTokenFromEnv: async () => undefined,
			}, { now: () => 0, sleep: async () => { } }), failing.length],
		}, {
			retried: ['descendant', ['probe 0 3000', 'sleep', 'probe 1 8000']],
			negative: ['unknown', ['negative', 'probe 0 3000', 'sleep', 'probe 1 8000']],
			gaveUp: ['unknown', 3],
		});
	});

	test('a connection whose owner is not found yet is looked up again, within the time budget', async () => {
		let calls = 0;
		const table: Record<number, IParadisProcessInfo> = { 70: { ppid: 50 } };
		let clock = 0;
		const late: IParadisPeerProcessProbe = { findPeerPids: async () => ++calls < 2 ? [] : [70], readProcess: async pid => table[pid], readTokenFromEnv: async () => undefined };
		const noTime: IParadisPeerProcessProbe = { findPeerPids: async () => { clock += 20_000; return []; }, readProcess: async pid => table[pid], readTokenFromEnv: async () => undefined };
		assert.deepStrictEqual([
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, { ancestorPid: 50 }, late, { now: () => 0, sleep: async () => { } }),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, { ancestorPid: 50 }, noTime, { now: () => clock, sleep: async () => { } }),
		], ['descendant', 'unknown']);
	});

	test('the process table of ps -A is read once, and a failed lookup of the tunnel peer is undefined', async () => {
		const failing: IParadisPeerProcessProbe = { findPeerPids: async () => { throw new ParadisPeerProbeError('lsof failed'); }, readProcess: async () => undefined, readTokenFromEnv: async () => undefined };
		assert.deepStrictEqual({
			table: [...paradisParseProcessTable('    1     0\n  501     1\n 7020   501\n\n garbage\n').entries()],
			tunnel: await paradisPeerIsOneOf(49768, SERVER_PORT, OWN_PID, [90], failing),
		}, {
			table: [[1, { ppid: undefined }], [501, { ppid: 1 }], [7020, { ppid: 501 }]],
			tunnel: undefined,
		});
	});

});
