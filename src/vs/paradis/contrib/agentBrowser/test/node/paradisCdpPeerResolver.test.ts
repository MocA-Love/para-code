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
	paradisClassifyPeer,
	paradisParseLsofPeerPids,
	paradisParseNetstatPeerPids,
	paradisParseSsPeerPids,
	paradisResolvePaneTokenForPeerPort,
} from '../../node/paradisCdpPeerResolver.js';

const SERVER_PORT = 47286;
const OWN_PID = 100;

function probe(peerPids: readonly number[], table: Record<number, IParadisProcessInfo>): IParadisPeerProcessProbe {
	return {
		findPeerPids: async () => peerPids,
		readProcess: async pid => table[pid],
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

	test('classifies the peer by its ancestors, and refuses when the processes holding the connection disagree', async () => {
		const table: Record<number, IParadisProcessInfo> = {
			// shell 50 -> claude 60 -> curl 70; the shared process is 100 -> ssh 110; an unrelated process 80 -> 1
			50: { ppid: 40 }, 60: { ppid: 50 }, 70: { ppid: 60 }, 110: { ppid: OWN_PID }, 80: { ppid: 1 },
		};
		assert.deepStrictEqual([
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, 50, probe([70], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, 50, probe([70, 60], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, 50, probe([70, 80], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, 50, probe([110], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, 50, probe([80], table)),
			await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, 50, probe([], table)),
		], ['descendant', 'descendant', 'unknown', 'ownChild', 'unknown', 'unknown']);
	});

	test('a parent that started after its child is a reused PID, not an ancestor', async () => {
		const table: Record<number, IParadisProcessInfo> = {
			70: { ppid: 50, startTime: 1_000 },
			// PID 50 now belongs to a process started after 70: the original parent is gone
			50: { ppid: 40, startTime: 2_000 },
		};
		assert.strictEqual(await paradisClassifyPeer(49768, SERVER_PORT, OWN_PID, 50, probe([70], table)), 'unknown');
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
});
