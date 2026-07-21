/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Windows用CodexペインランチャーJS本体（resources/paradis/bin/paradisCodexPaneLauncher.cjs）の
// 動作テスト。JS本体はプラットフォーム非依存のNodeスクリプトなので、macOS/Linuxのテスト
// ランナー上でも `codex.exe` という名前の偽実行ファイルとNode実行で全経路を検証できる。

import assert from 'assert';
import { createHash } from 'crypto';
import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { dirname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const execFileAsync = promisify(execFile);

const FAKE_CODEX_SOURCE = `#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const args = process.argv.slice(2);
const record = { args, paneToken: process.env.PARA_CODE_TERMINAL_PANE_ID, portFile: process.env.PARA_CODE_MCP_PORT_FILE };
if (args[0] === 'app-server') {
	const server = http.createServer((request, response) => { response.statusCode = 401; response.end(); });
	server.on('upgrade', (request, socket) => {
		if (request.headers['authorization'] === 'Bearer ' + process.env.PARADIS_TEST_EXPECTED_TOKEN) {
			const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
			socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
		} else {
			socket.end('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
		}
	});
	process.on('SIGTERM', () => process.exit(0));
	server.listen(0, '127.0.0.1', () => {
		record.port = server.address().port;
		fs.writeFileSync(process.env.PARADIS_TEST_APP_SERVER_RECORD, JSON.stringify(record));
		process.stderr.write('codex app-server (WebSockets)\\n  listening on: ws://127.0.0.1:' + record.port + '\\n');
	});
} else {
	fs.writeFileSync(process.env.PARADIS_TEST_TUI_RECORD, JSON.stringify(record));
}
`;

interface IFakeCodexRecord {
	readonly args: readonly string[];
	readonly paneToken?: string;
	readonly portFile?: string;
	readonly port?: number;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.fail(message);
}

suite('ParadisCodexPaneWinLauncher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const launcherJsPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'paradisCodexPaneLauncher.cjs');

	interface ITestSetup {
		readonly testRoot: string;
		readonly endpointPath: string;
		readonly appServerRecordPath: string;
		readonly tuiRecordPath: string;
		readonly fakeCodexPath: string;
		readonly env: Record<string, string>;
	}

	async function createSetup(): Promise<ITestSetup> {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-win-launcher-'));
		const fakeBin = join(testRoot, 'bin');
		const fakeCodexPath = join(fakeBin, 'codex.exe');
		const endpointPath = join(testRoot, 'pcx', 'pane-token.endpoint.json');
		const appServerRecordPath = join(testRoot, 'app-server.json');
		const tuiRecordPath = join(testRoot, 'tui.json');
		await fs.mkdir(fakeBin, { recursive: true });
		await fs.writeFile(fakeCodexPath, FAKE_CODEX_SOURCE, { mode: 0o700 });
		const launcherDir = dirname(launcherJsPath);
		return {
			testRoot, endpointPath, appServerRecordPath, tuiRecordPath, fakeCodexPath,
			env: {
				...process.env as Record<string, string>,
				ELECTRON_RUN_AS_NODE: '1',
				PATH: `${launcherDir}:${fakeBin}:${process.env['PATH'] ?? ''}`,
				PARA_CODE_CODEX_LAUNCHER_DIR: launcherDir,
				PARA_CODE_CODEX_APP_SERVER_ENDPOINT: endpointPath,
				PARA_CODE_TERMINAL_PANE_ID: 'pane-token',
				PARA_CODE_MCP_PORT_FILE: '/tmp/paradis-browser-mcp.json',
				PARADIS_TEST_EXPECTED_TOKEN: 'pane-token',
				PARADIS_TEST_APP_SERVER_RECORD: appServerRecordPath,
				PARADIS_TEST_TUI_RECORD: tuiRecordPath,
			},
		};
	}

	test('starts an authenticated ws pane app-server and forwards interactive arguments', async () => {
		const setup = await createSetup();
		try {
			const prompt = 'explain the "quoted" spaces & marker';
			await execFileAsync(process.execPath, [launcherJsPath, '--model', 'gpt-5', prompt], { env: setup.env, timeout: 15_000 });

			const appServer = JSON.parse(await fs.readFile(setup.appServerRecordPath, 'utf8')) as IFakeCodexRecord;
			const tui = JSON.parse(await fs.readFile(setup.tuiRecordPath, 'utf8')) as IFakeCodexRecord;
			const tokenDigest = createHash('sha256').update('pane-token', 'utf8').digest('hex');
			assert.deepStrictEqual({ appServerArgs: appServer.args, paneToken: appServer.paneToken, portFile: appServer.portFile, tui }, {
				appServerArgs: ['app-server', '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token', '--ws-token-sha256', tokenDigest],
				paneToken: 'pane-token',
				portFile: '/tmp/paradis-browser-mcp.json',
				tui: {
					args: ['--remote', `ws://127.0.0.1:${appServer.port}`, '--remote-auth-token-env', 'PARA_CODE_TERMINAL_PANE_ID', '--model', 'gpt-5', prompt],
					paneToken: 'pane-token',
					portFile: '/tmp/paradis-browser-mcp.json',
				},
			});
			// ランチャー終了時に、所有していたapp-serverとendpointファイルを掃除する。
			assert.strictEqual(await fs.access(setup.endpointPath).then(() => true, () => false), false);
		} finally {
			await fs.rm(setup.testRoot, { recursive: true, force: true });
		}
	});

	test('delegates non-interactive and explicitly remote commands unchanged', async () => {
		const setup = await createSetup();
		try {
			const runs: readonly (readonly string[])[] = [
				['exec', '--json', 'status'],
				['--remote', 'ws://127.0.0.1:4321', 'resume', 'thread-1'],
				['--version'],
			];
			for (const args of runs) {
				await execFileAsync(process.execPath, [launcherJsPath, ...args], { env: setup.env, timeout: 15_000 });
			}
			// 委譲経路ではapp-serverを起動しない（recordはTUI側の最後の1件だけ上書きされる）。
			assert.strictEqual(await fs.access(setup.appServerRecordPath).then(() => true, () => false), false);
			const lastRecord = JSON.parse(await fs.readFile(setup.tuiRecordPath, 'utf8')) as IFakeCodexRecord;
			assert.deepStrictEqual(lastRecord.args, ['--version']);
			assert.strictEqual(await fs.access(setup.endpointPath).then(() => true, () => false), false);
		} finally {
			await fs.rm(setup.testRoot, { recursive: true, force: true });
		}
	});

	test('adopts and cleans up a pane app-server whose launcher died', async () => {
		const setup = await createSetup();
		const staleServer = spawn(setup.fakeCodexPath, ['app-server'], { env: setup.env, stdio: 'ignore' });
		try {
			await waitFor(() => fs.access(setup.appServerRecordPath).then(() => true, () => false), 'stale app-server did not start');
			const stale = JSON.parse(await fs.readFile(setup.appServerRecordPath, 'utf8')) as IFakeCodexRecord;
			await fs.mkdir(dirname(setup.endpointPath), { recursive: true });
			await fs.writeFile(setup.endpointPath, JSON.stringify({ port: stale.port, pid: staleServer.pid, ownerPid: 3_999_999 }));

			await execFileAsync(process.execPath, [launcherJsPath], { env: setup.env, timeout: 15_000 });
			await waitFor(async () => !processIsAlive(staleServer.pid!), 'adopted app-server was not stopped');

			const tui = JSON.parse(await fs.readFile(setup.tuiRecordPath, 'utf8')) as IFakeCodexRecord;
			assert.deepStrictEqual(tui.args, ['--remote', `ws://127.0.0.1:${stale.port}`, '--remote-auth-token-env', 'PARA_CODE_TERMINAL_PANE_ID']);
			assert.strictEqual(await fs.access(setup.endpointPath).then(() => true, () => false), false);
		} finally {
			staleServer.kill('SIGKILL');
			await fs.rm(setup.testRoot, { recursive: true, force: true });
		}
	});
});
