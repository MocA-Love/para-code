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

	test('writes screens privately, drops secrets and keeps what a revived shell needs', async () => {
		const state = JSON.stringify({
			version: 1,
			state: [{
				id: 1,
				shellLaunchConfig: {
					env: {
						PARA_CODE_TERMINAL_PANE_ID: 'secret',
						PARA_CODE_CODEX_APP_SERVER_SOCKET: '/tmp/secret.sock',
						// 起こし直したシェルにも要る（スペース別の履歴・MCP のポートファイル）
						PARA_CODE_SPACE_HISTORY_DIR: '/h',
						PARA_CODE_SPACE_HISTORY_ID: 'abc',
						PARA_CODE_MCP_PORT_FILE: '/p',
						KEEP: '1',
					},
				},
				processDetails: { paradisPaneToken: 'secret', pid: 2 },
				processLaunchConfig: { env: { API_KEY: 'secret', PATH: '/bin' }, executableEnv: { PARA_CODE_VOICE_TOKEN: 'secret', PARADIS_PTY_DAEMON_SOCKET: 's', PATH: '/bin' } },
			}],
		});
		await store.writeScreens('abc123', 1, { pid: 1, startedAt: 1 }, state);
		const read = JSON.parse((await store.readScreens('abc123'))!);
		const file = join(root, 'screens', 'abc123.json');
		assert.deepStrictEqual({
			header: [read.version, read.savedAt, read.daemon],
			entry: JSON.parse(read.state).state[0],
			fileMode: isWindows ? 0o600 : statSync(file).mode & 0o777,
			dirMode: isWindows ? 0o700 : statSync(join(root, 'screens')).mode & 0o777,
			leftovers: readdirSync(join(root, 'screens')),
		}, {
			header: [2, 1, { pid: 1, startedAt: 1 }],
			entry: {
				id: 1,
				shellLaunchConfig: { env: { PARA_CODE_SPACE_HISTORY_DIR: '/h', PARA_CODE_SPACE_HISTORY_ID: 'abc', PARA_CODE_MCP_PORT_FILE: '/p', KEEP: '1' } },
				processDetails: { pid: 2 },
				processLaunchConfig: { env: {}, executableEnv: { PATH: '/bin' } },
			},
			fileMode: 0o600,
			dirMode: 0o700,
			leftovers: ['abc123.json'],
		});
	});

	test('writes render records one at a time', async () => {
		const folders = await Promise.all([1, 2, 3, 4, 5, 6].map(() => store.writeRenderEvidence({ info: '{}' })));
		assert.deepStrictEqual({ distinct: new Set(folders).size, remaining: readdirSync(join(root, 'logs', 'render')).length }, { distinct: 6, remaining: 4 });
	});

	test('refuses workspace ids that could escape the folder', async () => {
		await assert.rejects(store.writeScreens('../x', 1, { pid: 1, startedAt: 1 }, '{"state":[]}'));
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
