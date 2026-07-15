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

	test('Claude setup resolves the internal shim and passes it as one argv without a shell', async () => {
		const shimPath = `/tmp/Para "Code"/'single'/$(touch marker)/\`touch marker2\`/\\path`;
		const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
		const controller = new ParadisMcpSetupController({
			platform: 'darwin',
			resolveShimPath: () => shimPath,
			resolveShellEnv: async () => ({ PATH: '/safe' }),
			findExecutable: async () => '/safe/claude',
			runCommand: async (command, args, env): Promise<IParadisMcpSetupCommandResult> => {
				calls.push({ command, args: [...args], env });
				return { kind: 'exit', code: 0, output: '' };
			},
			codexHome: '/unused',
			log: () => undefined,
		});
		const result = await controller.setup('claude');
		assert.strictEqual(result.cliAvailable, true);
		assert.deepStrictEqual(calls, [{
			command: '/safe/claude',
			args: ['mcp', 'add', '-s', 'user', 'para-browser', '--', 'node', shimPath],
			env: { PATH: '/safe' },
		}]);
	});

	test('Claude setup contains rejected runners and does not trust failure output as already configured', async () => {
		let result: IParadisMcpSetupCommandResult | Promise<IParadisMcpSetupCommandResult> = Promise.reject(new Error('raw secret'));
		const logs: { readonly message: string; readonly error?: unknown }[] = [];
		const controller = new ParadisMcpSetupController({
			platform: 'darwin',
			resolveShimPath: () => '/safe/shim.js',
			resolveShellEnv: async () => ({ PATH: '/safe' }),
			findExecutable: async () => '/safe/claude',
			runCommand: () => Promise.resolve(result),
			codexHome: '/unused',
			log: (message, error) => logs.push({ message, error }),
		});
		const rejected = await controller.setup('claude');
		assert.strictEqual(rejected.servers[0].outcome, 'error');
		assert.strictEqual(rejected.servers[0].detail?.includes('raw secret'), false);
		assert.deepStrictEqual(logs, [{ message: 'Claude MCP runner failed', error: undefined }]);
		result = { kind: 'timeout', output: 'already exists' };
		const timedOut = await controller.setup('claude');
		assert.strictEqual(timedOut.servers[0].outcome, 'error');
	});

	test('Windows refuses script shims instead of falling back to cmd.exe', async () => {
		let runCount = 0;
		const controller = new ParadisMcpSetupController({
			platform: 'win32',
			resolveShimPath: () => 'C:\\Para Code\\shim.js',
			resolveShellEnv: async () => ({ PATH: 'C:\\bin' }),
			findExecutable: async () => 'C:\\bin\\claude.cmd',
			runCommand: async () => { runCount++; return { kind: 'exit', code: 0, output: '' }; },
			codexHome: 'C:\\unused',
			log: () => undefined,
		});
		assert.deepStrictEqual(await controller.setup('claude'), { cli: 'claude', cliAvailable: false, servers: [] });
		assert.strictEqual(runCount, 0);
	});

	test('coalesces concurrent setup attempts per CLI', async () => {
		let release: ((result: IParadisMcpSetupCommandResult) => void) | undefined;
		let runCount = 0;
		const controller = new ParadisMcpSetupController({
			platform: 'darwin',
			resolveShimPath: () => '/safe/shim.js',
			resolveShellEnv: async () => ({ PATH: '/safe' }),
			findExecutable: async () => '/safe/claude',
			runCommand: () => {
				runCount++;
				return new Promise(resolve => { release = resolve; });
			},
			codexHome: '/unused',
			log: () => undefined,
		});
		const first = controller.setup('claude');
		const second = controller.setup('claude');
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
				resolveShimPath: () => 'C:\\Para "Code"\\shim\n.js',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
			});
			const first = await controller.setup('codex');
			assert.strictEqual(first.servers[0].outcome, 'success');
			const configPath = join(directory, 'config.toml');
			const content = await fs.readFile(configPath, 'utf8');
			assert.match(content, /args = \["C:\\\\Para \\"Code\\"\\\\shim\\n\.js"\]/);
			assert.strictEqual(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(content), false);

			await fs.writeFile(configPath, '[ mcp_servers . "para-browser" ] # existing\ncommand = "custom"\n');
			const second = await controller.setup('codex');
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
				resolveShimPath: () => '/safe/shim.js',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
			});
			assert.strictEqual((await controller.setup('codex')).servers[0].outcome, 'success');
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
				resolveShimPath: () => '/safe/shim.js',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
			});
			const result = await controller.setup('codex');
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
				resolveShimPath: () => '/safe/shim.js',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: () => undefined,
			});
			assert.strictEqual((await controller.setup('codex')).servers[0].outcome, 'error');
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
				resolveShimPath: () => '/safe/shim.js',
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
			assert.strictEqual((await controller.setup('codex')).servers[0].outcome, 'error');
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
				resolveShimPath: () => '/safe/shim.js',
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
			assert.strictEqual((await controller.setup('codex')).servers[0].outcome, 'error');
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
				resolveShimPath: () => '/safe/shim.js',
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
			assert.strictEqual((await controller.setup('codex')).servers[0].outcome, 'error');
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
				resolveShimPath: () => '/safe/shim.js',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				log: (message, error) => logs.push({ message, error }),
			});
			assert.strictEqual((await controller.setup('codex')).servers[0].outcome, 'error');
			assert.strictEqual((await fs.lstat(configPath)).isDirectory(), true);
			assert.deepStrictEqual(logs, [{ message: 'Codex MCP configuration update failed', error: undefined }]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
