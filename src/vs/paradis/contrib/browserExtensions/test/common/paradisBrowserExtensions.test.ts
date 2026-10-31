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
	paradisIsAllowedOnRemote,
	paradisLedgerWithAllowedOnRemote,
	paradisLedgerWithDataCleared,
	paradisLedgerWithEnabled,
	paradisLedgerWithExtension,
	paradisLedgerWithoutExtension,
	paradisLedgerWithPinned,
	paradisPinnedExtensionIds,
	paradisNeedsDataClear,
	paradisNewTabOverrideUrl,
	paradisParseExtensionsLedger,
	paradisReadExtensionManifest,
	paradisSerializeExtensionsLedger,
} from '../../common/paradisBrowserExtensions.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

function extension(id: string): IParadisInstalledBrowserExtension {
	return { id, name: id.slice(0, 1), version: '1.0', manifestVersion: 3, source: 'unpacked', sourcePath: `/src/${id}`, path: `/copy/${id}`, installedAt: 1, touchesPages: true };
}

suite('ParadisBrowserExtensions common', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a saved ledger and drops broken rows', () => {
		const parsed = paradisParseExtensionsLedger({
			version: 1,
			extensions: [extension(A), { ...extension(B), source: 'store' }, extension(A), { id: 'not-an-id' }],
			enabled: { default: [A, B, 'x'], 'profile:0123456789ab': [A], 'profile:bad': [A] },
			removed: [B, 'x', { id: A, cleared: ['/s1', 3] }],
			pinned: { default: [A, B, A], 'profile:bad': [A] },
		});
		assert.deepStrictEqual(parsed, {
			version: 1,
			extensions: [extension(A)],
			enabled: { default: [A], 'profile:0123456789ab': [A] },
			removed: [{ id: B, cleared: [] }, { id: A, cleared: ['/s1'] }],
			pinned: { default: [A] },
		});
		assert.deepStrictEqual(paradisParseExtensionsLedger({ version: 2 }), PARADIS_EMPTY_EXTENSIONS_LEDGER);
	});

	test('adds, enables per profile and removes', () => {
		let ledger = paradisLedgerWithExtension(PARADIS_EMPTY_EXTENSIONS_LEDGER, extension(A), 'default');
		ledger = paradisLedgerWithExtension(ledger, extension(B), undefined);
		ledger = paradisLedgerWithEnabled(ledger, B, 'profile:0123456789ab', true);
		// ピン留めは場所ごと。足した順に並び、同じものは二度足さない
		ledger = paradisLedgerWithPinned(ledger, B, 'default', true);
		ledger = paradisLedgerWithPinned(ledger, A, 'default', true);
		ledger = paradisLedgerWithPinned(ledger, A, 'default', true);
		ledger = paradisLedgerWithPinned(ledger, A, 'profile:0123456789ab', true);
		ledger = paradisLedgerWithPinned(ledger, 'c'.repeat(32), 'default', true);
		const pins = { default: paradisPinnedExtensionIds(ledger, 'default'), profile: paradisPinnedExtensionIds(ledger, 'profile:0123456789ab') };
		const before = { default: paradisEnabledExtensions(ledger, 'default').map(e => e.id), profile: paradisEnabledExtensions(ledger, 'profile:0123456789ab').map(e => e.id) };
		ledger = paradisLedgerWithoutExtension(ledger, A);
		assert.deepStrictEqual({ before, pins, after: ledger }, {
			before: { default: [A], profile: [B] },
			pins: { default: [B, A], profile: [A] },
			after: { version: 1, extensions: [extension(B)], enabled: { default: [], 'profile:0123456789ab': [B] }, removed: [{ id: A, cleared: [] }], pinned: { default: [B], 'profile:0123456789ab': [] } },
		});
	});

	test('keeps "use on SSH hosts" per extension, off by default, and drops it with the extension', () => {
		let ledger = paradisLedgerWithExtension(PARADIS_EMPTY_EXTENSIONS_LEDGER, extension(A), 'default');
		ledger = paradisLedgerWithExtension(ledger, extension(B), 'default');
		const byDefault = [paradisIsAllowedOnRemote(ledger, A), paradisIsAllowedOnRemote(ledger, B)];
		ledger = paradisLedgerWithAllowedOnRemote(ledger, A, true);
		ledger = paradisLedgerWithAllowedOnRemote(ledger, A, true);
		ledger = paradisLedgerWithAllowedOnRemote(ledger, 'c'.repeat(32), true);
		// 保存して読み直しても残る。台帳に無い id と壊れた値は捨てる
		const reparsed = paradisParseExtensionsLedger({ ...(paradisSerializeExtensionsLedger(ledger) as object), allowedOnRemote: [A, A, 'c'.repeat(32), 'x'] });
		// 印の無い台帳（Q519 より前の版）はどれもオフ
		const older = paradisParseExtensionsLedger({ version: 1, extensions: [extension(A)], enabled: {}, removed: [], pinned: {} });
		const turnedOff = paradisLedgerWithAllowedOnRemote(ledger, A, false);
		const removed = paradisLedgerWithoutExtension(ledger, A);
		assert.deepStrictEqual({
			byDefault,
			allowed: ledger.allowedOnRemote,
			reparsed: reparsed.allowedOnRemote,
			older: paradisIsAllowedOnRemote(older, A),
			turnedOff: turnedOff.allowedOnRemote,
			removed: removed.allowedOnRemote,
		}, { byDefault: [false, false], allowed: [A], reparsed: [A], older: false, turnedOff: undefined, removed: undefined });
	});

	test('keeps the data-clearing mark across a reinstall until each storage path is cleared', () => {
		let ledger = paradisLedgerWithExtension(PARADIS_EMPTY_EXTENSIONS_LEDGER, extension(A), 'default');
		ledger = paradisLedgerWithoutExtension(ledger, A);
		ledger = paradisLedgerWithDataCleared(ledger, A, '/global');
		// 入れ直しても印は残り、まだ消していない保存先では消す
		ledger = paradisLedgerWithExtension(ledger, extension(A), 'default');
		const afterReinstall = [paradisNeedsDataClear(ledger, A, '/global'), paradisNeedsDataClear(ledger, A, '/profile')];
		// もう一度削除すると、消し終えた保存先も数え直す
		ledger = paradisLedgerWithoutExtension(ledger, A);
		assert.deepStrictEqual({ afterReinstall, afterRemoveAgain: paradisNeedsDataClear(ledger, A, '/global'), never: paradisNeedsDataClear(ledger, B, '/global') }, {
			afterReinstall: [false, true],
			afterRemoveAgain: true,
			never: false,
		});
	});

	test('tells which extensions can read and write pages', () => {
		const touches = (manifest: object) => {
			const summary = paradisReadExtensionManifest({ manifest_version: 3, name: 'E', version: '1', ...manifest });
			return (summary as { readonly touchesPages?: boolean }).touchesPages;
		};
		assert.deepStrictEqual({
			contentScripts: touches({ content_scripts: [{ matches: ['<all_urls>'], js: ['c.js'] }] }),
			nativeMessaging: touches({ permissions: ['nativeMessaging'] }),
			scriptingWithHosts: touches({ permissions: ['scripting'], host_permissions: ['<all_urls>'] }),
			activeTab: touches({ permissions: ['activeTab'] }),
			storageOnly: touches({ permissions: ['storage'] }),
			hostsOnly: touches({ host_permissions: ['https://example.com/*'] }),
			debuggerPermission: touches({ permissions: ['debugger'] }),
			userScripts: touches({ permissions: ['userScripts'] }),
			optionalScripting: touches({ optional_permissions: ['scripting'], optional_host_permissions: ['<all_urls>'] }),
			optionalNative: touches({ optional_permissions: ['nativeMessaging'] }),
			// P3 の版で足した行（touchesPages が無い）は、知らせ損ねないよう読み書きできる側に倒す
			oldLedgerRow: paradisParseExtensionsLedger({ version: 1, extensions: [{ ...extension(A), touchesPages: undefined }], enabled: {}, removed: [] }).extensions[0].touchesPages,
		}, { contentScripts: true, nativeMessaging: true, scriptingWithHosts: true, activeTab: true, storageOnly: false, hostsOnly: false, debuggerPermission: true, userScripts: true, optionalScripting: true, optionalNative: true, oldLedgerRow: true });
	});

	test('builds the new tab page only inside the extension', () => {
		const url = (newtab: unknown) => paradisNewTabOverrideUrl(A, { chrome_url_overrides: { newtab } });
		assert.deepStrictEqual({
			plain: url('newtab.html'),
			leadingSlash: url('/pages/tab.html?x=1#y'),
			escape: url('../../evil.html'),
			otherExtension: url(`chrome-extension://${B}/tab.html`),
			web: url('https://example.com/'),
			protocolRelative: url('//example.com/x'),
			empty: url(''),
			notString: url(1),
			none: paradisNewTabOverrideUrl(A, { chrome_url_overrides: { history: 'h.html' } }),
		}, {
			plain: `chrome-extension://${A}/newtab.html`,
			leadingSlash: `chrome-extension://${A}/pages/tab.html?x=1#y`,
			escape: `chrome-extension://${A}/evil.html`,
			otherExtension: undefined,
			web: undefined,
			protocolRelative: `chrome-extension://${A}/example.com/x`,
			empty: undefined,
			notString: undefined,
			none: undefined,
		});
	});

	test('reads manifests', () => {
		assert.deepStrictEqual([
			paradisReadExtensionManifest({ manifest_version: 3, name: '__MSG_name__', version: '2.0.1', key: 'abc' }, { NAME: { message: 'Localized' } }),
			paradisReadExtensionManifest({ manifest_version: 2, name: 'Plain', version: '1' }),
			paradisReadExtensionManifest({ manifest_version: 3, name: 'Bad', version: 'v1' }),
			paradisReadExtensionManifest({ manifest_version: 3, version: '1' }),
			paradisReadExtensionManifest([]),
		], [
			{ name: 'Localized', version: '2.0.1', manifestVersion: 3, touchesPages: false, key: 'abc' },
			{ name: 'Plain', version: '1', manifestVersion: 2, touchesPages: false },
			{ error: 'version' },
			{ error: 'name' },
			{ error: 'notObject' },
		]);
	});
});
