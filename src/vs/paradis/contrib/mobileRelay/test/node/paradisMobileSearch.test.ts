/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisSpawnRg } from '../../node/paradisMobileSearch.js';

/**
 * Node stands in for ripgrep so the test controls what goes to stdout, stderr and when it exits.
 */
suite('ParadisMobileSearch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function run(script: string, timeoutMs: number): Promise<{ timedOut: boolean; lines: string[] }> {
		const lines: string[] = [];
		const timedOut = await paradisSpawnRg(process.execPath, ['-e', script], tmpdir(), line => { lines.push(line); }, new NullLogService(), timeoutMs);
		return { timedOut, lines };
	}

	test('a flood of warnings on stderr does not stall the search, and running out of time is reported', async () => {
		// Far more than a pipe holds (64 KiB on Linux and macOS): unread, it would block the child.
		const noisy = await run(`process.stderr.write('x'.repeat(4 * 1024 * 1024)); process.stdout.write('a.txt\\nb.txt\\n');`, 10_000);
		const stuck = await run(`process.stdout.write('a.txt\\n'); setTimeout(() => { }, 60_000);`, 300);
		assert.deepStrictEqual({ noisy, stuck }, {
			noisy: { timedOut: false, lines: ['a.txt', 'b.txt'] },
			stuck: { timedOut: true, lines: ['a.txt'] },
		});
	});
});
