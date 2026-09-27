/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_RENDER_EVIDENCE_MAX_AGE } from '../../../terminalRenderer/common/paradisRenderDesync.js';
import { ParadisTerminalPrivateFileStore } from '../../node/paradisTerminalPrivateFileStore.js';

suite('ParadisTerminalPrivateFileStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let clock: number;
	let store: ParadisTerminalPrivateFileStore;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-private-files-'));
		clock = Date.now();
		store = new ParadisTerminalPrivateFileStore(join(root, 'screens'), join(root, 'logs', 'render'), () => clock);
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('writes screens privately and drops internal environment variables and pane tokens', async () => {
		const state = JSON.stringify({
			version: 1,
			state: [{
				id: 1,
				shellLaunchConfig: { env: { PARA_CODE_TERMINAL_PANE_ID: 'secret', KEEP: '1' } },
				processDetails: { paradisPaneToken: 'secret', pid: 2 },
				processLaunchConfig: { env: { PARA_CODE_VOICE_TOKEN: 'secret', PARADIS_PTY_DAEMON_SOCKET: 's', PATH: '/bin' }, executableEnv: { PARA_CODE_CODEX_X: 'secret' } },
			}],
		});
		await store.writeScreens('abc123', JSON.stringify({ version: 2, savedAt: 1, daemon: { pid: 1, startedAt: 1 }, state }));
		const read = JSON.parse((await store.readScreens('abc123'))!);
		const file = join(root, 'screens', 'abc123.json');
		assert.deepStrictEqual({
			entry: JSON.parse(read.state).state[0],
			fileMode: isWindows ? 0o600 : statSync(file).mode & 0o777,
			dirMode: isWindows ? 0o700 : statSync(join(root, 'screens')).mode & 0o777,
			leftovers: readdirSync(join(root, 'screens')),
		}, {
			entry: {
				id: 1,
				shellLaunchConfig: { env: { KEEP: '1' } },
				processDetails: { pid: 2 },
				processLaunchConfig: { env: { PATH: '/bin' }, executableEnv: {} },
			},
			fileMode: 0o600,
			dirMode: 0o700,
			leftovers: ['abc123.json'],
		});
	});

	test('refuses workspace ids that could escape the folder', async () => {
		await assert.rejects(store.writeScreens('../x', '{}'));
		await assert.rejects(store.readScreens('a/b'));
	});

	test('keeps at most four render records and drops the ones older than a week', async () => {
		const folders: string[] = [];
		for (let i = 0; i < 5; i++) {
			clock += 1000;
			folders.push((await store.writeRenderEvidence({ beforePng: Buffer.from('png').toString('base64'), info: '{}' }))!);
		}
		const afterFive = readdirSync(join(root, 'logs', 'render')).length;
		// 残っている分の更新時刻を8日前へずらすと、次の記録で全部消える
		for (const folder of folders.slice(1)) {
			const old = new Date(clock - PARADIS_RENDER_EVIDENCE_MAX_AGE - 24 * 60 * 60 * 1000);
			utimesSync(folder, old, old);
		}
		clock += 1000;
		const latest = (await store.writeRenderEvidence({ info: '{"x":1}' }))!;
		assert.deepStrictEqual({
			afterFive,
			remaining: readdirSync(join(root, 'logs', 'render')).length,
			info: readFileSync(join(latest, 'info.json'), 'utf8'),
			infoMode: isWindows ? 0o600 : statSync(join(latest, 'info.json')).mode & 0o777,
		}, { afterFive: 4, remaining: 1, info: '{"x":1}', infoMode: 0o600 });
	});
});
