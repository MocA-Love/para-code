/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { constants as fsConstants, promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { PassThrough } from 'stream';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisMcpSetupCommandResult,
	ParadisMcpSetupController,
	runParadisMcpSetupCommand,
} from '../../node/paradisMcpSetup.js';
import { paradisClaudeMcpEntryNeedsToolTimeout } from '../../common/paradisMcpConfigStatus.js';

/** para-browser MCP サーバーの番号。設定に書き込まれる宛先になる。 */
const PORT = 47286;

class FakeChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killCount = 0;
	readonly killSignals: (NodeJS.Signals | number | undefined)[] = [];

	constructor(readonly pid?: number, private readonly closeOnKill = true) {
		super();
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killCount++;
		this.killSignals.push(signal);
		if (this.closeOnKill) {
			this.emit('close', 0, null);
		}
		return true;
	}
}

suite('Para Browser MCP setup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs an executable with exact argv, shell disabled, and bounded combined output', async () => {
		const child = new FakeChild();
		let captured: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
		const promise = runParadisMcpSetupCommand('/bin/claude', ['one', 'two'], { PATH: '/safe' }, {
			maxOutputBytes: 8,
			timeoutMs: 1000,
			spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
				captured = { command, args: [...args], options };
				return child;
			}) as never,
		});
		child.stdout.write(Buffer.from('123456'));
		child.stderr.write(Buffer.from('abcdef'));
		child.emit('close', 0, null);
		const result = await promise;
		assert.deepStrictEqual(result, { kind: 'exit', code: 0, output: '123456ab' });
		assert.strictEqual(captured?.command, '/bin/claude');
		assert.deepStrictEqual(captured?.args, ['one', 'two']);
		assert.strictEqual(captured?.options.shell, false);
		assert.deepStrictEqual(captured?.options.env, { PATH: '/safe' });
		assert.strictEqual(child.listenerCount('error'), 0);
		assert.strictEqual(child.listenerCount('close'), 0);
		assert.strictEqual(child.stdout.listenerCount('data'), 0);
		assert.strictEqual(child.stderr.listenerCount('data'), 0);
		assert.strictEqual(child.stdout.destroyed, true);
		assert.strictEqual(child.stderr.destroyed, true);
	});

	test('settles timeout before kill and cleans up late process events', async () => {
		const child = new FakeChild();
		const result = await runParadisMcpSetupCommand('/bin/claude', [], {}, {
			timeoutMs: 1,
			maxOutputBytes: 16,
			spawn: (() => child) as never,
		});
		assert.strictEqual(result.kind, 'timeout');
		assert.strictEqual(child.killCount, 1);
		const snapshot = JSON.stringify(result);
		child.stdout.write('late');
		child.emit('close', 0, null);
		assert.strictEqual(JSON.stringify(result), snapshot);
		assert.strictEqual(child.listenerCount('error'), 0);
		assert.strictEqual(child.listenerCount('close'), 0);
		assert.strictEqual(child.stdout.listenerCount('data'), 0);
		assert.strictEqual(child.stderr.listenerCount('data'), 0);
	});

	test('terminates the whole process tree gracefully and forcefully after a short grace period', async () => {
		const child = new FakeChild(4242, false);
		const terminations: { readonly pid: number; readonly forceful: boolean }[] = [];
		const result = await runParadisMcpSetupCommand('/bin/claude', [], {}, {
			timeoutMs: 1,
			terminationGraceMs: 5,
			spawn: (() => child) as never,
			killProcessTree: async (pid: number, forceful: boolean) => {
				terminations.push({ pid, forceful });
			},
		});
		assert.strictEqual(result.kind, 'timeout');
		assert.deepStrictEqual(terminations, [{ pid: 4242, forceful: false }]);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual(terminations, [
			{ pid: 4242, forceful: false },
			{ pid: 4242, forceful: true },
		]);
		assert.strictEqual(child.killCount, 0);
		assert.strictEqual(child.listenerCount('error'), 0);
		assert.strictEqual(child.listenerCount('close'), 0);
		assert.strictEqual(child.stdout.listenerCount('data'), 0);
		assert.strictEqual(child.stderr.listenerCount('data'), 0);
		assert.strictEqual(child.stdout.destroyed, true);
		assert.strictEqual(child.stderr.destroyed, true);
	});

	test('cancels forceful tree termination when the process closes during the grace period', async () => {
		const child = new FakeChild(4242, false);
		const terminations: boolean[] = [];
		const result = await runParadisMcpSetupCommand('/bin/claude', [], {}, {
			timeoutMs: 1,
			terminationGraceMs: 10,
			spawn: (() => child) as never,
			killProcessTree: async (_pid: number, forceful: boolean) => {
				terminations.push(forceful);
			},
		});
		assert.strictEqual(result.kind, 'timeout');
		child.emit('close', null, 'SIGTERM');
		await new Promise(resolve => setTimeout(resolve, 25));
		assert.deepStrictEqual(terminations, [false]);
		assert.strictEqual(child.listenerCount('error'), 0);
		assert.strictEqual(child.listenerCount('close'), 0);
	});

	test('falls back to child signals when process-tree termination fails', async () => {
		const child = new FakeChild(4242, false);
		const result = await runParadisMcpSetupCommand('/bin/claude', [], {}, {
			platform: 'darwin',
			timeoutMs: 1,
			terminationGraceMs: 5,
			spawn: (() => child) as never,
			killProcessTree: async () => { throw new Error('tree helper secret'); },
		});
		assert.strictEqual(result.kind, 'timeout');
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
		assert.strictEqual(child.listenerCount('error'), 0);
		assert.strictEqual(child.listenerCount('close'), 0);
	});

	test('keeps the Windows root alive for forceful tree termination when graceful taskkill fails', async () => {
		const child = new FakeChild(4242, false);
		const terminations: boolean[] = [];
		const result = await runParadisMcpSetupCommand('C:\\claude.exe', [], {}, {
			platform: 'win32',
			timeoutMs: 1,
			terminationGraceMs: 10,
			spawn: (() => child) as never,
			killProcessTree: async (_pid: number, forceful: boolean) => {
				terminations.push(forceful);
				throw new Error('taskkill unavailable');
			},
		});
		assert.strictEqual(result.kind, 'timeout');
		await Promise.resolve();
		assert.deepStrictEqual(child.killSignals, []);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual(terminations, [false, true]);
		assert.deepStrictEqual(child.killSignals, ['SIGKILL']);
	});

	test('treats null close and spawn errors as failures, never success', async () => {
		const child = new FakeChild();
		const nullClose = runParadisMcpSetupCommand('/bin/claude', [], {}, { spawn: (() => child) as never });
		child.emit('close', null, 'SIGTERM');
		assert.strictEqual((await nullClose).kind, 'failure');
		assert.strictEqual(child.listenerCount('error'), 0);
		assert.strictEqual(child.listenerCount('close'), 0);
		const spawnError = await runParadisMcpSetupCommand('/missing', [], {}, {
			spawn: (() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }) as never,
		});
		assert.deepStrictEqual(spawnError, { kind: 'unavailable', output: '' });
	});

	test('keeps the first terminal process event and cleans listeners after close', async () => {
		const errorFirstChild = new FakeChild();
		const errorFirstPromise = runParadisMcpSetupCommand('/bin/claude', [], {}, { spawn: (() => errorFirstChild) as never });
		errorFirstChild.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' }));
		errorFirstChild.emit('close', 0, null);
		assert.strictEqual((await errorFirstPromise).kind, 'failure');

		const closeFirstChild = new FakeChild();
		const closeFirstPromise = runParadisMcpSetupCommand('/bin/claude', [], {}, { spawn: (() => closeFirstChild) as never });
		closeFirstChild.emit('close', 9, null);
		assert.deepStrictEqual(await closeFirstPromise, { kind: 'exit', code: 9, output: '' });
		assert.strictEqual(closeFirstChild.listenerCount('error'), 0);
		assert.strictEqual(closeFirstChild.listenerCount('close'), 0);
	});

	// ヘッダーの `${…}` を展開するのは Claude Code 自身。ここで展開されたり、シェル経由で
	// コマンド置換として解釈されたりすると、ペインのトークンが渡らなくなる。
	test('Claude setup passes the unexpanded header as one argv without a shell', async () => {
		const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
		const controller = new ParadisMcpSetupController({
			platform: 'darwin',
			resolveShellEnv: async () => ({ PATH: '/safe' }),
			findExecutable: async () => '/safe/claude',
			runCommand: async (command, args, env): Promise<IParadisMcpSetupCommandResult> => {
				calls.push({ command, args: [...args], env });
				return { kind: 'exit', code: 0, output: '' };
			},
			codexHome: '/unused',
			log: () => undefined,
		});
		const result = await controller.setup('claude', PORT);
		assert.strictEqual(result.cliAvailable, true);
		assert.deepStrictEqual(calls, [{
			command: '/safe/claude',
			args: ['mcp', 'add-json', '-s', 'user', 'para-browser', JSON.stringify({
				type: 'http',
				url: `http://127.0.0.1:${PORT}/`,
				headers: { Authorization: 'Bearer ${PARA_CODE_TERMINAL_PANE_ID}' },
				timeout: 300000,
			})],
			env: { PATH: '/safe' },
		}]);
	});

	test('Claude setup replaces an existing entry and falls back to mcp add on a CLI without add-json', async () => {
		const run = async (answers: Record<string, IParadisMcpSetupCommandResult>) => {
			const calls: string[] = [];
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => '/safe/claude',
				runCommand: async (_command, args): Promise<IParadisMcpSetupCommandResult> => {
					const key = args.slice(0, 2).join(' ');
					calls.push(key);
					const answer = answers[`${key}#${calls.filter(call => call === key).length}`] ?? answers[key];
					return answer ?? { kind: 'exit', code: 0, output: '' };
				},
				codexHome: '/unused',
				claudeConfigJsonPath: join(tmpdir(), 'paradis-mcp-missing-dir', '.claude.json'),
				log: () => undefined,
			});
			return { outcome: (await controller.setup('claude', PORT)).servers[0]?.outcome, calls };
		};
		assert.deepStrictEqual({
			replaced: await run({ 'mcp add-json#1': { kind: 'exit', code: 1, output: 'MCP server para-browser already exists in user config' } }),
			legacy: await run({ 'mcp add-json': { kind: 'exit', code: 1, output: 'error: unknown command \'add-json\'' } }),
			removeFailed: await run({
				'mcp add-json': { kind: 'exit', code: 1, output: 'MCP server para-browser already exists in user config' },
				'mcp remove': { kind: 'exit', code: 1, output: 'permission denied' },
			}),
		}, {
			replaced: { outcome: 'success', calls: ['mcp add-json', 'mcp remove', 'mcp add-json'] },
			legacy: { outcome: 'success', calls: ['mcp add-json', 'mcp add'] },
			removeFailed: { outcome: 'error', calls: ['mcp add-json', 'mcp remove'] },
		});
	});

	test('Claude setup puts the original entry back when the re-add after remove fails, and reports a lost entry', async () => {
		const original = { type: 'http', url: 'http://127.0.0.1:1111/', headers: { Authorization: 'Bearer ${PARA_CODE_TERMINAL_PANE_ID}' } };
		const run = async (answers: Record<string, IParadisMcpSetupCommandResult>) => {
			const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-restore-'));
			try {
				const claudeJson = join(directory, '.claude.json');
				const write = (entry: unknown) => fs.writeFile(claudeJson, JSON.stringify({ projects: {}, mcpServers: entry === undefined ? {} : { 'para-browser': entry } }));
				await write(original);
				const calls: string[] = [];
				const logs: string[] = [];
				// claude のふり: add-json は無ければ書き、あれば already exists。remove は消す。答えを決めた回だけ何もしない。
				const controller = new ParadisMcpSetupController({
					platform: 'darwin',
					resolveShellEnv: async () => ({}),
					findExecutable: async () => '/safe/claude',
					runCommand: async (_command, args): Promise<IParadisMcpSetupCommandResult> => {
						const key = args.slice(0, 2).join(' ');
						calls.push(key);
						const answer = answers[`${key}#${calls.filter(call => call === key).length}`];
						if (answer !== undefined) {
							return answer;
						}
						const current = JSON.parse(await fs.readFile(claudeJson, 'utf8')).mcpServers['para-browser'];
						if (key === 'mcp remove') {
							await write(undefined);
							return { kind: 'exit', code: 0, output: '' };
						}
						if (current !== undefined) {
							return { kind: 'exit', code: 1, output: 'MCP server para-browser already exists in user config' };
						}
						await write(JSON.parse(args[5]));
						return { kind: 'exit', code: 0, output: '' };
					},
					codexHome: '/unused',
					claudeConfigJsonPath: claudeJson,
					log: message => logs.push(message),
				});
				const outcome = (await controller.setup('claude', PORT)).servers[0]?.outcome;
				const entry = JSON.parse(await fs.readFile(claudeJson, 'utf8')).mcpServers['para-browser'];
				return { outcome, calls, entry, logs };
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		};
		assert.deepStrictEqual({
			restored: await run({ 'mcp add-json#2': { kind: 'timeout', output: '' }, 'mcp add#1': { kind: 'timeout', output: '' } }),
			lost: await run({ 'mcp add-json#2': { kind: 'timeout', output: '' }, 'mcp add-json#3': { kind: 'failure', output: '' }, 'mcp add#1': { kind: 'failure', output: '' } }),
		}, {
			restored: {
				outcome: 'error',
				calls: ['mcp add-json', 'mcp remove', 'mcp add-json', 'mcp add-json'],
				entry: original,
				logs: ['Claude MCP registration failed'],
			},
			lost: {
				outcome: 'error',
				calls: ['mcp add-json', 'mcp remove', 'mcp add-json', 'mcp add-json', 'mcp add'],
				entry: undefined,
				logs: ['Claude MCP entry was lost while re-registering', 'Claude MCP registration failed'],
			},
		});
	});

	test('Claude setup puts the entry back when remove times out after removing it, and never removes without a backup read', async () => {
		const original = { type: 'http', url: 'http://127.0.0.1:1111/', headers: { Authorization: 'Bearer ${PARA_CODE_TERMINAL_PANE_ID}' } };
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-remove-timeout-'));
		try {
			const claudeJson = join(directory, '.claude.json');
			const write = (entry: unknown) => fs.writeFile(claudeJson, JSON.stringify({ mcpServers: entry === undefined ? {} : { 'para-browser': entry } }));
			await write(original);
			const calls: string[] = [];
			const restoredWith: unknown[] = [];
			const fakeClaude = async (args: readonly string[]): Promise<IParadisMcpSetupCommandResult> => {
				const key = args.slice(0, 2).join(' ');
				calls.push(key);
				if (key === 'mcp remove') {
					// It did remove the entry, but the runner gave up waiting.
					await write(undefined);
					return { kind: 'timeout', output: '' };
				}
				const current = JSON.parse(await fs.readFile(claudeJson, 'utf8')).mcpServers['para-browser'];
				if (current !== undefined) {
					return { kind: 'exit', code: 1, output: 'MCP server para-browser already exists in user config' };
				}
				restoredWith.push(JSON.parse(args[5]));
				await write(JSON.parse(args[5]));
				return { kind: 'exit', code: 0, output: '' };
			};
			const controller = (claudeConfigJsonPath: string) => new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => '/safe/claude',
				runCommand: (_command, args) => fakeClaude(args),
				codexHome: '/unused',
				claudeConfigJsonPath,
				log: () => undefined,
			});
			const timedOut = (await controller(claudeJson).setup('claude', PORT)).servers[0]?.outcome;
			const afterTimeout = { calls: [...calls], restoredWith: [...restoredWith], entry: JSON.parse(await fs.readFile(claudeJson, 'utf8')).mcpServers['para-browser'] };
			calls.length = 0;
			// The backup cannot be read (the path is a directory): the entry is not removed at all.
			const unreadableServer = (await controller(directory).setup('claude', PORT)).servers[0];
			const unreadable = { outcome: unreadableServer?.outcome, detail: unreadableServer?.detail };
			assert.deepStrictEqual({ timedOut, afterTimeout, unreadable, unreadableCalls: calls }, {
				timedOut: 'error',
				afterTimeout: { calls: ['mcp add-json', 'mcp remove', 'mcp add-json'], restoredWith: [original], entry: original },
				// The reason is shown, not just the generic failure.
				unreadable: {
					outcome: 'error',
					detail: `Automatic setup could not register the MCP server. The existing para-browser entry in ${directory} could not be read to keep a copy before replacing it (Configuration is not a regular file), so it was left as it is.`,
				},
				unreadableCalls: ['mcp add-json'],
			});
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('a button press that joined a failed startup upgrade runs once more, this time allowed to fall back to mcp add', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-join-'));
		try {
			const claudeJson = join(directory, '.claude.json');
			await fs.writeFile(claudeJson, JSON.stringify({ mcpServers: { 'para-browser': { type: 'http', url: `http://127.0.0.1:${PORT}/` } } }));
			const calls: string[] = [];
			let release!: () => void;
			const released = new Promise<void>(resolve => release = resolve);
			let started!: () => void;
			const firstCall = new Promise<void>(resolve => started = resolve);
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => '/safe/claude',
				runCommand: async (_command, args): Promise<IParadisMcpSetupCommandResult> => {
					const key = args.slice(0, 2).join(' ');
					calls.push(key);
					if (calls.length === 1) {
						started();
						await released;
					}
					// A CLI without add-json; the old form works.
					return key === 'mcp add-json' ? { kind: 'exit', code: 1, output: 'error: unknown command \'add-json\'' } : { kind: 'exit', code: 0, output: '' };
				},
				codexHome: join(directory, 'missing-codex'),
				claudeConfigJsonPath: claudeJson,
				log: () => undefined,
			});
			const upgrade = controller.upgradeToolTimeouts(PORT);
			await firstCall;
			const button = controller.setup('claude', PORT);
			release();
			const [buttonResult] = await Promise.all([button, upgrade]);
			assert.deepStrictEqual({ calls, button: buttonResult.servers[0]?.outcome }, {
				// upgrade (no fallback), then the button's own run with the fallback
				calls: ['mcp add-json', 'mcp add-json', 'mcp add'],
				button: 'success',
			});
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('the startup upgrade shares the in-flight Claude setup with the button, and skips a relative CLAUDE_CONFIG_DIR', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-flight-'));
		try {
			const claudeJson = join(directory, '.claude.json');
			await fs.writeFile(claudeJson, JSON.stringify({ mcpServers: { 'para-browser': { type: 'http', url: `http://127.0.0.1:${PORT}/` } } }));
			const calls: string[] = [];
			let release!: () => void;
			const released = new Promise<void>(resolve => release = resolve);
			let started!: () => void;
			const firstCall = new Promise<void>(resolve => started = resolve);
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({ CLAUDE_CONFIG_DIR: directory }),
				findExecutable: async () => '/safe/claude',
				runCommand: async (_command, args): Promise<IParadisMcpSetupCommandResult> => {
					calls.push(args.slice(0, 2).join(' '));
					started();
					await released;
					return { kind: 'exit', code: 0, output: '' };
				},
				codexHome: join(directory, 'missing-codex'),
				log: () => undefined,
			});
			const upgrade = controller.upgradeToolTimeouts(PORT);
			await firstCall;
			const button = controller.setup('claude', PORT);
			release();
			const [buttonResult] = await Promise.all([button, upgrade]);

			const relative = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({ CLAUDE_CONFIG_DIR: '~/.claude-alt' }),
				findExecutable: async () => '/safe/claude',
				runCommand: async (_command, args): Promise<IParadisMcpSetupCommandResult> => {
					calls.push(`relative ${args.slice(0, 2).join(' ')}`);
					return { kind: 'exit', code: 0, output: '' };
				},
				codexHome: join(directory, 'missing-codex'),
				log: () => undefined,
			});
			await relative.upgradeToolTimeouts(PORT);
			const relativeStatus = (await relative.status(PORT)).claude;
			assert.deepStrictEqual({ calls, button: buttonResult.servers[0]?.outcome, relativeStatus }, {
				calls: ['mcp add-json'],
				button: 'success',
				relativeStatus: { cli: 'claude', state: 'unconfigured', failed: true },
			});
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('upgrades our current-port registrations once per file and port, adding only the Codex timeout line', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-timeout-'));
		try {
			const claudeDir = join(directory, 'claude-config');
			const claudeJson = join(claudeDir, '.claude.json');
			const codexHome = join(directory, 'codex');
			await fs.mkdir(codexHome);
			await fs.mkdir(claudeDir);
			await fs.writeFile(claudeJson, JSON.stringify({ mcpServers: { 'para-browser': { type: 'http', url: `http://127.0.0.1:${PORT}/` } } }));
			const codexOriginal = [
				'[mcp_servers.para-browser]',
				`url = "http://127.0.0.1:${PORT}/"`,
				'bearer_token_env_var = "PARA_CODE_TERMINAL_PANE_ID"',
				'enabled = false',
				'',
				'[mcp_servers.other]',
				'command = "keep"',
				'',
			].join('\n');
			await fs.writeFile(join(codexHome, 'config.toml'), codexOriginal);
			const commands: string[] = [];
			const create = () => new ParadisMcpSetupController({
				platform: 'darwin',
				// claudeConfigJsonPath を渡さないときは、シェルの環境の CLAUDE_CONFIG_DIR の下を見る。
				resolveShellEnv: async () => ({ CLAUDE_CONFIG_DIR: claudeDir }),
				findExecutable: async () => '/safe/claude',
				runCommand: async (_command, args): Promise<IParadisMcpSetupCommandResult> => {
					commands.push(args.slice(0, 2).join(' '));
					// timeout を付けられない古い CLI
					return { kind: 'exit', code: 1, output: 'error: unknown command \'add-json\'' };
				},
				codexHome,
				upgradeMarkerPath: join(directory, 'marker.json'),
				log: () => undefined,
			});
			await create().upgradeToolTimeouts(PORT);
			const codexAfter = await fs.readFile(join(codexHome, 'config.toml'), 'utf8');
			// 次の起動（別のインスタンス）では、同じファイルとポートの組を試さない。
			await create().upgradeToolTimeouts(PORT);
			assert.deepStrictEqual({ commands, codexAfter }, {
				// 旧形式の `mcp add` には戻さない
				commands: ['mcp add-json'],
				codexAfter: [
					'[mcp_servers.para-browser]',
					`url = "http://127.0.0.1:${PORT}/"`,
					'bearer_token_env_var = "PARA_CODE_TERMINAL_PANE_ID"',
					'enabled = false',
					'tool_timeout_sec = 300',
					'',
					'[mcp_servers.other]',
					'command = "keep"',
					'',
				].join('\n'),
			});
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('a Claude entry is upgraded only when it has no timeout at all', () => {
		const entry = (extra: object) => JSON.stringify({ mcpServers: { 'para-browser': { type: 'http', url: `http://127.0.0.1:${PORT}/`, ...extra } } });
		assert.deepStrictEqual({
			missing: paradisClaudeMcpEntryNeedsToolTimeout(entry({}), PORT),
			userShort: paradisClaudeMcpEntryNeedsToolTimeout(entry({ timeout: 10_000 }), PORT),
			otherPort: paradisClaudeMcpEntryNeedsToolTimeout(entry({}), PORT + 1),
		}, { missing: true, userShort: false, otherPort: false });
	});

	test('Claude setup contains rejected runners and does not trust failure output as already configured', async () => {
		let result: IParadisMcpSetupCommandResult | Promise<IParadisMcpSetupCommandResult> = Promise.reject(new Error('raw secret'));
		const logs: { readonly message: string; readonly error?: unknown }[] = [];
		const controller = new ParadisMcpSetupController({
			platform: 'darwin',
			resolveShellEnv: async () => ({ PATH: '/safe' }),
			findExecutable: async () => '/safe/claude',
			runCommand: () => Promise.resolve(result),
			codexHome: '/unused',
			log: (message, error) => logs.push({ message, error }),
		});
		const rejected = await controller.setup('claude', PORT);
		assert.strictEqual(rejected.servers[0].outcome, 'error');
		assert.strictEqual(rejected.servers[0].detail?.includes('raw secret'), false);
		assert.deepStrictEqual(logs, [{ message: 'Claude MCP runner failed', error: undefined }]);
		result = { kind: 'timeout', output: 'already exists' };
		const timedOut = await controller.setup('claude', PORT);
		assert.strictEqual(timedOut.servers[0].outcome, 'error');
	});

	test('Windows accepts npm script shims because the runner wraps them in cmd.exe', async () => {
		let runCount = 0;
		const controller = new ParadisMcpSetupController({
			platform: 'win32',
			resolveShellEnv: async () => ({ PATH: 'C:\\bin' }),
			findExecutable: async () => 'C:\\bin\\claude.cmd',
			runCommand: async () => { runCount++; return { kind: 'exit', code: 0, output: '' }; },
			codexHome: 'C:\\unused',
			log: () => undefined,
		});
		const result = await controller.setup('claude', PORT);
		assert.strictEqual(result.cliAvailable, true);
		assert.strictEqual(result.servers[0].outcome, 'success');
		assert.strictEqual(runCount, 1);
	});

	test('Windows still rejects executables without a spawnable extension', async () => {
		let runCount = 0;
		const controller = new ParadisMcpSetupController({
			platform: 'win32',
			resolveShellEnv: async () => ({ PATH: 'C:\\bin' }),
			findExecutable: async () => 'C:\\bin\\claude',
			runCommand: async () => { runCount++; return { kind: 'exit', code: 0, output: '' }; },
			codexHome: 'C:\\unused',
			log: () => undefined,
		});
		assert.deepStrictEqual(await controller.setup('claude', PORT), { cli: 'claude', cliAvailable: false, servers: [] });
		assert.strictEqual(runCount, 0);
	});

	test('wraps Windows script shims into a single verbatim cmd.exe invocation', async () => {
		const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
		const child = new FakeChild();
		const promise = runParadisMcpSetupCommand('C:\\Program Files\\nodejs\\claude.cmd', ['mcp', 'add'], {}, {
			platform: 'win32',
			spawn: (command, args, options) => {
				calls.push({ command, args: [...args], options: { ...options } });
				return child;
			},
		});
		child.emit('close', 0, null);
		await promise;
		assert.deepStrictEqual(calls[0].command, 'cmd.exe');
		assert.deepStrictEqual(calls[0].args, ['/d', '/s', '/v:off', '/c', '""C:\\Program Files\\nodejs\\claude.cmd" mcp add"']);
		assert.strictEqual(calls[0].options.windowsVerbatimArguments, true);
	});

	test('does not wrap non-shim executables on Windows', async () => {
		const calls: { command: string; args: readonly string[] }[] = [];
		const child = new FakeChild();
		const promise = runParadisMcpSetupCommand('C:\\bin\\claude.exe', ['mcp', 'add'], {}, {
			platform: 'win32',
			spawn: (command, args) => {
				calls.push({ command, args: [...args] });
				return child;
			},
		});
		child.emit('close', 0, null);
		await promise;
		assert.deepStrictEqual(calls, [{ command: 'C:\\bin\\claude.exe', args: ['mcp', 'add'] }]);
	});

	test('coalesces concurrent setup attempts per CLI', async () => {
		let release: ((result: IParadisMcpSetupCommandResult) => void) | undefined;
		let runCount = 0;
		const controller = new ParadisMcpSetupController({
			platform: 'darwin',
			resolveShellEnv: async () => ({ PATH: '/safe' }),
			findExecutable: async () => '/safe/claude',
			runCommand: () => {
				runCount++;
				return new Promise(resolve => { release = resolve; });
			},
			codexHome: '/unused',
			log: () => undefined,
		});
		const first = controller.setup('claude', PORT);
		const second = controller.setup('claude', PORT);
		assert.strictEqual(first, second);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(runCount, 1);
		release?.({ kind: 'exit', code: 0, output: '' });
		await Promise.all([first, second]);
	});

	test('Codex setup writes encoded TOML atomically and recognizes equivalent existing sections', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-setup-'));
		try {
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
			});
			const first = await controller.setup('codex', PORT);
			assert.strictEqual(first.servers[0].outcome, 'success');
			const configPath = join(directory, 'config.toml');
			const content = await fs.readFile(configPath, 'utf8');
			assert.match(content, new RegExp(`url = "http://127\\.0\\.0\\.1:${PORT}/"`));
			assert.strictEqual(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(content), false);

			await fs.writeFile(configPath, '[ mcp_servers . "para-browser" ] # existing\ncommand = "custom"\n');
			const second = await controller.setup('codex', PORT);
			assert.strictEqual(second.servers[0].outcome, 'already');
			assert.strictEqual(await fs.readFile(configPath, 'utf8'), '[ mcp_servers . "para-browser" ] # existing\ncommand = "custom"\n');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('Codex atomic replacement preserves an existing regular file mode', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-mode-'));
		try {
			const configPath = join(directory, 'config.toml');
			await fs.writeFile(configPath, 'model = "test"\n');
			await fs.chmod(configPath, 0o666);
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
			});
			assert.strictEqual((await controller.setup('codex', PORT)).servers[0].outcome, 'success');
			assert.strictEqual((await fs.stat(configPath)).mode & 0o777, 0o666);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('Codex setup fails closed on ambiguous or unreadable config without returning raw errors', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-setup-'));
		try {
			const configPath = join(directory, 'config.toml');
			await fs.writeFile(configPath, '[mcp_servers]\npara-browser = { command = "custom" }\n');
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
			});
			const result = await controller.setup('codex', PORT);
			assert.strictEqual(result.servers[0].outcome, 'error');
			assert.strictEqual(result.servers[0].detail?.includes('para-browser'), false);
			assert.strictEqual(await fs.readFile(configPath, 'utf8'), '[mcp_servers]\npara-browser = { command = "custom" }\n');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('Codex setup does not replace a symlinked config', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-symlink-'));
		try {
			const target = join(directory, 'target.toml');
			const configPath = join(directory, 'config.toml');
			await fs.writeFile(target, 'model = "custom"\n');
			await fs.symlink(target, configPath);
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
			});
			assert.strictEqual((await controller.setup('codex', PORT)).servers[0].outcome, 'error');
			assert.strictEqual((await fs.lstat(configPath)).isSymbolicLink(), true);
			assert.strictEqual(await fs.readFile(target, 'utf8'), 'model = "custom"\n');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('Codex setup rejects an oversized config without reading or replacing it', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-oversized-'));
		try {
			const configPath = join(directory, 'config.toml');
			const original = Buffer.alloc((1024 * 1024) + 1, 0x61);
			await fs.writeFile(configPath, original);
			let readCount = 0;
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
				configReadFileSystem: {
					lstat: (path: string) => fs.lstat(path),
					open: (path: string, flags: number) => fs.open(path, flags),
					read: async (handle: FileHandle, buffer: Buffer, offset: number, length: number, position: number) => {
						readCount++;
						return handle.read(buffer, offset, length, position);
					},
				},
			});
			assert.strictEqual((await controller.setup('codex', PORT)).servers[0].outcome, 'error');
			assert.strictEqual(readCount, 0);
			assert.deepStrictEqual(await fs.readFile(configPath), original);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('Codex setup fails closed when a config changes during its bounded read', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-read-race-'));
		try {
			const configPath = join(directory, 'config.toml');
			const original = Buffer.from('model = "private-model"\n', 'utf8');
			await fs.writeFile(configPath, original);
			let mutated = false;
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
				configReadFileSystem: {
					lstat: (path: string) => fs.lstat(path),
					open: (path: string, flags: number) => fs.open(path, flags),
					read: async (handle: FileHandle, buffer: Buffer, offset: number, length: number, position: number) => {
						const result = await handle.read(buffer, offset, length, position);
						if (!mutated) {
							mutated = true;
							await fs.appendFile(configPath, '#');
						}
						return result;
					},
				},
			});
			assert.strictEqual((await controller.setup('codex', PORT)).servers[0].outcome, 'error');
			assert.deepStrictEqual(await fs.readFile(configPath), Buffer.concat([original, Buffer.from('#')]));
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('Codex setup opens nonblocking and rejects a special file swapped in after lstat', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-special-race-'));
		try {
			const configPath = join(directory, 'config.toml');
			const original = Buffer.from('model = "safe"\n', 'utf8');
			await fs.writeFile(configPath, original);
			let openFlags: number | undefined;
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
				configReadFileSystem: {
					lstat: (path: string) => fs.lstat(path),
					open: (_path: string, flags: number) => {
						openFlags = flags;
						return fs.open(directory, flags);
					},
					read: (handle: FileHandle, buffer: Buffer, offset: number, length: number, position: number) => {
						return handle.read(buffer, offset, length, position);
					},
				},
			});
			assert.strictEqual((await controller.setup('codex', PORT)).servers[0].outcome, 'error');
			assert.strictEqual((openFlags ?? 0) & fsConstants.O_NONBLOCK, fsConstants.O_NONBLOCK);
			assert.strictEqual((openFlags ?? 0) & fsConstants.O_NOFOLLOW, fsConstants.O_NOFOLLOW);
			assert.deepStrictEqual(await fs.readFile(configPath), original);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('Codex setup rejects a special config and never logs config errors or contents', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-special-'));
		try {
			const configPath = join(directory, 'config.toml');
			await fs.mkdir(configPath);
			const logs: { readonly message: string; readonly error?: unknown }[] = [];
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: (message, error) => logs.push({ message, error }),
			});
			assert.strictEqual((await controller.setup('codex', PORT)).servers[0].outcome, 'error');
			assert.strictEqual((await fs.lstat(configPath)).isDirectory(), true);
			assert.deepStrictEqual(logs, [{ message: 'Codex MCP configuration update failed', error: undefined }]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	// ホームが増えたとき、既定のホームでセットアップ済みなら同じ節を新しいホームへ入れる。
	// 既定のホームが未設定（利用者がセットアップしていない）なら、どこにも書かない。
	test('adds the Codex MCP section to new account homes only when the default home is set up', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-homes-'));
		try {
			const primary = join(directory, '.codex');
			const second = join(directory, '.codex-2');
			await fs.mkdir(primary);
			await fs.mkdir(second);
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({ PATH: '/safe' }),
				findExecutable: async () => undefined,
				runCommand: async (): Promise<IParadisMcpSetupCommandResult> => ({ kind: 'exit', code: 0, output: '' }),
				codexHome: primary,
				additionalCodexHomes: () => [primary, second],
				log: () => undefined,
			});
			const readSecond = () => fs.readFile(join(second, 'config.toml'), 'utf8').then(text => text.includes('[mcp_servers.para-browser]'), () => false);
			await controller.propagateToCodexHomes(PORT);
			const beforeSetup = await readSecond();
			await fs.writeFile(join(primary, 'config.toml'), `[mcp_servers.para-browser]\nurl = "http://127.0.0.1:${PORT}/"\n`);
			await controller.propagateToCodexHomes(PORT);
			assert.deepStrictEqual({ beforeSetup, afterSetup: await readSecond() }, { beforeSetup: false, afterSetup: true });
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
