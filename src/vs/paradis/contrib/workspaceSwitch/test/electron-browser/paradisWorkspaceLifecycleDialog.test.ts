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
import { openParadisWorkspaceLifecycleDialog, paradisSaveWorkspaceLifecycleConfig } from '../../electron-browser/paradisWorkspaceLifecycleDialog.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IParadisWorkspaceRepository } from '../../common/paradisWorkspaceSwitch.js';
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

	test('keeps the save button disabled until the existing scripts have been read', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		await fileService.writeFile(URI.file('/repo/.paracode.json'), VSBuffer.fromString('{ "setupScript": "bun install" }'));
		const reading = new DeferredPromise<void>();
		const readFile = fileService.readFile.bind(fileService);
		fileService.readFile = (async (...args: Parameters<typeof fileService.readFile>) => {
			await reading.p;
			return readFile(...args);
		}) as typeof fileService.readFile;
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const accessor = {
			get: (id: unknown) => id === IFileService ? fileService : id === ILayoutService ? { activeContainer: container } : undefined,
		} as unknown as ServicesAccessor;
		try {
			openParadisWorkspaceLifecycleDialog(accessor, { id: 'repo', name: 'repo', uri: URI.file('/repo') } satisfies IParadisWorkspaceRepository);
			const save = () => container.querySelector<HTMLButtonElement>('.pcw-btn-primary')!;
			const setup = () => container.querySelector<HTMLTextAreaElement>('#paradis-lifecycle-setup-input')!;
			const before = { saveDisabled: save().disabled, setupReadOnly: setup().readOnly };
			reading.complete();
			await new Promise(resolve => setTimeout(resolve, 0));
			await new Promise(resolve => setTimeout(resolve, 0));
			const after = { saveDisabled: save().disabled, setupReadOnly: setup().readOnly, setup: setup().value };
			container.querySelector<HTMLButtonElement>('.pcw-btn:not(.pcw-btn-primary)')!.click();
			assert.deepStrictEqual({ before, after }, {
				before: { saveDisabled: true, setupReadOnly: true },
				after: { saveDisabled: false, setupReadOnly: false, setup: 'bun install' },
			});
		} finally {
			container.remove();
		}
	});
});
