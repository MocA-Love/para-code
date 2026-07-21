/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { dirname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const execFileAsync = promisify(execFile);

async function waitForSocket(socketPath: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (await fs.stat(socketPath).then(stat => stat.isSocket(), () => false)) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.fail('socket did not become ready');
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface IFakeCodexRecord {
	readonly args: readonly string[];
	readonly paneToken?: string;
	readonly portFile?: string;
}

suite('ParadisCodexPaneLauncher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('starts a pane app-server and preserves interactive arguments and MCP environment', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		try {
			const launcherPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'codex');
			const fakeBin = join(testRoot, 'bin');
			const fakeCodexPath = join(fakeBin, 'codex');
			const appServerRecordPath = join(testRoot, 'app-server.json');
			const tuiRecordPath = join(testRoot, 'tui.json');
			const socketPath = join(testRoot, 'pcx', 'pane.sock');
			const injectionMarkerPath = join(testRoot, 'must-not-exist');
			await fs.mkdir(fakeBin, { recursive: true });
			await fs.writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const args = process.argv.slice(2);
const record = { args, paneToken: process.env.PARA_CODE_TERMINAL_PANE_ID, portFile: process.env.PARA_CODE_MCP_PORT_FILE };
if (args[0] === 'app-server') {
	fs.writeFileSync(process.env.PARADIS_TEST_APP_SERVER_RECORD, JSON.stringify(record));
	const socketPath = args[2].slice('unix://'.length);
	const server = net.createServer(socket => socket.end());
	const close = () => server.close(() => process.exit(0));
	process.on('SIGTERM', close);
	process.on('SIGINT', close);
	server.listen(socketPath);
} else {
	fs.writeFileSync(process.env.PARADIS_TEST_TUI_RECORD, JSON.stringify(record));
}
`, { mode: 0o700 });

			const prompt = `explain spaces; \$(touch ${injectionMarkerPath})`;
			await execFileAsync(launcherPath, ['--model', 'gpt-5', prompt], {
				env: {
					...process.env,
					PATH: `${dirname(launcherPath)}:${fakeBin}:${process.env['PATH'] ?? ''}`,
					PARA_CODE_CODEX_LAUNCHER_DIR: dirname(launcherPath),
					PARA_CODE_CODEX_APP_SERVER_SOCKET: socketPath,
					PARA_CODE_TERMINAL_PANE_ID: 'pane-token',
					PARA_CODE_MCP_PORT_FILE: '/tmp/paradis-browser-mcp.json',
					PARADIS_TEST_APP_SERVER_RECORD: appServerRecordPath,
					PARADIS_TEST_TUI_RECORD: tuiRecordPath,
				},
				timeout: 15_000,
			});

			const appServer = JSON.parse(await fs.readFile(appServerRecordPath, 'utf8')) as IFakeCodexRecord;
			const tui = JSON.parse(await fs.readFile(tuiRecordPath, 'utf8')) as IFakeCodexRecord;
			assert.deepStrictEqual({ appServer, tui, injectionRan: await fs.access(injectionMarkerPath).then(() => true, () => false) }, {
				appServer: {
					args: ['app-server', '--listen', `unix://${socketPath}`],
					paneToken: 'pane-token',
					portFile: '/tmp/paradis-browser-mcp.json',
				},
				tui: {
					args: ['--remote', `unix://${socketPath}`, '--model', 'gpt-5', prompt],
					paneToken: 'pane-token',
					portFile: '/tmp/paradis-browser-mcp.json',
				},
				injectionRan: false,
			});
			assert.strictEqual(await fs.access(socketPath).then(() => true, () => false), false);
		} finally {
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});

	test('delegates non-interactive and explicitly remote commands unchanged', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		try {
			const launcherPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'codex');
			const fakeBin = join(testRoot, 'bin');
			const fakeCodexPath = join(fakeBin, 'codex');
			const recordPath = join(testRoot, 'record.json');
			await fs.mkdir(fakeBin, { recursive: true });
			await fs.writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('fs');
const records = fs.existsSync(process.env.PARADIS_TEST_TUI_RECORD) ? JSON.parse(fs.readFileSync(process.env.PARADIS_TEST_TUI_RECORD, 'utf8')) : [];
records.push(process.argv.slice(2));
fs.writeFileSync(process.env.PARADIS_TEST_TUI_RECORD, JSON.stringify(records));
`, { mode: 0o700 });
			const env = {
				...process.env,
				PATH: `${dirname(launcherPath)}:${fakeBin}:${process.env['PATH'] ?? ''}`,
				PARA_CODE_CODEX_LAUNCHER_DIR: dirname(launcherPath),
				PARA_CODE_CODEX_APP_SERVER_SOCKET: join(testRoot, 'must-not-start.sock'),
				PARADIS_TEST_TUI_RECORD: recordPath,
			};
			await execFileAsync(launcherPath, ['exec', '--json', 'status'], { env });
			await execFileAsync(launcherPath, ['--remote', 'unix:///tmp/existing.sock', 'resume', 'thread-1'], { env });
			await execFileAsync(launcherPath, ['resume', '--remote', 'unix:///tmp/after-command.sock', 'thread-2'], { env });

			assert.deepStrictEqual(JSON.parse(await fs.readFile(recordPath, 'utf8')), [
				['exec', '--json', 'status'],
				['--remote', 'unix:///tmp/existing.sock', 'resume', 'thread-1'],
				['resume', '--remote', 'unix:///tmp/after-command.sock', 'thread-2'],
			]);
			assert.strictEqual(await fs.access(join(testRoot, 'must-not-start.sock')).then(() => true, () => false), false);
		} finally {
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});

	test('takes ownership of and cleans up an app-server whose launcher died', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		const launcherPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'codex');
		const fakeBin = join(testRoot, 'bin');
		const fakeCodexPath = join(fakeBin, 'codex');
		const socketPath = join(testRoot, 'pcx', 'pane.sock');
		const recordPath = join(testRoot, 'record.json');
		await fs.mkdir(dirname(socketPath), { recursive: true });
		await fs.mkdir(fakeBin, { recursive: true });
		await fs.writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
	const socketPath = args[2].slice('unix://'.length);
	const server = net.createServer();
	const close = () => server.close(() => process.exit(0));
	process.on('SIGTERM', close);
	server.listen(socketPath);
} else {
	fs.writeFileSync(process.env.PARADIS_TEST_TUI_RECORD, JSON.stringify(args));
}
`, { mode: 0o700 });
		const env = {
			...process.env,
			PATH: `${dirname(launcherPath)}:${fakeBin}:${process.env['PATH'] ?? ''}`,
			PARA_CODE_CODEX_LAUNCHER_DIR: dirname(launcherPath),
			PARA_CODE_CODEX_APP_SERVER_SOCKET: socketPath,
			PARADIS_TEST_TUI_RECORD: recordPath,
		};
		const staleServer = spawn(fakeCodexPath, ['app-server', '--listen', `unix://${socketPath}`], { env, stdio: 'ignore' });
		try {
			await waitForSocket(socketPath);
			await fs.writeFile(`${socketPath}.pid`, `${staleServer.pid}\n`, { mode: 0o600 });

			await execFileAsync(launcherPath, [], { env, timeout: 15_000 });
			await new Promise(resolve => setTimeout(resolve, 50));

			assert.strictEqual(processIsAlive(staleServer.pid!), false);
			assert.strictEqual(await fs.access(socketPath).then(() => true, () => false), false);
		} finally {
			staleServer.kill('SIGKILL');
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});
});
