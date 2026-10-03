/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisClaudeModEnvironment } from '../../browser/paradisClaudeModEnvironment.js';
import { paradisSetClaudeConfigDirProvider } from '../../common/paradisClaudeMod.js';

const APP_ROOT = '/app';
const HOME = URI.file('/home/test');
const MOD = URI.file('/app/resources/paradis/claude-mod');

suite('ParadisClaudeModEnvironment', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let store: DisposableStore;
	let fileService: FileService;
	let configuration: TestConfigurationService;

	setup(async () => {
		store = disposables.add(new DisposableStore());
		fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		configuration = new TestConfigurationService();
		for (const [path, text] of [
			['.claude-plugin/plugin.json', '{"name":"para-code"}'],
			['hooks/hooks.json', '{"modules":["./register.ts"]}'],
			['hooks/register.ts', 'export const register = () => {};'],
			['tests/para-code.test.ts', 'test'],
			['.claude-plugin/types/claude-code/index.d.ts', 'types'],
		]) {
			await fileService.writeFile(joinPath(MOD, ...path.split('/')), VSBuffer.fromString(text));
		}
	});

	teardown(() => paradisSetClaudeConfigDirProvider(undefined));

	const create = (options?: { readonly now?: () => number; readonly windows?: boolean }) => store.add(new ParadisClaudeModEnvironment(
		APP_ROOT, async () => HOME, options, fileService, configuration, new NullLogService(),
	));

	const listInstalled = async () => {
		const root = joinPath(HOME, '.para-code', 'claude-mod');
		const stat = await fileService.resolve(root);
		const result: string[] = [];
		for (const directory of (stat.children ?? []).filter(child => /^[0-9a-f]{16}$/.test(child.name))) {
			const walk = async (uri: URI, prefix: string): Promise<void> => {
				for (const child of (await fileService.resolve(uri)).children ?? []) {
					if (child.isDirectory) {
						await walk(child.resource, `${prefix}${child.name}/`);
					} else {
						result.push(`${prefix}${child.name}`);
					}
				}
			};
			await walk(directory.resource, '');
		}
		return result.sort();
	};

	test('copies the shipped files (not tests or engine-written types) into a fingerprinted folder and hands it out', async () => {
		const environment = create();
		await environment.ready;
		const directory = environment.pluginDirectory();
		assert.deepStrictEqual({
			directory: directory !== undefined && /^\/home\/test\/\.para-code\/claude-mod\/[0-9a-f]{16}$/.test(directory),
			files: await listInstalled(),
		}, { directory: true, files: ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts'] });
	});

	test('hands nothing out when the settings turn it off, on Windows, or when managed settings forbid plugin folders', async () => {
		const ready = create();
		await ready.ready;
		configuration.setUserConfiguration('paradis.agentHooks.claudeMod.enabled', false);
		const settingOff = ready.pluginDirectory();
		configuration.setUserConfiguration('paradis.agentHooks.claudeMod.enabled', true);
		const windows = create({ windows: true });
		await windows.ready;
		await fileService.writeFile(URI.file(isMacintosh ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json'), VSBuffer.fromString('{"disableSideloadFlags":true}'));
		const managed = create();
		await managed.ready;
		assert.deepStrictEqual({ settingOff, windows: windows.pluginDirectory(), managed: managed.pluginDirectory() }, { settingOff: undefined, windows: undefined, managed: undefined });
	});

	test('also reads remote-settings.json in the CLAUDE_CONFIG_DIR the shared process uses', async () => {
		await fileService.writeFile(URI.file('/custom/claude/remote-settings.json'), VSBuffer.fromString('{"disableSideloadFlags":true}'));
		const withoutProvider = create();
		await withoutProvider.ready;
		const before = withoutProvider.pluginDirectory() !== undefined;
		paradisSetClaudeConfigDirProvider(async () => '/custom/claude');
		const withProvider = create();
		await withProvider.ready;
		assert.deepStrictEqual({ before, after: withProvider.pluginDirectory() }, { before: true, after: undefined });
	});

	test('removes copies of other versions once they have been unused for 30 days, and keeps the current one', async () => {
		const first = create();
		await first.ready;
		const current = first.pluginDirectory()!;
		await fileService.writeFile(URI.file('/home/test/.para-code/claude-mod/0123456789abcdef/hooks/hooks.json'), VSBuffer.fromString('{}'));
		const later = create({ now: () => Date.now() + 31 * 24 * 60 * 60_000 });
		await later.ready;
		const remaining = ((await fileService.resolve(joinPath(HOME, '.para-code', 'claude-mod'))).children ?? []).filter(child => /^[0-9a-f]{16}$/.test(child.name)).map(child => child.resource.fsPath);
		assert.deepStrictEqual(remaining, [current]);
	});
});
