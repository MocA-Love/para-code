/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisReturnTunnelLedgerHost, ParadisReturnTunnelLedger, paradisIsReturnTunnelCommand, paradisParseReturnTunnelLedger } from '../../node/paradisReturnTunnelLedger.js';
import { paradisWaitForUnsyncedPane } from '../../node/paradisUnsyncedPaneWait.js';

const TUNNEL = '/usr/bin/ssh -N -R 25163:127.0.0.1:47286 -o ControlPath=none -o BatchMode=yes -o ExitOnForwardFailure=yes -o LogLevel=DEBUG1 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 devbox';

suite('ParadisReturnTunnelLedger', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function fakeHost(commands: { [pid: number]: string }, stored: string | undefined) {
		const killed: number[] = [];
		const written: string[] = [];
		const host: IParadisReturnTunnelLedgerHost = {
			commandOf: async pid => commands[pid],
			kill: pid => { killed.push(pid); },
			readFile: async () => stored,
			writeFile: async (_file, content) => { written.push(content); },
		};
		return { host, killed, written };
	}

	test('stops only the recorded processes that still look like a return tunnel', async () => {
		// 4101: 残った戻りトンネル。4102: 番号が使い回された別のプロセス。4103: もう居ない。4104: 控えに無い別の Para Code のトンネル
		const fake = fakeHost({ 4101: TUNNEL, 4102: '/usr/bin/ssh devbox', 4104: TUNNEL }, JSON.stringify({ pids: [4101, 4102, 4103] }));
		const ledger = new ParadisReturnTunnelLedger('/x/ledger.json', { info: () => { }, warn: () => { } }, fake.host, 'linux');

		await ledger.whenReaped();

		assert.deepStrictEqual(fake.killed, [4101]);
	});

	test('records the tunnels it started and forgets the ones that ended', async () => {
		const fake = fakeHost({}, undefined);
		const ledger = new ParadisReturnTunnelLedger('/x/ledger.json', { info: () => { }, warn: () => { } }, fake.host, 'darwin');

		ledger.add(5001);
		ledger.add(5002);
		ledger.remove(5001);
		await ledger.whenReaped();
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(fake.written.at(-1), JSON.stringify({ pids: [5002] }));
	});

	test('recognises the command and tolerates a broken ledger', () => {
		assert.deepStrictEqual(
			{
				tunnel: paradisIsReturnTunnelCommand(TUNNEL),
				bare: paradisIsReturnTunnelCommand('ssh -N -R 0:127.0.0.1:47286 -o ControlPath=none -o BatchMode=yes -o ExitOnForwardFailure=yes -o LogLevel=INFO host'),
				userTunnel: paradisIsReturnTunnelCommand('ssh -N -R 8080:127.0.0.1:8080 host'),
				broken: paradisParseReturnTunnelLedger('{"pids":'),
				filtered: paradisParseReturnTunnelLedger('{"pids":[1,"2",300,-4]}'),
			},
			{ tunnel: true, bare: true, userTunnel: false, broken: [], filtered: [300] },
		);
	});
});

suite('paradisWaitForUnsyncedPane', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function clock() {
		let time = 0;
		return { now: () => time, sleep: async (ms: number) => { time += ms; } };
	}

	test('returns the pane once it is synced', async () => {
		const { now, sleep } = clock();
		let polls = 0;

		const value = await paradisWaitForUnsyncedPane(() => ++polls >= 4 ? 'lease' : undefined, () => true, () => false, 25_000, sleep, now);

		assert.deepStrictEqual({ value, polls }, { value: 'lease', polls: 4 });
	});

	test('stops when the pane can no longer be merely unsynced, the caller is gone, or the limit passes', async () => {
		const ended = clock();
		const gone = clock();
		const late = clock();

		assert.deepStrictEqual(
			{
				ended: await paradisWaitForUnsyncedPane(() => undefined, () => ended.now() < 1000, () => false, 25_000, ended.sleep, ended.now),
				endedAt: ended.now(),
				gone: await paradisWaitForUnsyncedPane(() => undefined, () => true, () => gone.now() >= 500, 25_000, gone.sleep, gone.now),
				goneAt: gone.now(),
				late: await paradisWaitForUnsyncedPane(() => undefined, () => true, () => false, 2000, late.sleep, late.now),
				lateAt: late.now(),
			},
			{ ended: undefined, endedAt: 1000, gone: undefined, goneAt: 500, late: undefined, lateAt: 2000 },
		);
	});
});
