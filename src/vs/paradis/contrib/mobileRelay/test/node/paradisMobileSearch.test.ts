/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisSearchFiles, paradisSearchText, paradisSpawnRg } from '../../node/paradisMobileSearch.js';

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

	// In the Electron test runner process.execPath is Electron itself: run it as Node for the stand-in.
	let previousRunAsNode: string | undefined;
	setup(() => {
		previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
		process.env.ELECTRON_RUN_AS_NODE = '1';
	});
	teardown(() => {
		if (previousRunAsNode === undefined) {
			delete process.env.ELECTRON_RUN_AS_NODE;
		} else {
			process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode;
		}
	});

	test('searching inside a folder returns workspace-relative paths from that folder only', async () => {
		const root = mkdtempSync(join(tmpdir(), 'paradis-search-dir-'));
		mkdirSync(join(root, 'src', 'app'), { recursive: true });
		mkdirSync(join(root, 'docs'));
		writeFileSync(join(root, 'src', 'app', 'main.ts'), 'needle\n');
		writeFileSync(join(root, 'docs', 'main.md'), 'needle\n');
		try {
			const log = new NullLogService();
			const files = await paradisSearchFiles(root, 'main', 10, log, 'src');
			const text = await paradisSearchText(root, 'needle', 10, log, 'src/');
			const outside = await paradisSearchFiles(root, 'main', 10, log, '../');
			assert.deepStrictEqual({ files, text, outside }, {
				files: { files: ['src/app/main.ts'], truncated: false },
				text: { matches: [{ path: 'src/app/main.ts', line: 1, text: 'needle' }], truncated: false },
				outside: { files: [], truncated: false },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

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
