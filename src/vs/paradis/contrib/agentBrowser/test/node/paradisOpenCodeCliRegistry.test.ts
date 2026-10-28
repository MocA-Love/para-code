/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsOpenCodeCompatibleCommand, paradisIsOpenCodeProgram, paradisIsOpenCodeResumeCli, paradisOpenCodeTitleCommand, paradisSetOpenCodeCompatibleCommands } from '../../../../../platform/terminal/common/paradisOpenCodeCompatibleCli.js';
import { PARADIS_OPENCODE_CLI_TTL_MS, ParadisOpenCodeCliRegistry, paradisOpenCodeXdgDataRoot, paradisParseLsofExecutable, paradisVerifyOpenCodeCliOnThisHost, paradisValidateOpenCodeDatabasePath, paradisVerifyOpenCodeCliProcess } from '../../node/paradisOpenCodeCliRegistry.js';

suite('ParadisOpenCodeCliRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	setup(async () => { root = await fs.mkdtemp(join(tmpdir(), 'paradis-opencode-clis-')); });
	teardown(async () => {
		paradisSetOpenCodeCompatibleCommands([]);
		await fs.rm(root, { recursive: true, force: true });
	});

	test('accepts only safe, unreserved names, safe absolute executables, and home or deep XDG database paths', () => {
		const home = '/home/example';
		assert.deepStrictEqual({
			commands: ['example-cli', 'opencode2', 'Example', '-rf', 'a b', 'bash', 'claude', 'oc', 'x'.repeat(49), 'tool;rm', '../x'].map(paradisIsOpenCodeCompatibleCommand),
			resume: ['opencode', '/opt/example/bin/example-cli', 'example-cli', '/opt/x/../bin/example-cli', '/opt/My Tools/example-cli', '/usr/bin/bun', '/usr/bin/python3.12', '/opt/bin/example-cli;rm'].map(paradisIsOpenCodeResumeCli),
			paths: ['/home/example/.example/data/opencode.db', '/home/example/../other/x.db', 'relative/x.db', '/etc/x.db', '/home/example/x.txt', '/data/x/opencode.db', '/home/example'].map(path => paradisValidateOpenCodeDatabasePath(path, { XDG_DATA_HOME: '/data/x' }, home) !== undefined),
			shallowXdg: [paradisOpenCodeXdgDataRoot({ XDG_DATA_HOME: '/' }), paradisOpenCodeXdgDataRoot({ XDG_DATA_HOME: '/data' }), paradisOpenCodeXdgDataRoot({ XDG_DATA_HOME: '/data/x' })],
			shallowXdgPath: paradisValidateOpenCodeDatabasePath('/etc/opencode.db', { XDG_DATA_HOME: '/' }, home),
		}, {
			commands: [true, true, false, false, false, false, false, false, false, false, false],
			resume: [true, true, false, false, false, false, false, false],
			paths: [true, false, false, false, false, true, false],
			shallowXdg: [undefined, undefined, '/data/x'],
			shallowXdgPath: undefined,
		});
	});

	test('reads the running executable from the first name line of lsof -a -p <pid> -d txt -Fn', () => {
		assert.deepStrictEqual([
			paradisParseLsofExecutable('p4242\nftxt\nn/Users/example/.local/share/example/releases/1.0/example-cli\nftxt\nn/usr/lib/dyld\n'),
			paradisParseLsofExecutable('p4242\n'),
			paradisParseLsofExecutable(''),
			paradisParseLsofExecutable('p4242\nftxt\nnrelative/example-cli\n'),
		], ['/Users/example/.local/share/example/releases/1.0/example-cli', undefined, undefined, undefined]);
	});

	test('verifies a declared command by the real executable and never by a runtime or shell', async () => {
		const executables = new Map<number, string>([[1, '/opt/example/bin/example-cli'], [2, '/usr/bin/bun'], [3, '/opt/example/bin/other-cli'], [4, '/bin/zsh']]);
		const resolve = async (pid: number) => executables.get(pid);
		assert.deepStrictEqual(await Promise.all([
			paradisVerifyOpenCodeCliProcess(1, 'example-cli', resolve),
			paradisVerifyOpenCodeCliProcess(2, 'bun', resolve),
			paradisVerifyOpenCodeCliProcess(2, 'example-cli', resolve),
			paradisVerifyOpenCodeCliProcess(3, 'example-cli', resolve),
			paradisVerifyOpenCodeCliProcess(4, 'zsh', resolve),
			paradisVerifyOpenCodeCliProcess(9, 'example-cli', resolve),
		]), ['/opt/example/bin/example-cli', undefined, undefined, undefined, undefined, undefined]);
	});

	test('learns a command only after remember, keeps trials out of the published list, reloads, expires and forgets', async () => {
		let now = 1_000_000;
		const storePath = join(root, 'profile', 'clis.json');
		const databasePath = join(homedir(), '.example-test', 'data', 'opencode-local.db');
		const executable = '/opt/example/bin/example-cli';
		const registry = new ParadisOpenCodeCliRegistry(() => now);
		await registry.initialize(storePath);
		const endTrial = registry.beginTrial('example-cli');
		const duringTrial = { program: paradisIsOpenCodeProgram('example-cli'), title: paradisOpenCodeTitleCommand('example-cli | Fix the parser'), published: registry.commands() };
		endTrial();
		const afterTrial = paradisIsOpenCodeProgram('example-cli');
		await registry.remember({ command: 'example-cli', executable, label: 'Example CLI', databasePath });
		await registry.remember({ command: 'bash', executable: '/bin/bash', databasePath });
		await registry.remember({ command: 'other-cli', executable: '/opt/example/bin/not-the-same-name', databasePath });
		const reloaded = new ParadisOpenCodeCliRegistry(() => now);
		paradisSetOpenCodeCompatibleCommands([]);
		await reloaded.initialize(storePath);
		const loaded = {
			stored: reloaded.list().map(cli => [cli.command, cli.executable, cli.label, cli.databases]),
			databases: reloaded.databases(),
			executable: reloaded.executableOf('example-cli'),
			programAfterReload: paradisIsOpenCodeProgram('example-cli'),
			mode: (await fs.stat(storePath)).mode & 0o777,
		};
		now += PARADIS_OPENCODE_CLI_TTL_MS;
		const expired = { list: reloaded.list().length, afterReload: await (async () => { const again = new ParadisOpenCodeCliRegistry(() => now); await again.initialize(storePath); return again.list().length; })() };
		now -= PARADIS_OPENCODE_CLI_TTL_MS;
		await reloaded.forgetAll();
		const forgotten = new ParadisOpenCodeCliRegistry(() => now);
		await forgotten.initialize(storePath);
		assert.deepStrictEqual({ duringTrial, afterTrial, loaded, expired, forgotten: [forgotten.list(), paradisIsOpenCodeProgram('example-cli')] }, {
			duringTrial: { program: true, title: 'example-cli', published: [] }, afterTrial: false,
			loaded: {
				stored: [['example-cli', executable, 'Example CLI', [databasePath]]],
				databases: [{ path: databasePath, cli: executable, label: 'Example CLI' }],
				executable,
				programAfterReload: true,
				mode: 0o600,
			},
			expired: { list: 0, afterReload: 0 },
			forgotten: [[], false],
		});
	});

	test('keeps CLIs verified on a remote machine apart from this machine, and reloads them per authority', async () => {
		const storePath = join(root, 'clis.json');
		const registry = new ParadisOpenCodeCliRegistry(() => 10);
		await registry.initialize(storePath);
		await registry.remember({ command: 'example-cli', executable: '/home/remote/.local/bin/example-cli', label: 'Example CLI', databasePath: '/home/remote/.example/data/opencode-local.db', authority: 'SSH-Remote+Host' });
		await registry.remember({ command: 'example-cli', executable: '/opt/example/bin/example-cli' });
		await registry.remember({ command: 'other-cli', executable: '/opt/x/other-cli', databasePath: 'relative.db', authority: 'ssh-remote+host' });
		await registry.remember({ command: 'bad-cli', executable: '/opt/x/bad-cli', authority: 'bad authority' });
		const reloaded = new ParadisOpenCodeCliRegistry(() => 10);
		await reloaded.initialize(storePath);
		assert.deepStrictEqual({
			local: reloaded.list().map(cli => [cli.command, cli.executable]),
			remote: reloaded.list('ssh-remote+host').map(cli => [cli.command, cli.executable, cli.databases]),
			localCommands: reloaded.commands(),
			allCommands: [...reloaded.allCommands()].sort(),
			remoteExecutable: reloaded.executableOf('example-cli', 'SSH-REMOTE+HOST'),
			remoteDatabases: reloaded.databases('ssh-remote+host'),
			localDatabases: reloaded.databases(),
		}, {
			local: [['example-cli', '/opt/example/bin/example-cli']],
			remote: [['other-cli', '/opt/x/other-cli', []], ['example-cli', '/home/remote/.local/bin/example-cli', ['/home/remote/.example/data/opencode-local.db']]],
			localCommands: ['example-cli'],
			allCommands: ['example-cli', 'other-cli'],
			remoteExecutable: '/home/remote/.local/bin/example-cli',
			remoteDatabases: [{ path: '/home/remote/.example/data/opencode-local.db', cli: '/home/remote/.local/bin/example-cli', label: 'Example CLI' }],
			localDatabases: [],
		});
	});

	test('verifies a declared CLI and its database on this machine (what the SSH host runs for a remote pane)', async () => {
		const home = join(root, 'home');
		await fs.mkdir(join(home, '.example', 'data'), { recursive: true });
		await fs.writeFile(join(home, '.example', 'data', 'opencode-local.db'), '');
		await fs.writeFile(join(root, 'escape.db'), '');
		await fs.symlink(join(root, 'escape.db'), join(home, '.example', 'data', 'linked.db'));
		const resolve = async (pid: number) => pid === 1 ? '/home/example/.local/share/example/releases/1/example-cli' : pid === 2 ? '/usr/bin/bun' : undefined;
		const verify = (pid: number, databasePath?: string) => paradisVerifyOpenCodeCliOnThisHost({ pid, command: 'example-cli', ...(databasePath !== undefined ? { databasePath } : {}) }, {}, home, resolve);
		assert.deepStrictEqual(await Promise.all([
			verify(1, join(home, '.example', 'data', 'opencode-local.db')),
			verify(1, join(home, '.example', 'data', 'linked.db')),
			verify(1, join(home, '.example', 'data', 'missing.db')),
			verify(2, join(home, '.example', 'data', 'opencode-local.db')),
		]), [
			{ executable: '/home/example/.local/share/example/releases/1/example-cli', databasePath: await fs.realpath(join(home, '.example', 'data', 'opencode-local.db')) },
			{ executable: '/home/example/.local/share/example/releases/1/example-cli' },
			{ executable: '/home/example/.local/share/example/releases/1/example-cli' },
			undefined,
		]);
	});

	test('ignores a damaged store', async () => {
		const storePath = join(root, 'clis.json');
		await fs.writeFile(storePath, JSON.stringify({
			clis: [
				{ command: 'sh', executable: '/bin/sh', seenAt: 1 },
				{ command: 'example-cli', executable: '/opt/example-cli', seenAt: 'x' },
				{ command: 'ok-cli', executable: '/opt/bin/ok-cli', seenAt: 2, databases: ['/etc/x.db'] },
				{ command: 'no-exe', seenAt: 2 },
			]
		}));
		const registry = new ParadisOpenCodeCliRegistry(() => 3);
		await registry.initialize(storePath);
		assert.deepStrictEqual(registry.list(), [{ command: 'ok-cli', executable: '/opt/bin/ok-cli', databases: [], seenAt: 2 }]);
	});
});
