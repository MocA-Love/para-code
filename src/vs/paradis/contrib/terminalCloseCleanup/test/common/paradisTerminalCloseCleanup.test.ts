/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisProcessRow,
	paradisApplyCloseCleanupPreference,
	paradisCollectShellDescendants,
	paradisParseDarwinHangupProbe,
	paradisParseLinuxHangupIgnored,
	paradisParsePsRows,
	paradisPlanHangupSurvivors,
	paradisShouldStopBackgroundOnClose,
	paradisStillRunning,
	paradisSummarizeCommands,
	paradisWithoutCloseCleanupMarker,
	PARADIS_TERMINAL_KEEP_BACKGROUND_ENV,
} from '../../common/paradisTerminalCloseCleanup.js';

function row(pid: number, ppid: number, startedAt: number = 100, command: string = 'proc', pgid: number = pid): IParadisProcessRow {
	return { pid, ppid, pgid, startedAt, command };
}

suite('paradisTerminalCloseCleanup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads ps rows on macOS and Linux, keeps only the executable name and skips broken lines', () => {
		const output = [
			'  501     1   501 Tue Sep 29 00:20:29 2026     /Applications/Some App.app/Contents/MacOS/node',
			'  502   501   502 Tue Sep  9 07:05:01 2026 vite',
			'garbage',
			'  503   501   502 Xyz Foo 29 00:20:29 2026 broken',
		].join('\n');
		const rows = paradisParsePsRows(output);
		assert.deepStrictEqual(rows.map(({ pid, ppid, pgid, command }) => ({ pid, ppid, pgid, command })), [
			{ pid: 501, ppid: 1, pgid: 501, command: 'node' },
			{ pid: 502, ppid: 501, pgid: 502, command: 'vite' },
		]);
		assert.strictEqual(rows[0].startedAt, Math.floor(new Date(2026, 8, 29, 0, 20, 29).getTime() / 1000));
	});

	test('collects only descendants of the shell, never the shell, excluded pids or anything born in the snapshot second', () => {
		const rows = [
			row(10, 1),            // the shell
			row(11, 10),           // background job
			row(12, 11),           // its child
			row(13, 10, 200),      // born in the snapshot second
			row(14, 13, 201),      // below it
			row(15, 10),           // excluded (e.g. the pty host itself)
			row(20, 1),            // another terminal's shell
			row(21, 20),
		];
		assert.deepStrictEqual(paradisCollectShellDescendants(rows, 10, 200, new Set([15])).map(r => r.pid), [11, 12]);
	});

	test('a reused pid is not the same process', () => {
		const captured = [row(11, 10, 100), row(12, 11, 100), row(13, 11, 100)];
		const current = [row(11, 1, 100), row(12, 1, 150), { ...row(13, 1, 100), pgid: 99 }];
		assert.deepStrictEqual(paradisStillRunning(captured, current).map(r => r.pid), [11]);
	});

	test('keeps what ignores hangup, what lives under it, and what cannot be read; stops the rest', () => {
		const captured = [row(11, 10), row(12, 11), row(13, 10), row(14, 13), row(15, 10)];
		const plan = paradisPlanHangupSurvivors(captured, captured, new Map<number, boolean | undefined>([
			[11, true],        // nohup
			[12, false],       // node below nohup resets its signal handling
			[13, false],
			[14, false],
			[15, undefined],   // unreadable
		]));
		assert.deepStrictEqual({ stop: plan.stop.map(r => r.pid), keep: plan.keep.map(r => r.pid) }, { stop: [13, 14], keep: [11, 12, 15] });
	});

	test('reads SIGHUP out of the Linux SigIgn mask and the macOS probe', () => {
		assert.deepStrictEqual([
			paradisParseLinuxHangupIgnored('Name:\tsleep\nSigIgn:\t0000000000000001\n'),
			paradisParseLinuxHangupIgnored('SigIgn:\t0000000000000006\n'),
			paradisParseLinuxHangupIgnored('Name:\tsleep\n'),
		], [true, false, undefined]);
		const rows = [row(11, 10, 100, 'a', 11), row(12, 10, 100, 'b', 12), row(13, 10, 100, 'c', 13)];
		const probe = paradisParseDarwinHangupProbe([
			JSON.stringify({ pid: 11, pgid: 11, ignored: 0x8488007 }),
			JSON.stringify({ pid: 12, pgid: 12, ignored: 0x8488006 }),
			JSON.stringify({ pid: 13, pgid: 77, ignored: 1 }), // another process now owns the pid
			'not json',
		].join('\n'), rows);
		assert.deepStrictEqual([...probe], [[11, true], [12, false], [13, undefined]]);
	});

	test('the preference travels as an env marker that the shell never sees', () => {
		const env: { [key: string]: string | null | undefined } = { PATH: '/usr/bin' };
		paradisApplyCloseCleanupPreference(env, false);
		const off = { ...env };
		paradisApplyCloseCleanupPreference(env, true);
		assert.deepStrictEqual({
			off,
			on: env,
			stopWhenOff: paradisShouldStopBackgroundOnClose(off, false),
			stopWhenOn: paradisShouldStopBackgroundOnClose(env, false),
			stopOnWindows: paradisShouldStopBackgroundOnClose(env, true),
			shellEnv: paradisWithoutCloseCleanupMarker(off),
		}, {
			off: { PATH: '/usr/bin', [PARADIS_TERMINAL_KEEP_BACKGROUND_ENV]: '1' },
			on: { PATH: '/usr/bin' },
			stopWhenOff: false,
			stopWhenOn: true,
			stopOnWindows: false,
			shellEnv: { PATH: '/usr/bin' },
		});
	});

	test('summarizes command names only', () => {
		assert.strictEqual(paradisSummarizeCommands([row(1, 0, 0, 'node'), row(2, 0, 0, 'node'), row(3, 0, 0, 'vite')]), 'node x2, vite');
	});
});
