/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisInstalledBrowserExtension,
	PARADIS_EMPTY_EXTENSIONS_LEDGER,
	paradisEnabledExtensions,
	paradisLedgerWithEnabled,
	paradisLedgerWithExtension,
	paradisLedgerWithoutExtension,
	paradisParseExtensionsLedger,
	paradisReadExtensionManifest,
} from '../../common/paradisBrowserExtensions.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

function extension(id: string): IParadisInstalledBrowserExtension {
	return { id, name: id.slice(0, 1), version: '1.0', manifestVersion: 3, source: 'unpacked', sourcePath: `/src/${id}`, path: `/copy/${id}`, installedAt: 1 };
}

suite('ParadisBrowserExtensions common', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a saved ledger and drops broken rows', () => {
		const parsed = paradisParseExtensionsLedger({
			version: 1,
			extensions: [extension(A), { ...extension(B), source: 'store' }, extension(A), { id: 'not-an-id' }],
			enabled: { default: [A, B, 'x'], 'profile:0123456789ab': [A], 'profile:bad': [A] },
			removed: [B, 'x'],
		});
		assert.deepStrictEqual(parsed, {
			version: 1,
			extensions: [extension(A)],
			enabled: { default: [A], 'profile:0123456789ab': [A] },
			removed: [B],
		});
		assert.deepStrictEqual(paradisParseExtensionsLedger({ version: 2 }), PARADIS_EMPTY_EXTENSIONS_LEDGER);
	});

	test('adds, enables per profile and removes', () => {
		let ledger = paradisLedgerWithExtension(PARADIS_EMPTY_EXTENSIONS_LEDGER, extension(A), 'default');
		ledger = paradisLedgerWithExtension(ledger, extension(B), undefined);
		ledger = paradisLedgerWithEnabled(ledger, B, 'profile:0123456789ab', true);
		const before = { default: paradisEnabledExtensions(ledger, 'default').map(e => e.id), profile: paradisEnabledExtensions(ledger, 'profile:0123456789ab').map(e => e.id) };
		ledger = paradisLedgerWithoutExtension(ledger, A);
		assert.deepStrictEqual({ before, after: ledger }, {
			before: { default: [A], profile: [B] },
			after: { version: 1, extensions: [extension(B)], enabled: { default: [], 'profile:0123456789ab': [B] }, removed: [A] },
		});
		// 足し直すと「消す印」は外れる
		assert.deepStrictEqual(paradisLedgerWithExtension(ledger, extension(A), undefined).removed, []);
	});

	test('reads manifests', () => {
		assert.deepStrictEqual([
			paradisReadExtensionManifest({ manifest_version: 3, name: '__MSG_name__', version: '2.0.1', key: 'abc' }, { NAME: { message: 'Localized' } }),
			paradisReadExtensionManifest({ manifest_version: 2, name: 'Plain', version: '1' }),
			paradisReadExtensionManifest({ manifest_version: 3, name: 'Bad', version: 'v1' }),
			paradisReadExtensionManifest({ manifest_version: 3, version: '1' }),
			paradisReadExtensionManifest([]),
		], [
			{ name: 'Localized', version: '2.0.1', manifestVersion: 3, key: 'abc' },
			{ name: 'Plain', version: '1', manifestVersion: 2 },
			{ error: 'version' },
			{ error: 'name' },
			{ error: 'notObject' },
		]);
	});
});
