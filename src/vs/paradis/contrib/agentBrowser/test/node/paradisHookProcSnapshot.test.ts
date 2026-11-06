/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHookProcessInfo, paradisHookProcessSnapshotsForTest } from '../../node/paradisAgentHookOwnership.js';

/** `pid` から PID 1 までの祖先（自身を含む）。 */
function ancestors(table: ReadonlyMap<number, IParadisHookProcessInfo>, pid: number): number[] {
	const result: number[] = [];
	for (let current = table.get(pid); current !== undefined && !result.includes(current.pid); current = current.ppid !== undefined ? table.get(current.ppid) : undefined) {
		result.push(current.pid);
	}
	return result;
}

/** `root` とその子孫。 */
function subtree(table: ReadonlyMap<number, IParadisHookProcessInfo>, root: number): number[] {
	const result = [root];
	for (let index = 0; index < result.length; index++) {
		for (const entry of table.values()) {
			if (entry.ppid === result[index] && !result.includes(entry.pid)) {
				result.push(entry.pid);
			}
		}
	}
	return result;
}

suite('paradisHookProcSnapshot', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads from /proc the same processes ps shows for the hook, Para Code and the pane', async function () {
		if (process.platform !== 'linux') {
			this.skip();
		}
		this.timeout(20_000);
		// ペインのシェル → 子のシェル → hook（sleep）。ペインにはもう 1 本、関係の無い子もいる。
		// ペインの起動行には改行・タブ・日本語を混ぜる（ps は LC_ALL=C で読むので、それぞれ空白・.・? に見える）
		const pane: ChildProcess = spawn('sh', ['-c', 'sh -c "sleep 40; :" & sleep 41; :', 'x\ny\tz ペイン'], { detached: true });
		try {
			let full: ReadonlyMap<number, IParadisHookProcessInfo> | undefined;
			for (let attempt = 0; attempt < 50; attempt++) {
				await timeout(100);
				full = await paradisHookProcessSnapshotsForTest.posixProcessSnapshot();
				if (full !== undefined && subtree(full, pane.pid!).length === 4) {
					break;
				}
			}
			const hookPid = [...full!.values()].find(entry => entry.command === 'sleep 40')!.pid;
			const partial = await paradisHookProcessSnapshotsForTest.linuxProcSnapshot({ pids: [hookPid, process.pid], descendantsOf: pane.pid! });
			// 判定が引く pid（hook と自分の祖先、ペインの子孫）が全部あり、中身が ps と同じ（startKey は形が違うので除く）
			const needed = [...new Set([...ancestors(full!, hookPid), ...ancestors(full!, process.pid), ...subtree(full!, pane.pid!)])].sort((a, b) => a - b);
			const row = (entry: IParadisHookProcessInfo | undefined) => entry === undefined ? undefined : { pid: entry.pid, ppid: entry.ppid, command: entry.command };
			assert.deepStrictEqual(
				needed.map(pid => row(partial!.get(pid))),
				needed.map(pid => row(full!.get(pid))),
			);
		} finally {
			process.kill(-pane.pid!, 'SIGKILL');
		}
	});
});
