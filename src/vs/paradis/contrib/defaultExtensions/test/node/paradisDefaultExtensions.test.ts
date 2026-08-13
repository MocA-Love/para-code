/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as fs from 'fs';
import { FileAccess } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BUNDLED_VSIX_FILES, INSTALLED_VSIX_STORAGE_KEY, ParadisBundledVsixInstaller } from '../../common/paradisBundledVsixInstaller.js';

suite('Paradis bundled default extensions', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createInstaller(files: readonly string[], stored: string, existing: readonly string[] = files): {
		readonly installer: ParadisBundledVsixInstaller;
		readonly installed: string[];
		readonly warnings: string[];
		readonly storage: InMemoryStorageService;
	} {
		const storage = store.add(new InMemoryStorageService());
		storage.store(INSTALLED_VSIX_STORAGE_KEY, stored, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const installed: string[] = [];
		const warnings: string[] = [];
		const installer = new ParadisBundledVsixInstaller({
			files,
			appRoot: '/test-app',
			storageService: storage,
			exists: async location => existing.includes(basename(location.fsPath)),
			install: async location => { installed.push(basename(location.fsPath)); },
			warn: message => { warnings.push(message); },
			info: () => undefined,
		});
		return { installer, installed, warnings, storage };
	}

	test('enumerates every bundled VSIX on disk exactly once', () => {
		const extensionDirectory = FileAccess.asFileUri('vs/../../resources/paradis/extensions').fsPath;
		const packagedVsix = fs.readdirSync(extensionDirectory).filter(file => file.endsWith('.vsix')).sort();

		assert.deepStrictEqual([...BUNDLED_VSIX_FILES].sort(), packagedVsix);
		assert.strictEqual(new Set(BUNDLED_VSIX_FILES).size, BUNDLED_VSIX_FILES.length);
	});

	test('leaves a missing VSIX pending without recording it as installed', async () => {
		const { installer, installed, warnings, storage } = createInstaller(['missing.extension-1.0.0.vsix'], '[]', []);

		await installer.install();

		assert.deepStrictEqual({ installed, warnings, stored: storage.get(INSTALLED_VSIX_STORAGE_KEY, StorageScope.APPLICATION), pending: installer.hasPendingInstalls() }, {
			installed: [],
			warnings: ['[ParadisDefaultExtensions] bundled vsix not found: missing.extension-1.0.0.vsix'],
			stored: '[]',
			pending: true,
		});
	});

	test('installs a duplicated configured VSIX only once', async () => {
		const file = 'publisher.extension-1.0.0.vsix';
		const { installer, installed, storage } = createInstaller([file, file], '[]');

		await installer.install();

		assert.deepStrictEqual({ installed, stored: JSON.parse(storage.get(INSTALLED_VSIX_STORAGE_KEY, StorageScope.APPLICATION)!) }, {
			installed: [file],
			stored: [file],
		});
	});

	test('does not reinstall a VSIX recorded with the current version', async () => {
		const file = 'publisher.extension-1.0.0.vsix';
		const { installer, installed } = createInstaller([file], JSON.stringify([file]));

		await installer.install();

		assert.deepStrictEqual({ installed, pending: installer.hasPendingInstalls() }, { installed: [], pending: false });
	});

	test('installs a new VSIX version when storage contains only the previous version', async () => {
		const oldFile = 'publisher.extension-1.0.0.vsix';
		const newFile = 'publisher.extension-1.1.0.vsix';
		const { installer, installed, storage } = createInstaller([newFile], JSON.stringify([oldFile]));

		await installer.install();

		assert.deepStrictEqual({ installed, stored: JSON.parse(storage.get(INSTALLED_VSIX_STORAGE_KEY, StorageScope.APPLICATION)!) }, {
			installed: [newFile],
			stored: [oldFile, newFile],
		});
	});

	test('recovers corrupt storage by retrying and writing canonical state', async () => {
		const file = 'publisher.extension-1.0.0.vsix';
		const { installer, installed, storage } = createInstaller([file], '{not valid json');

		assert.strictEqual(installer.hasPendingInstalls(), true);
		await installer.install();

		assert.deepStrictEqual({ installed, stored: storage.get(INSTALLED_VSIX_STORAGE_KEY, StorageScope.APPLICATION), pending: installer.hasPendingInstalls() }, {
			installed: [file],
			stored: JSON.stringify([file]),
			pending: false,
		});
	});
});
