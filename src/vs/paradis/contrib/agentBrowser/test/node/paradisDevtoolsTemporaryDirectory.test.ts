/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisDevtoolsTemporaryDirectory } from '../../node/paradisDevtoolsTemporaryDirectory.js';

suite('ParadisDevtoolsTemporaryDirectory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let parent: string;
	setup(() => {
		parent = mkdtempSync(join(tmpdir(), 'paradis-devtools-temp-test-'));
	});
	teardown(() => {
		rmSync(parent, { recursive: true, force: true });
	});

	test('creates a private folder, recreates it when it disappears, and removes it on dispose', async () => {
		const directory = new ParadisDevtoolsTemporaryDirectory(parent, 4242);
		const first = directory.ensure()!;
		const mode = process.platform === 'win32' ? 0 : statSync(first).mode & 0o777;
		const reused = directory.ensure();
		rmSync(first, { recursive: true, force: true });
		const second = directory.ensure()!;
		await directory.dispose();

		assert.deepStrictEqual({
			mode,
			reused: reused === first,
			recreated: second !== first && second.startsWith(join(parent, 'para-code-devtools-')),
			removed: !existsSync(second),
			afterDispose: directory.ensure(),
		}, { mode: process.platform === 'win32' ? 0 : 0o700, reused: true, recreated: true, removed: true, afterDispose: undefined });
	});

	test('sweeps folders of dead owners and old unowned folders, and keeps live, own and foreign ones', async () => {
		const make = (name: string, owner?: string) => {
			const path = join(parent, name);
			mkdirSync(path, { mode: 0o700 });
			if (owner !== undefined) {
				writeFileSync(join(path, '.para-code-owner'), owner);
			}
			return path;
		};
		make('para-code-devtools-dead', '111');
		make('para-code-devtools-alive', '222');
		make('para-code-devtools-own', '333');
		make('para-code-devtools-new-unowned');
		const old = make('para-code-devtools-old-unowned');
		const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60_000);
		utimesSync(old, oldTime, oldTime);
		make('other-folder', '111');

		const removed = await ParadisDevtoolsTemporaryDirectory.sweepStale(parent, 333, Date.now(), pid => pid === 222);
		assert.deepStrictEqual({ removed: removed.sort(), left: readdirSync(parent).sort() }, {
			removed: ['para-code-devtools-dead', 'para-code-devtools-old-unowned'],
			left: ['other-folder', 'para-code-devtools-alive', 'para-code-devtools-new-unowned', 'para-code-devtools-own'],
		});
	});
});
