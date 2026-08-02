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

// Records every invocation except the pane app-server the launcher starts itself, and answers
// `completion bash` with the dispatch table Codex generates — the table the launcher reads to
// find out which names are subcommands. PARADIS_TEST_COMPLETION_NAMES lists the names it knows.
const FAKE_CODEX_WITH_COMPLETION = `#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const args = process.argv.slice(2);
if (args[0] === 'app-server' && args[1] === '--listen') {
	const server = net.createServer(socket => socket.end());
	const close = () => server.close(() => process.exit(0));
	process.on('SIGTERM', close);
	process.on('SIGINT', close);
	server.listen(args[2].slice('unix://'.length));
} else {
	fs.appendFileSync(process.env.PARADIS_TEST_TUI_RECORD, JSON.stringify(args) + '\\n');
	if (args[0] === 'completion') {
		const names = (process.env.PARADIS_TEST_COMPLETION_NAMES || '').split(' ').filter(name => name.length > 0);
		process.stdout.write(names.map(name => '            codex,' + name + ')\\n                cmd="codex__' + name + '"\\n                ;;\\n').join(''));
	}
}
`;

async function readRecords(recordPath: string): Promise<string[][]> {
	const contents = await fs.readFile(recordPath, 'utf8');
	return contents.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as string[]);
}

async function readLastRecord(recordPath: string): Promise<string[]> {
	const records = await readRecords(recordPath);
	assert.ok(records.length > 0, `the fake Codex was never invoked (${recordPath})`);
	return records[records.length - 1];
}

async function countCompletionProbes(recordPath: string): Promise<number> {
	return (await readRecords(recordPath)).filter(record => record[0] === 'completion').length;
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

	// The launcher is on every Para Code terminal's PATH with no way to bypass it, and `resume`
	// is not a delegated command, so exiting when the app-server cannot start would leave the
	// user unable to run Codex at all. Field reports of a broken Codex state directory produced
	// exactly that. The app-server's log must survive: it is the only record of the cause.
	test('falls back to the unmanaged Codex when the app-server cannot start', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		try {
			const launcherPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'codex');
			const fakeBin = join(testRoot, 'bin');
			const fakeCodexPath = join(fakeBin, 'codex');
			const socketPath = join(testRoot, 'pcx', 'pane.sock');
			const recordPath = join(testRoot, 'record.json');
			await fs.mkdir(fakeBin, { recursive: true });
			await fs.writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
	process.stderr.write('Error: failed to initialize sqlite state runtime under /fake/.codex\\n');
	process.exit(3);
}
fs.writeFileSync(process.env.PARADIS_TEST_TUI_RECORD, JSON.stringify(args));
`, { mode: 0o700 });
			const env = {
				...process.env,
				PATH: `${dirname(launcherPath)}:${fakeBin}:${process.env['PATH'] ?? ''}`,
				PARA_CODE_CODEX_LAUNCHER_DIR: dirname(launcherPath),
				PARA_CODE_CODEX_APP_SERVER_SOCKET: socketPath,
				PARADIS_TEST_TUI_RECORD: recordPath,
			};
			const { stderr } = await execFileAsync(launcherPath, ['resume', 'thread-1'], { env, timeout: 15_000 });

			assert.deepStrictEqual({
				tuiArgs: JSON.parse(await fs.readFile(recordPath, 'utf8')),
				warned: stderr.includes('without the pane app-server'),
				log: await fs.readFile(`${socketPath}.log`, 'utf8'),
				socketLeft: await fs.access(socketPath).then(() => true, () => false),
				pidLeft: await fs.access(`${socketPath}.pid`).then(() => true, () => false),
			}, {
				tuiArgs: ['resume', 'thread-1'],
				warned: true,
				log: 'Error: failed to initialize sqlite state runtime under /fake/.codex\n',
				socketLeft: false,
				pidLeft: false,
			});
		} finally {
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});

	// Codex rejects `--remote` for anything but the interactive TUI ("only supported for
	// interactive TUI commands"), so a subcommand the launcher fails to recognize is treated as
	// a prompt and stops working entirely — `codex plugin` broke in the field exactly this way.
	// The invocations below are Codex 0.146's full set, aliases and the subcommands hidden from
	// `codex --help` included.
	test('delegates every Codex subcommand and keeps only TUI invocations pane-managed', async function () {
		this.timeout(60_000);
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		try {
			const launcherPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'codex');
			const fakeBin = join(testRoot, 'bin');
			const socketPath = join(testRoot, 'pcx', 'pane.sock');
			const recordPath = join(testRoot, 'record.json');
			await fs.mkdir(fakeBin, { recursive: true });
			await fs.writeFile(join(fakeBin, 'codex'), FAKE_CODEX_WITH_COMPLETION, { mode: 0o700 });
			const env = {
				...process.env,
				PATH: `${dirname(launcherPath)}:${fakeBin}:${process.env['PATH'] ?? ''}`,
				PARA_CODE_CODEX_LAUNCHER_DIR: dirname(launcherPath),
				PARA_CODE_CODEX_APP_SERVER_SOCKET: socketPath,
				PARADIS_TEST_TUI_RECORD: recordPath,
				PARADIS_TEST_COMPLETION_NAMES: '',
			};
			const invocations: readonly (readonly string[])[] = [
				['exec'], ['e'], ['review'], ['login'], ['logout'], ['mcp'], ['plugin'], ['mcp-server'],
				['app-server'], ['remote-control'], ['app'], ['completion'], ['update'], ['doctor'],
				['sandbox'], ['debug'], ['apply'], ['a'], ['archive'], ['delete'], ['unarchive'], ['cloud'],
				['exec-server'], ['execpolicy'], ['responses-api-proxy'], ['stdio-to-uds'], ['features'],
				['help'], ['help', 'plugin'], ['--model', 'gpt-5', 'plugin', 'list'], ['-a', 'never', 'plugin'],
				[], ['explain this repo'], ['resume'], ['fork'], ['--', 'plugin', 'list'],
			];
			const paneManaged: string[] = [];
			for (const args of invocations) {
				await fs.rm(recordPath, { force: true });
				await execFileAsync(launcherPath, args, { env, timeout: 15_000 });
				const recorded = await readLastRecord(recordPath);
				if (recorded[0] === '--remote') {
					paneManaged.push(args.join(' '));
				}
			}

			assert.deepStrictEqual(paneManaged, ['', 'explain this repo', 'resume', 'fork', '-- plugin list']);
		} finally {
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});

	// The static list cannot stay complete on its own: Codex ships subcommands regularly, and
	// every one it gains is a command Para Code silently breaks until the list catches up.
	test('asks Codex to classify a positional argument the static list does not know', async function () {
		this.timeout(20_000);
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		try {
			const launcherPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'codex');
			const fakeBin = join(testRoot, 'bin');
			const socketPath = join(testRoot, 'pcx', 'pane.sock');
			const recordPath = join(testRoot, 'record.json');
			await fs.mkdir(fakeBin, { recursive: true });
			await fs.writeFile(join(fakeBin, 'codex'), FAKE_CODEX_WITH_COMPLETION, { mode: 0o700 });
			const env = {
				...process.env,
				PATH: `${dirname(launcherPath)}:${fakeBin}:${process.env['PATH'] ?? ''}`,
				PARA_CODE_CODEX_LAUNCHER_DIR: dirname(launcherPath),
				PARA_CODE_CODEX_APP_SERVER_SOCKET: socketPath,
				PARADIS_TEST_TUI_RECORD: recordPath,
				PARADIS_TEST_COMPLETION_NAMES: 'resume fork brandnew',
			};

			await execFileAsync(launcherPath, ['brandnew', '--flag'], { env, timeout: 15_000 });
			const newSubcommand = await readLastRecord(recordPath);
			const probesAfterFirstRun = await countCompletionProbes(recordPath);
			await fs.rm(recordPath, { force: true });
			await execFileAsync(launcherPath, ['brandnew', '--flag'], { env, timeout: 15_000 });
			const cachedRun = await readLastRecord(recordPath);
			const probesAfterSecondRun = await countCompletionProbes(recordPath);
			await fs.rm(recordPath, { force: true });
			await execFileAsync(launcherPath, ['a prompt Codex does not know'], { env, timeout: 15_000 });
			const prompt = await readLastRecord(recordPath);

			assert.deepStrictEqual({
				newSubcommand, probesAfterFirstRun, cachedRun, probesAfterSecondRun,
				promptStaysPaneManaged: prompt[0] === '--remote',
				cached: await fs.access(join(testRoot, 'pcx', 'codex-commands.cache')).then(() => true, () => false),
			}, {
				newSubcommand: ['brandnew', '--flag'],
				probesAfterFirstRun: 1,
				cachedRun: ['brandnew', '--flag'],
				probesAfterSecondRun: 0,
				promptStaysPaneManaged: true,
				cached: true,
			});
		} finally {
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});

	// The same classification lives in three implementations (this launcher, the Windows one,
	// and the mobile relay's command parser) because a shell script cannot share code with
	// TypeScript. Only the POSIX list was left behind when `plugin` and friends were added,
	// which is what broke `codex plugin`; keep the three from drifting again.
	test('keeps the delegated-command list identical across all three implementations', async () => {
		const posix = await fs.readFile(join(process.cwd(), 'resources', 'paradis', 'bin', 'codex'), 'utf8');
		const windows = await fs.readFile(join(process.cwd(), 'resources', 'paradis', 'bin', 'paradisCodexPaneLauncher.cjs'), 'utf8');
		const relay = await fs.readFile(join(process.cwd(), 'src', 'vs', 'paradis', 'contrib', 'mobileRelay', 'common', 'paradisAgentCliCommand.ts'), 'utf8');

		const posixNames = /\n\t\t([a-z][a-z0-9|_-]*)\)\n\t\t\tcommand_kind=delegated\n/.exec(posix)?.[1].split('|') ?? [];
		const windowsNames = [...(/const NON_INTERACTIVE_COMMANDS = new Set\(\[([\s\S]*?)\]\);/.exec(windows)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1]);
		const relayNames = [...(/const codexNonInteractiveCommands = new Set\(\[([^\]]*)\]\);/.exec(relay)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1]);

		assert.deepStrictEqual({ windowsNames: [...windowsNames].sort(), relayNames: [...relayNames].sort() }, {
			windowsNames: [...posixNames].sort(),
			relayNames: [...posixNames].sort(),
		});
		assert.ok(posixNames.includes('plugin'), 'the delegated-command list was not parsed');
	});

	// A launcher that runs outside a Para Code terminal (a leaked PATH entry, a detached shell)
	// has no pane socket to manage; it must still run Codex rather than refusing to start.
	test('falls back when the pane socket environment is missing', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		try {
			const launcherPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'codex');
			const fakeBin = join(testRoot, 'bin');
			const recordPath = join(testRoot, 'record.json');
			await fs.mkdir(fakeBin, { recursive: true });
			await fs.writeFile(join(fakeBin, 'codex'), `#!/usr/bin/env node
require('fs').writeFileSync(process.env.PARADIS_TEST_TUI_RECORD, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });
			const env = {
				...process.env,
				PATH: `${dirname(launcherPath)}:${fakeBin}:${process.env['PATH'] ?? ''}`,
				PARA_CODE_CODEX_LAUNCHER_DIR: dirname(launcherPath),
				PARA_CODE_CODEX_APP_SERVER_SOCKET: '',
				PARADIS_TEST_TUI_RECORD: recordPath,
			};
			const { stderr } = await execFileAsync(launcherPath, ['resume', 'thread-2'], { env, timeout: 15_000 });

			assert.deepStrictEqual({
				tuiArgs: JSON.parse(await fs.readFile(recordPath, 'utf8')),
				warned: stderr.includes('without the pane app-server'),
			}, { tuiArgs: ['resume', 'thread-2'], warned: true });
		} finally {
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});
});
