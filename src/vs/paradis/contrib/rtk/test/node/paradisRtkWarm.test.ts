/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisRtkService } from '../../node/paradisRtkChannel.js';

suite('ParadisRtk background refresh', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('keeps refreshing the status bar report but stops the dashboard reports 30 minutes after the last request', async () => {
		const clock = sinon.useFakeTimers();
		const runs: string[] = [];
		const execFile = ((_file: string, args: readonly string[], _options: cp.ExecFileOptionsWithStringEncoding, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
			runs.push(args.join(' '));
			setTimeout(() => callback(null, args.includes('json') ? '{}' : '', ''), 0);
			return { pid: undefined, exitCode: null, signalCode: null, kill: sinon.spy(() => true) } as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisRtkService(new NullLogService(), undefined, undefined, execFile, () => clock.now, true);
		const options = { executablePath: '/test/rtk' };
		const first = Promise.all([service.fetchSummary(options), service.fetchByCommand(options), service.fetchRecentHistory(options)]);
		await clock.tickAsync(0);
		await first;
		await clock.tickAsync(60 * 60 * 1000);
		const count = (command: string) => runs.filter(run => run === command).length;
		assert.deepStrictEqual({ statusBar: count('gain -f json -d'), byCommand: count('gain'), history: count('gain -H') }, { statusBar: 7, byCommand: 3, history: 3 });
		service.dispose();
	});
});
