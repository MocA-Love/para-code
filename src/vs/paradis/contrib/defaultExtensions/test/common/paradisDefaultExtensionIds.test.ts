/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { PARADIS_DEFAULT_EXTENSION_IDS, PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY, paradisPendingDefaultExtensions, paradisReadDefaultExtensionsLedger, paradisStoreDefaultExtensionsLedger } from '../../common/paradisDefaultExtensionIds.js';

suite('Paradis default extension ids', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function storageWithLedger(ledger: string): InMemoryStorageService {
		const storage = store.add(new InMemoryStorageService());
		storage.store(PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY, ledger, StorageScope.APPLICATION, StorageTarget.MACHINE);
		return storage;
	}

	test('installs only the language pack, the file icon theme and the color theme', () => {
		assert.deepStrictEqual([...PARADIS_DEFAULT_EXTENSION_IDS], [
			'MS-CEINTL.vscode-language-pack-ja',
			'PKief.material-icon-theme',
			'astro-build.houston',
		]);
	});

	// A user from before 2026-11-27 has the removed ids in the ledger. Nothing is pending for them, and
	// writing the ledger back keeps the removed ids (the feature only installs; it has no uninstall path).
	test('an existing user with removed ids in the ledger gets nothing installed and keeps the ledger', () => {
		const ledger = '["mhutchie.git-graph","pixl-garden.bongocat","golang.go","ms-ceintl.vscode-language-pack-ja","pkief.material-icon-theme","astro-build.houston"]';
		const storage = storageWithLedger(ledger);

		const done = paradisReadDefaultExtensionsLedger(storage, PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY);
		const pending = paradisPendingDefaultExtensions(PARADIS_DEFAULT_EXTENSION_IDS, done);
		paradisStoreDefaultExtensionsLedger(storage, PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY, done);

		assert.deepStrictEqual({ pending, stored: storage.get(PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY, StorageScope.APPLICATION) }, { pending: [], stored: ledger });
	});

	// A removed id that never made it into the ledger (its install failed before the removal) is not retried.
	test('a removed id that is missing from the ledger is not installed again', () => {
		const storage = storageWithLedger('["mhutchie.git-graph","pkief.material-icon-theme"]');

		const done = paradisReadDefaultExtensionsLedger(storage, PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY);
		const pending = paradisPendingDefaultExtensions(PARADIS_DEFAULT_EXTENSION_IDS, done);
		for (const id of pending) {
			done.add(id.toLowerCase());
		}
		paradisStoreDefaultExtensionsLedger(storage, PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY, done);

		assert.deepStrictEqual({ pending, stored: storage.get(PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY, StorageScope.APPLICATION) }, {
			pending: ['MS-CEINTL.vscode-language-pack-ja', 'astro-build.houston'],
			stored: '["mhutchie.git-graph","pkief.material-icon-theme","ms-ceintl.vscode-language-pack-ja","astro-build.houston"]',
		});
	});

	test('a new user and a corrupt ledger have all three pending', () => {
		assert.deepStrictEqual({
			fresh: paradisPendingDefaultExtensions(PARADIS_DEFAULT_EXTENSION_IDS, paradisReadDefaultExtensionsLedger(store.add(new InMemoryStorageService()), PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY)),
			corrupt: paradisPendingDefaultExtensions(PARADIS_DEFAULT_EXTENSION_IDS, paradisReadDefaultExtensionsLedger(storageWithLedger('{not valid json'), PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY)),
		}, {
			fresh: ['MS-CEINTL.vscode-language-pack-ja', 'PKief.material-icon-theme', 'astro-build.houston'],
			corrupt: ['MS-CEINTL.vscode-language-pack-ja', 'PKief.material-icon-theme', 'astro-build.houston'],
		});
	});
});
