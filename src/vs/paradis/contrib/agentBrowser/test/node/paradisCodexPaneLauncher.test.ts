/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { dirname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const execFileAsync = promisify(execFile);

interface IFakeCodexRecord {
	readonly args: readonly string[];
	readonly paneToken?: string;
	readonly portFile?: string;
}

// Records every invocation except the pane app-server the launcher starts itself, and answers
// `completion bash` with the dispatch table Codex generates — the table the launcher reads to
// find out which names are subcommands. PARADIS_TEST_COMPLETION_NAMES lists the names it knows.
// `--version` answers the launcher's `--no-daemon` probe without being recorded; with
// PARADIS_TEST_NO_DAEMON_UNSUPPORTED=1 it rejects the flag like Codex 0.155 and older.
const FAKE_CODEX_WITH_COMPLETION = `#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const args = process.argv.slice(2);
if (args.includes('--version')) {
	process.exit(process.env.PARADIS_TEST_NO_DAEMON_UNSUPPORTED === '1' && args.includes('--no-daemon') ? 2 : 0);
} else if (args[0] === 'app-server' && args[1] === '--listen') {
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

suite('ParadisCodexPaneLauncher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// The launcher no longer starts a pane app-server or adds `--remote`: Codex rejects permission
	// overrides with `--remote resume|fork`, and the pane app-server restarted every MCP server
	// for each terminal. A socket left in the environment of a terminal opened by an older
	// Para Code must not bring that mode back.
	test('ignores a pane app-server socket and preserves interactive arguments and MCP environment', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		try {
			const launcherPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'codex');
			const fakeBin = join(testRoot, 'bin');
			const fakeCodexPath = join(fakeBin, 'codex');
			const tuiRecordPath = join(testRoot, 'tui.json');
			const socketPath = join(testRoot, 'pcx', 'pane.sock');
			const injectionMarkerPath = join(testRoot, 'must-not-exist');
			await fs.mkdir(fakeBin, { recursive: true });
			await fs.writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (!args.includes('--version')) {
	const record = { args, paneToken: process.env.PARA_CODE_TERMINAL_PANE_ID, portFile: process.env.PARA_CODE_MCP_PORT_FILE };
	fs.appendFileSync(process.env.PARADIS_TEST_TUI_RECORD, JSON.stringify(record) + '\\n');
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
					PARADIS_TEST_TUI_RECORD: tuiRecordPath,
				},
				timeout: 15_000,
			});

			const records = (await fs.readFile(tuiRecordPath, 'utf8')).split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as IFakeCodexRecord);
			assert.deepStrictEqual({
				records,
				injectionRan: await fs.access(injectionMarkerPath).then(() => true, () => false),
				runtimeCreated: await fs.access(join(testRoot, 'pcx')).then(() => true, () => false),
			}, {
				records: [{
					args: ['--no-daemon', '--model', 'gpt-5', prompt],
					paneToken: 'pane-token',
					portFile: '/tmp/paradis-browser-mcp.json',
				}],
				injectionRan: false,
				runtimeCreated: false,
			});
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
			// Codex rejects `--no-daemon` together with `--remote`: the user's own choice runs as typed.
			await execFileAsync(launcherPath, ['--no-daemon', 'resume', 'thread-3'], { env });

			assert.deepStrictEqual(JSON.parse(await fs.readFile(recordPath, 'utf8')), [
				['exec', '--json', 'status'],
				['--remote', 'unix:///tmp/existing.sock', 'resume', 'thread-1'],
				['resume', '--remote', 'unix:///tmp/after-command.sock', 'thread-2'],
				['--no-daemon', 'resume', 'thread-3'],
			]);
			assert.strictEqual(await fs.access(join(testRoot, 'must-not-start.sock')).then(() => true, () => false), false);
		} finally {
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});

	// `--no-daemon` is a TUI option, so a subcommand the launcher fails to recognize gets it and
	// may refuse to run — `codex plugin` broke in the field exactly this way (then with `--remote`).
	// The invocations below are Codex 0.146's full set, aliases and the subcommands hidden from
	// `codex --help` included.
	test('delegates every Codex subcommand and keeps only TUI invocations off the shared server', async function () {
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
				['help'], ['agents'], ['help', 'plugin'], ['--model', 'gpt-5', 'plugin', 'list'], ['-a', 'never', 'plugin'],
				[], ['explain this repo'], ['resume'], ['fork'], ['--', 'plugin', 'list'],
			];
			const paneManaged: string[] = [];
			for (const args of invocations) {
				await fs.rm(recordPath, { force: true });
				await execFileAsync(launcherPath, args, { env, timeout: 15_000 });
				const recorded = await readLastRecord(recordPath);
				if (recorded[0] === '--no-daemon') {
					paneManaged.push(args.join(' '));
				}
			}

			assert.deepStrictEqual(paneManaged, ['', 'explain this repo', 'resume', 'fork', '-- plugin list']);
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

	// With the pane app-server turned off, Para Code still puts the launcher on PATH (without a
	// pane socket) so interactive sessions stay off Codex's shared background server: that server
	// runs every pane's hooks and MCP servers with the environment of the terminal that started
	// it, and Codex attaches to a running one even with the auto-start turned off, so only
	// `--no-daemon` keeps a session embedded. Codex 0.155 and older reject that flag and get the
	// auto-start override instead. Non-interactive commands, `codex agents` (it needs the shared
	// server), explicit `--remote` sessions and a `--no-daemon` the user typed are passed through
	// unchanged.
	test('keeps interactive sessions off the shared background server when no pane socket is set', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		try {
			const launcherPath = join(process.cwd(), 'resources', 'paradis', 'bin', 'codex');
			const fakeBin = join(testRoot, 'bin');
			const recordPath = join(testRoot, 'record.json');
			await fs.mkdir(fakeBin, { recursive: true });
			await fs.writeFile(join(fakeBin, 'codex'), FAKE_CODEX_WITH_COMPLETION, { mode: 0o700 });
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PATH: `${dirname(launcherPath)}:${fakeBin}:${process.env['PATH'] ?? ''}`,
				PARA_CODE_CODEX_LAUNCHER_DIR: dirname(launcherPath),
				PARADIS_TEST_TUI_RECORD: recordPath,
				PARADIS_TEST_COMPLETION_NAMES: '',
			};
			delete env.PARA_CODE_CODEX_APP_SERVER_SOCKET;
			let stderrOutput = '';
			for (const args of [[], ['-c', 'model_reasoning_effort=high', 'a prompt'], ['exec', 'status'], ['--remote', 'unix:///tmp/other.sock'], ['agents'], ['queue', 'list'], ['--no-daemon', 'fork', 'thread-1']]) {
				stderrOutput += (await execFileAsync(launcherPath, args, { env, timeout: 15_000 })).stderr;
			}
			// An empty value is the same as no socket at all.
			stderrOutput += (await execFileAsync(launcherPath, ['resume', 'thread-2'], { env: { ...env, PARA_CODE_CODEX_APP_SERVER_SOCKET: '' }, timeout: 15_000 })).stderr;
			const olderCodex = { ...env, PARADIS_TEST_NO_DAEMON_UNSUPPORTED: '1' };
			for (const args of [[], ['resume', 'thread-3']]) {
				stderrOutput += (await execFileAsync(launcherPath, args, { env: olderCodex, timeout: 15_000 })).stderr;
			}

			assert.deepStrictEqual({ records: await readRecords(recordPath), stderrOutput }, {
				records: [
					['--no-daemon'],
					['--no-daemon', '-c', 'model_reasoning_effort=high', 'a prompt'],
					['exec', 'status'],
					['--remote', 'unix:///tmp/other.sock'],
					['agents'],
					['queue', 'list'],
					['--no-daemon', 'fork', 'thread-1'],
					['--no-daemon', 'resume', 'thread-2'],
					['-c', 'features.daemon_auto_start=false'],
					['-c', 'features.daemon_auto_start=false', 'resume', 'thread-3'],
				],
				stderrOutput: '',
			});
		} finally {
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});

	// The Windows launcher does the same with the pane app-server off (no endpoint), and when the
	// terminal has no console-subsystem node.exe, codex.cmd / codex.ps1 only ask it where the
	// user's Codex is and run that themselves. The script itself runs under Node here.
	test('keeps interactive sessions embedded in the Windows launcher and resolves the real Codex for the scripts', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-launcher-'));
		try {
			const launcherDirectory = join(process.cwd(), 'resources', 'paradis', 'bin');
			const launcherScript = join(launcherDirectory, 'paradisCodexPaneLauncher.cjs');
			const fakeBin = join(testRoot, 'bin');
			const recordPath = join(testRoot, 'record.json');
			await fs.mkdir(fakeBin, { recursive: true });
			await fs.writeFile(join(fakeBin, 'codex'), FAKE_CODEX_WITH_COMPLETION, { mode: 0o700 });
			const env: NodeJS.ProcessEnv = {
				...process.env,
				ELECTRON_RUN_AS_NODE: '1',
				PATH: `${launcherDirectory}:${fakeBin}:${process.env['PATH'] ?? ''}`,
				PARA_CODE_CODEX_LAUNCHER_DIR: launcherDirectory,
				PARADIS_TEST_TUI_RECORD: recordPath,
				PARADIS_TEST_COMPLETION_NAMES: '',
			};
			delete env.PARA_CODE_CODEX_APP_SERVER_ENDPOINT;
			delete env.PARA_CODE_CODEX_LAUNCHER_MODE;
			const run = (args: readonly string[], extra: NodeJS.ProcessEnv = {}) => execFileAsync(process.execPath, [launcherScript, ...args], { env: { ...env, ...extra }, timeout: 15_000 });
			let stderrOutput = '';
			for (const args of [[], ['a prompt'], ['resume', 'thread-1'], ['exec', 'status'], ['agents'], ['queue', 'list'], ['--remote', 'ws://127.0.0.1:1'], ['--no-daemon', 'fork', 'thread-2']]) {
				stderrOutput += (await run(args)).stderr;
			}
			stderrOutput += (await run(['resume', 'thread-3'], { PARADIS_TEST_NO_DAEMON_UNSUPPORTED: '1' })).stderr;
			const resolved = await run(['resume', 'thread-4'], { PARA_CODE_CODEX_LAUNCHER_MODE: 'resolve' });

			assert.deepStrictEqual({ records: await readRecords(recordPath), stderrOutput, resolved: resolved.stdout.trim() }, {
				records: [
					['--no-daemon'],
					['--no-daemon', 'a prompt'],
					['--no-daemon', 'resume', 'thread-1'],
					['exec', 'status'],
					['agents'],
					['queue', 'list'],
					['--remote', 'ws://127.0.0.1:1'],
					['--no-daemon', 'fork', 'thread-2'],
					['-c', 'features.daemon_auto_start=false', 'resume', 'thread-3'],
				],
				stderrOutput: '',
				resolved: join(fakeBin, 'codex'),
			});
		} finally {
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});
});
