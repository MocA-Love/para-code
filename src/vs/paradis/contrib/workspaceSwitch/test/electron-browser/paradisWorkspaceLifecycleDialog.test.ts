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
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
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
			get: (id: unknown) => id === IFileService ? fileService : id === ILayoutService ? { activeContainer: container } : id === IHoverService ? NullHoverService : undefined,
		} as unknown as ServicesAccessor;
		try {
			openParadisWorkspaceLifecycleDialog(accessor, { id: 'repo', name: 'repo', uri: URI.file('/repo') } satisfies IParadisWorkspaceRepository);
			const save = () => container.querySelector<HTMLElement>('.plc-footer > .monaco-text-button:not(.secondary)')!;
			const setup = () => container.querySelector<HTMLTextAreaElement>('#paradis-lifecycle-setup-input')!;
			const before = { saveDisabled: save().classList.contains('disabled'), setupReadOnly: setup().readOnly };
			reading.complete();
			await new Promise(resolve => setTimeout(resolve, 0));
			await new Promise(resolve => setTimeout(resolve, 0));
			const after = { saveDisabled: save().classList.contains('disabled'), setupReadOnly: setup().readOnly, setup: setup().value };
			const dialog = container.querySelector<HTMLElement>('.paradis-workspace-lifecycle-dialog')!;
			const shape = {
				size: dialog.classList.contains('paradis-modal-s'),
				title: dialog.querySelector('.plc-title')?.textContent,
				labels: [...dialog.querySelectorAll('.plc-label')].map(label => label.textContent),
				buttons: [...dialog.querySelectorAll('.plc-footer > .monaco-text-button')].map(button => button.textContent),
			};
			container.querySelector<HTMLElement>('.plc-footer > .monaco-text-button.secondary')!.click();
			assert.deepStrictEqual({ before, after, shape, closed: container.querySelector('.paradis-workspace-lifecycle-dialog') === null }, {
				before: { saveDisabled: true, setupReadOnly: true },
				after: { saveDisabled: false, setupReadOnly: false, setup: 'bun install' },
				shape: { size: true, title: 'Setup / Teardown スクリプト', labels: ['Setup（作成の直後）', 'Teardown（削除の前）'], buttons: ['キャンセル', '保存'] },
				closed: true,
			});
		} finally {
			container.remove();
		}
	});

	test('edits the paths to bring into new worktrees and saves them with the scripts', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		await fileService.writeFile(URI.file('/repo/.paracode.json'), VSBuffer.fromString('{ "presets": [], "worktree": { "include": [".env", ".env.local"], "sharedDirectories": [".cache/models"] } }'));
		await fileService.writeFile(URI.file('/repo/.worktreeinclude'), VSBuffer.fromString('# local\nconfig/secrets.json\n'));
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const accessor = {
			get: (id: unknown) => id === IFileService ? fileService : id === ILayoutService ? { activeContainer: container } : id === IHoverService ? NullHoverService : undefined,
		} as unknown as ServicesAccessor;
		// 読み終え（.worktreeinclude は .paracode.json の後に読む）と書き終えを待つ
		const includeRead = new DeferredPromise<void>();
		const written = new DeferredPromise<void>();
		const readFile = fileService.readFile.bind(fileService);
		fileService.readFile = (async (...args: Parameters<typeof fileService.readFile>) => {
			try {
				return await readFile(...args);
			} finally {
				if (args[0].path.endsWith('.worktreeinclude')) {
					includeRead.complete();
				}
			}
		}) as typeof fileService.readFile;
		const writeFile = fileService.writeFile.bind(fileService);
		fileService.writeFile = (async (...args: Parameters<typeof fileService.writeFile>) => {
			const result = await writeFile(...args);
			written.complete();
			return result;
		}) as typeof fileService.writeFile;
		try {
			openParadisWorkspaceLifecycleDialog(accessor, { id: 'repo', name: 'repo', uri: URI.file('/repo') } satisfies IParadisWorkspaceRepository);
			await includeRead.p;
			await new Promise(resolve => setTimeout(resolve, 0));
			const rows = () => [...container.querySelectorAll('.plc-include-row')].map(row => [...row.querySelectorAll('.plc-include-chip-label')].map(chip => chip.textContent));
			const loaded = rows();
			// 「写す」の .env.local を外し、「パスを追加」で config/app.json を足す。使えないパスは足さずに理由を出す
			container.querySelectorAll<HTMLElement>('.plc-include-chip-remove')[1].click();
			const add = (text: string) => {
				container.querySelector<HTMLElement>('.plc-include-row .paradis-button')!.click();
				const input = container.querySelector<HTMLInputElement>('.plc-include-row .plc-include-input')!;
				input.value = text;
				input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			};
			add('../secret');
			const error = container.querySelector('.plc-error')!.textContent;
			container.querySelector<HTMLInputElement>('.plc-include-row .plc-include-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			add('./config/app.json');
			const edited = rows();
			const note = container.querySelector<HTMLElement>('.plc-include-note:not([hidden])')?.textContent;
			container.querySelector<HTMLElement>('.plc-footer > .monaco-text-button:not(.secondary)')!.click();
			await written.p;
			assert.deepStrictEqual({ loaded, error, edited, note, written: JSON.parse((await fileService.readFile(URI.file('/repo/.paracode.json'))).value.toString()) }, {
				loaded: [['.env', '.env.local'], ['.cache/models']],
				error: '「../secret」は使えません。リポジトリの中の相対パスを、* や ? を使わずに書いてください。',
				edited: [['.env', 'config/app.json'], ['.cache/models']],
				note: 'リポジトリの .worktreeinclude にある 1 件も写します。',
				written: { presets: [], worktree: { include: ['.env', 'config/app.json'], sharedDirectories: ['.cache/models'] } },
			});
		} finally {
			container.remove();
		}
	});

	test('the Enter and Escape of a Japanese conversion neither add a path nor close the dialog', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		await fileService.writeFile(URI.file('/repo/.paracode.json'), VSBuffer.fromString('{ "worktree": { "include": [".env"] } }'));
		const includeRead = new DeferredPromise<void>();
		const readFile = fileService.readFile.bind(fileService);
		fileService.readFile = (async (...args: Parameters<typeof fileService.readFile>) => {
			try {
				return await readFile(...args);
			} finally {
				if (args[0].path.endsWith('.worktreeinclude')) {
					includeRead.complete();
				}
			}
		}) as typeof fileService.readFile;
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const accessor = {
			get: (id: unknown) => id === IFileService ? fileService : id === ILayoutService ? { activeContainer: container } : id === IHoverService ? NullHoverService : undefined,
		} as unknown as ServicesAccessor;
		try {
			openParadisWorkspaceLifecycleDialog(accessor, { id: 'repo', name: 'repo', uri: URI.file('/repo') } satisfies IParadisWorkspaceRepository);
			await includeRead.p;
			await new Promise(resolve => setTimeout(resolve, 0));
			const chips = () => [...container.querySelectorAll('.plc-include-row')][0].querySelectorAll('.plc-include-chip-label').length;
			container.querySelector<HTMLElement>('.plc-include-row .paradis-button')!.click();
			const input = container.querySelector<HTMLInputElement>('.plc-include-row .plc-include-input')!;
			input.value = 'せってい';
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
			const backdrop = container.querySelector<HTMLElement>('.paradis-create-worktree-backdrop')!;
			backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
			assert.deepStrictEqual({ chips: chips(), inputShown: !input.hidden, value: input.value, open: container.contains(backdrop) }, {
				chips: 1,
				inputShown: true,
				value: 'せってい',
				open: true,
			});
			container.querySelector<HTMLElement>('.plc-footer > .monaco-text-button.secondary')!.click();
		} finally {
			container.remove();
		}
	});
});
