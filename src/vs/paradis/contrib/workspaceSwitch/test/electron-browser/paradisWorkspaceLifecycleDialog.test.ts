/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file (Para Code: this file contains Japanese assertions)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisSaveWorkspaceLifecycleConfig } from '../../electron-browser/paradisWorkspaceLifecycleDialog.js';
import { IParadisWorkspaceLifecycleConfig } from '../../common/paradisWorkspaceLifecycle.js';

suite('workspace lifecycle dialog', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createDialogSaveFixture(initialContent: string | undefined) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const repositoryUri = URI.file('/repo');
		const configUri = URI.file('/repo/.paracode.json');
		if (initialContent !== undefined) {
			await fileService.writeFile(configUri, VSBuffer.fromString(initialContent));
		}

		let writeCount = 0;
		const originalWriteFile = fileService.writeFile.bind(fileService);
		fileService.writeFile = ((...args: Parameters<typeof fileService.writeFile>) => {
			writeCount++;
			return originalWriteFile(...args);
		}) as typeof fileService.writeFile;

		return {
			get writeCount() { return writeCount; },
			async written(): Promise<string> {
				return (await fileService.readFile(configUri)).value.toString();
			},
			async save(config: IParadisWorkspaceLifecycleConfig) {
				await paradisSaveWorkspaceLifecycleConfig(fileService, repositoryUri, config);
			}
		};
	}

	test('preserves unknown fields when saving scripts', async () => {
		const fixture = await createDialogSaveFixture('{ "presets": [], "future": true }');
		await fixture.save({ setupScript: 'bun install', teardownScript: 'docker image prune' });
		assert.deepStrictEqual(JSON.parse(await fixture.written()), {
			presets: [], future: true, setupScript: 'bun install', teardownScript: 'docker image prune'
		});
	});

	test('does not create a missing file for two blank scripts', async () => {
		const fixture = await createDialogSaveFixture(undefined);
		await fixture.save({ setupScript: ' ', teardownScript: '' });
		assert.strictEqual(fixture.writeCount, 0);
	});

	test('does not overwrite malformed JSONC', async () => {
		const fixture = await createDialogSaveFixture('{ bad json');
		await assert.rejects(fixture.save({ setupScript: 'bun install' }), /\.paracode\.json の内容が不正です/);
		assert.strictEqual(fixture.writeCount, 0);
	});
});
