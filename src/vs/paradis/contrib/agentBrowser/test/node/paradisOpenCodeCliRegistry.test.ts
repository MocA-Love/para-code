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
import { paradisIsOpenCodeCompatibleCommand, paradisIsOpenCodeProgram, paradisOpenCodeTitleCommand, paradisSetOpenCodeCompatibleCommands } from '../../../../../platform/terminal/common/paradisOpenCodeCompatibleCli.js';
import { ParadisOpenCodeCliRegistry, paradisValidateOpenCodeDatabasePath } from '../../node/paradisOpenCodeCliRegistry.js';

suite('ParadisOpenCodeCliRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	setup(async () => { root = await fs.mkdtemp(join(tmpdir(), 'paradis-opencode-clis-')); });
	teardown(async () => {
		paradisSetOpenCodeCompatibleCommands([]);
		await fs.rm(root, { recursive: true, force: true });
	});

	test('accepts only safe, unreserved command names and home or XDG database paths', () => {
		const home = '/home/example';
		assert.deepStrictEqual({
			commands: ['example-cli', 'opencode2', 'Example', '-rf', 'a b', 'bash', 'claude', 'x'.repeat(49), 'tool;rm', '../x'].map(paradisIsOpenCodeCompatibleCommand),
			paths: ['/home/example/.example/data/opencode.db', '/home/example/../other/x.db', 'relative/x.db', '/etc/x.db', '/home/example/x.txt', '/data/x/opencode.db', '/home/example'].map(path => paradisValidateOpenCodeDatabasePath(path, { XDG_DATA_HOME: '/data/x' }, home) !== undefined),
		}, {
			commands: [true, true, false, false, false, false, false, false, false, false],
			paths: [true, false, false, false, false, true, false],
		});
	});

	test('learns a command only after remember, keeps trials temporary, and reloads what it remembered', async () => {
		const storePath = join(root, 'clis.json');
		const databasePath = join(homedir(), '.example-test', 'data', 'opencode-local.db');
		const registry = new ParadisOpenCodeCliRegistry();
		await registry.initialize(storePath);
		const endTrial = registry.beginTrial('example-cli');
		const duringTrial = [paradisIsOpenCodeProgram('example-cli'), paradisOpenCodeTitleCommand('example-cli | Fix the parser')];
		endTrial();
		const afterTrial = paradisIsOpenCodeProgram('example-cli');
		await registry.remember({ command: 'example-cli', label: 'Example CLI', databasePath });
		await registry.remember({ command: 'bash', databasePath });
		await registry.remember({ command: 'other-cli', label: 'bad\u0007label', databasePath: '/etc/passwd.db' });
		const reloaded = new ParadisOpenCodeCliRegistry();
		paradisSetOpenCodeCompatibleCommands([]);
		await reloaded.initialize(storePath);
		assert.deepStrictEqual({
			duringTrial, afterTrial,
			stored: reloaded.list().map(cli => [cli.command, cli.label, cli.databases]),
			databases: reloaded.databases(),
			programAfterReload: paradisIsOpenCodeProgram('example-cli'),
			mode: (await fs.stat(storePath)).mode & 0o777,
		}, {
			duringTrial: [true, 'example-cli'], afterTrial: false,
			stored: [['other-cli', undefined, []], ['example-cli', 'Example CLI', [databasePath]]],
			databases: [{ path: databasePath, command: 'example-cli', label: 'Example CLI' }],
			programAfterReload: true,
			mode: 0o600,
		});
	});

	test('ignores a damaged store', async () => {
		const storePath = join(root, 'clis.json');
		await fs.writeFile(storePath, JSON.stringify({ clis: [{ command: 'sh', seenAt: 1 }, { command: 'example-cli', seenAt: 'x' }, { command: 'ok-cli', seenAt: 2, databases: ['/etc/x.db'] }] }));
		const registry = new ParadisOpenCodeCliRegistry();
		await registry.initialize(storePath);
		assert.deepStrictEqual(registry.list(), [{ command: 'ok-cli', databases: [], seenAt: 2 }]);
	});
});
