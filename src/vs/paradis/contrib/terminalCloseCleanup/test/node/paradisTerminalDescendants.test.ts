/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { timeout } from '../../../../../base/common/async.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisProcessRow } from '../../common/paradisTerminalCloseCleanup.js';
import { IParadisDescendantStopDeps, paradisCaptureShellDescendants, paradisDescendantStopDeps, ParadisShutdownOrder, paradisShutdownStoppingDescendants, paradisStopCapturedDescendants } from '../../node/paradisTerminalDescendants.js';

function row(pid: number, ppid: number, command: string, startedAt: number = 100): IParadisProcessRow {
	return { pid, ppid, pgid: pid, startedAt, command, tty: '??' };
}

/** 偽の外の世界。表は段階ごとに差し替える。 */
function fakeDeps(options: {
	snapshot: readonly IParadisProcessRow[];
	/** 1 回目・2 回目の撮り直しで生きているもの。 */
	looks: readonly (readonly IParadisProcessRow[] | undefined)[];
	ignored: ReadonlyMap<number, boolean | undefined>;
}) {
	const events: string[] = [];
	let look = 0;
	const deps: IParadisDescendantStopDeps = {
		snapshot: async () => ({ rows: options.snapshot, bornBefore: 1_000 }),
		lookup: async pids => {
			events.push(`lookup ${pids.join(',')}`);
			return options.looks[look++];
		},
		probeHangupIgnored: async rows => {
			events.push(`probe ${rows.map(r => r.pid).join(',')}`);
			return options.ignored;
		},
		kill: (pid, signal) => events.push(`${signal} ${pid}`),
		delay: async ms => { events.push(`wait ${ms}`); },
		log: new NullLogService(),
	};
	return { deps, events };
}

suite('paradisTerminalDescendants', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('waits for the shell, stops survivors that do not ignore hangup, and SIGKILLs only the same process that is still there', async () => {
		const shell = 10;
		const snapshot = [row(shell, 1, 'zsh'), row(11, shell, 'node'), row(12, shell, 'nohup-ed'), row(13, shell, 'vite'), row(14, shell, 'gone')];
		const { deps, events } = fakeDeps({
			snapshot,
			looks: [
				// 14 は猶予の間に自分で終わった。
				[row(11, 1, 'node'), row(12, 1, 'nohup-ed'), row(13, 1, 'vite')],
				// 11 は SIGTERM で終わり、13 は残ったが、同じ pid を別のプロセスが使っている。
				[row(13, 1, 'vite', 555)],
			],
			ignored: new Map([[11, false], [12, true], [13, false]]),
		});
		const captured = await paradisCaptureShellDescendants(shell, deps);
		const report = await paradisStopCapturedDescendants(captured, Promise.resolve(), deps);
		assert.deepStrictEqual({
			captured: captured.map(r => r.pid),
			events,
			terminated: report.terminated.map(r => r.pid),
			killed: report.killed.map(r => r.pid),
			kept: report.kept.map(r => r.pid),
		}, {
			captured: [11, 12, 13, 14],
			events: ['wait 2000', 'lookup 11,12,13,14', 'probe 11,12,13', 'SIGTERM 11', 'SIGTERM 13', 'wait 8000', 'lookup 11,13'],
			terminated: [11, 13],
			killed: [],
			kept: [12],
		});
	});

	// レビュー H2: アプリの中の pty ホストでは、シェルへの終了を表の撮影で遅らせない。常駐の中でだけ待つ。
	test('the in-app order ends the shell right away; the daemon order ends it once the table is taken', async () => {
		const order: string[] = [];
		const make = () => {
			const { deps } = fakeDeps({ snapshot: [row(10, 1, 'zsh')], looks: [], ignored: new Map() });
			return { ...deps, snapshot: async () => { order.push('snapshot'); return deps.snapshot(); } };
		};
		const alongside = paradisShutdownStoppingDescendants(10, () => order.push('end:alongside'), Promise.resolve(), new NullLogService(), ParadisShutdownOrder.CaptureAlongside, make());
		order.push('returned:alongside');
		await alongside.done;
		const first = paradisShutdownStoppingDescendants(10, () => order.push('end:first'), Promise.resolve(), new NullLogService(), ParadisShutdownOrder.CaptureFirst, make());
		order.push('returned:first');
		await first.done;
		assert.deepStrictEqual(order, ['snapshot', 'end:alongside', 'returned:alongside', 'snapshot', 'returned:first', 'end:first']);
	});

	test('does nothing when the process table cannot be read again', async () => {
		const { deps, events } = fakeDeps({ snapshot: [row(10, 1, 'zsh'), row(11, 10, 'node')], looks: [undefined], ignored: new Map() });
		const captured = await paradisCaptureShellDescendants(10, deps);
		await paradisStopCapturedDescendants(captured, Promise.resolve(), deps);
		assert.deepStrictEqual(events, ['wait 2000', 'lookup 11']);
	});

	test('does nothing for an unknown shell pid', async () => {
		const { deps } = fakeDeps({ snapshot: [row(1, 0, 'launchd'), row(2, 1, 'x')], looks: [], ignored: new Map() });
		assert.deepStrictEqual(await paradisCaptureShellDescendants(1, deps), []);
	});

	// 本物の `ps` と、SIGHUP を無視しているかの調べ役（macOS は sysctl、Linux は /proc）が、
	// 手元の OS で読めることを確かめる。止める処理は通さない（シグナルは送らない）。
	(isWindows ? test.skip : test)('reads the real process table and tells a nohup-ed child from a plain one', async function () {
		this.timeout(10_000);
		const children: ChildProcess[] = [];
		try {
			const ignoring = spawn('/bin/sh', ['-c', 'trap "" HUP; exec sleep 30'], { stdio: 'ignore' });
			const plain = spawn('/bin/sh', ['-c', 'exec sleep 30'], { stdio: 'ignore' });
			children.push(ignoring, plain);
			// 生まれた秒を表の撮影より前にする（撮った秒に生まれたものは対象外になるため）。
			await timeout(1_100);
			const deps = paradisDescendantStopDeps(new NullLogService());
			const captured = await paradisCaptureShellDescendants(process.pid, deps);
			const mine = captured.filter(candidate => candidate.pid === ignoring.pid || candidate.pid === plain.pid);
			const probed = await deps.probeHangupIgnored(mine);
			assert.deepStrictEqual({
				found: mine.map(candidate => candidate.pid).sort(),
				commands: mine.map(candidate => candidate.command),
				ignoring: probed.get(ignoring.pid!),
				plain: probed.get(plain.pid!),
			}, {
				found: [ignoring.pid!, plain.pid!].sort(),
				commands: ['sleep', 'sleep'],
				ignoring: true,
				plain: false,
			});
		} finally {
			for (const child of children) {
				child.kill('SIGKILL');
			}
		}
	});
	// 本物のシグナルで一巡させる。対象はこのテストが起こしたシェルの子だけ。
	(isWindows ? test.skip : test)('stops a background job of a dead shell for real and keeps the one that ignores hangup', async function () {
		this.timeout(30_000);
		const shell = spawn('/bin/sh', ['-c', 'sleep 30 & (trap "" HUP; exec sleep 31) & wait'], { stdio: 'ignore' });
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		let captured: readonly IParadisProcessRow[] = [];
		try {
			await timeout(1_100);
			const deps = paradisDescendantStopDeps(new NullLogService());
			captured = await paradisCaptureShellDescendants(shell.pid!, deps);
			// シェルだけを先に殺す（ターミナルの pty が SIGKILL された形）。子は引き取られて残る。
			shell.kill('SIGKILL');
			const report = await paradisStopCapturedDescendants(captured, Promise.resolve(), deps);
			assert.deepStrictEqual({
				captured: captured.map(candidate => candidate.command).sort(),
				terminated: report.terminated.map(candidate => candidate.command),
				kept: report.kept.map(candidate => candidate.command),
				terminatedGone: report.terminated.every(candidate => !alive(candidate.pid)),
				keptAlive: report.kept.every(candidate => alive(candidate.pid)),
			}, {
				captured: ['sleep', 'sleep'],
				terminated: ['sleep'],
				kept: ['sleep'],
				terminatedGone: true,
				keptAlive: true,
			});
		} finally {
			shell.kill('SIGKILL');
			for (const candidate of captured) {
				try {
					process.kill(candidate.pid, 'SIGKILL');
				} catch {
					// 既に終わっている
				}
			}
		}
	});
});
