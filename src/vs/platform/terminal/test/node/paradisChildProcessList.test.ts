/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { timeout } from '../../../../base/common/async.js';
import { ProcessItem } from '../../../../base/common/processes.js';
import { listProcesses } from '../../../../base/node/ps.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { paradisCommandLineFromProc, paradisListChildProcesses, paradisParseProcStat } from '../../node/paradisChildProcessList.js';

/** What `ChildProcessMonitor` reads from the list: the children's pids and command lines. */
function childrenOf(item: ProcessItem): { readonly pid: number; readonly cmd: string }[] | undefined {
	return item.children?.map(child => ({ pid: child.pid, cmd: child.cmd }));
}

suite('paradisChildProcessList', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a stat line whose command name holds spaces and parentheses', () => {
		const stat = '4242 (my (odd) name) S 17 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';
		assert.deepStrictEqual({
			stat: paradisParseProcStat(stat),
			args: paradisCommandLineFromProc('sleep\x0030\x00', 'sleep', 'S'),
			empty: paradisCommandLineFromProc('', 'kworker', 'I'),
			zombie: paradisCommandLineFromProc('', 'sh', 'Z'),
		}, {
			stat: { comm: 'my (odd) name', state: 'S', ppid: 17, startTime: '987654' },
			args: 'sleep 30',
			empty: '[kworker]',
			zombie: '[sh] <defunct>',
		});
	});

	test('falls back to ps when /proc has no children files', async function () {
		if (process.platform !== 'linux') {
			this.skip();
		}
		const shell = spawn('sh', ['-c', 'sleep 34; :'], { detached: true });
		try {
			let fallback: ProcessItem | undefined;
			for (let attempt = 0; attempt < 50 && fallback?.children === undefined; attempt++) {
				await timeout(100);
				fallback = await paradisListChildProcesses(shell.pid!, async path => {
					if (path.endsWith('/children')) {
						throw new Error('ENOENT');
					}
					return fs.readFile(path, 'utf8');
				});
			}
			// ps の答え（直下の子だけでなく孫の木も持つ）が返る
			assert.deepStrictEqual(childrenOf(fallback!), childrenOf(await listProcesses(shell.pid!)));
		} finally {
			process.kill(-shell.pid!, 'SIGKILL');
		}
	});

	test('rejects like ps when the root process is gone', async function () {
		if (process.platform !== 'linux') {
			this.skip();
		}
		await assert.rejects(paradisListChildProcesses(2 ** 22 + 1), /not found/);
	});

	test('reports the same children as ps for 0, 1 and 2 children', async function () {
		if (process.platform !== 'linux') {
			this.skip();
		}
		this.timeout(20_000);
		const shells: ChildProcess[] = [
			spawn('sleep', ['30'], { detached: true }),
			spawn('sh', ['-c', 'sleep 31; :'], { detached: true }),
			spawn('sh', ['-c', 'sleep 32 & sleep 33 & wait'], { detached: true }),
		];
		try {
			const expectedCounts = [0, 1, 2];
			// Wait until the shells have started their children
			for (let attempt = 0; attempt < 50; attempt++) {
				const counts = await Promise.all(shells.map(async shell => (await listProcesses(shell.pid!)).children?.length ?? 0));
				if (counts.every((count, index) => count === expectedCounts[index])) {
					break;
				}
				await timeout(100);
			}
			const fromPs = await Promise.all(shells.map(async shell => childrenOf(await listProcesses(shell.pid!))));
			const fromProc = await Promise.all(shells.map(async shell => childrenOf(await paradisListChildProcesses(shell.pid!))));
			assert.deepStrictEqual(fromProc, fromPs);
			assert.deepStrictEqual(fromProc.map(children => children?.length ?? 0), expectedCounts);
		} finally {
			for (const shell of shells) {
				// The whole group, so the shells' sleeps do not outlive the test
				process.kill(-shell.pid!, 'SIGKILL');
			}
		}
	});
});
