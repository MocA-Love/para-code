/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_BINDING_RESTORE_MAX_AGE_MS,
	PARADIS_BINDING_RESTORE_MAX_ENTRIES,
	PARADIS_BINDING_RESTORE_REFRESH_MS,
	paradisBindingRestoreCandidates,
	paradisBindingRestoreKey,
	paradisBindingRestoreOrigin,
	paradisNextBindingRestoreLedger,
	paradisParseBindingRestoreLedger,
	paradisRemovePageFromBindingRestoreEntry,
	paradisSerializeBindingRestoreLedger,
} from '../../common/paradisBindingRestoreLedger.js';

suite('paradisBindingRestoreLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const now = 1_800_000_000_000;
	const keyA = paradisBindingRestoreKey('token-a');
	const keyB = paradisBindingRestoreKey('token-b');
	const keyC = paradisBindingRestoreKey('token-c');

	test('stores a hash of the pane token, never the token itself', () => {
		const serialized = paradisSerializeBindingRestoreLedger(new Map([[keyA, { pageId: 'page-1', at: now }]]));
		assert.deepStrictEqual({
			hidesToken: !serialized.includes('token-a'),
			keyShape: /^[0-9a-f]{40}$/.test(keyA),
			stable: paradisBindingRestoreKey('token-a') === keyA,
			distinct: keyA !== keyB,
			roundTrip: [...paradisParseBindingRestoreLedger(serialized, now)],
		}, {
			hidesToken: true,
			keyShape: true,
			stable: true,
			distinct: true,
			roundTrip: [[keyA, { pageId: 'page-1', at: now }]],
		});
	});

	test('drops broken, raw-token and stale rows and keeps the newest up to the limit', () => {
		const rows: Record<string, unknown> = {
			[keyA]: { pageId: 'page-1', at: now },
			'token-a': { pageId: 'page-raw', at: now },
			[keyB]: { pageId: 'page-2', at: now - PARADIS_BINDING_RESTORE_MAX_AGE_MS - 1 },
			[keyC]: { pageId: '', at: now },
		};
		for (let index = 0; index < PARADIS_BINDING_RESTORE_MAX_ENTRIES + 5; index++) {
			rows[paradisBindingRestoreKey(`extra-${index}`)] = { pageId: `extra-${index}`, at: now - 1000 - index };
		}
		const parsed = paradisParseBindingRestoreLedger(JSON.stringify(rows), now);
		assert.deepStrictEqual({
			size: parsed.size,
			keepsNewest: parsed.get(keyA)?.pageId,
			dropsStale: parsed.has(keyB),
			dropsEmptyPage: parsed.has(keyC),
			dropsOldestExtra: parsed.has(paradisBindingRestoreKey(`extra-${PARADIS_BINDING_RESTORE_MAX_ENTRIES + 4}`)),
			notJson: paradisParseBindingRestoreLedger('{', now).size,
			array: paradisParseBindingRestoreLedger('[]', now).size,
		}, {
			size: PARADIS_BINDING_RESTORE_MAX_ENTRIES,
			keepsNewest: 'page-1',
			dropsStale: false,
			dropsEmptyPage: false,
			dropsOldestExtra: false,
			notJson: 0,
			array: 0,
		});
	});

	test('rewrites the rows of current bindings and keeps every row without one', () => {
		const previous = new Map([
			[keyA, { pageId: 'page-1', at: now - 10 }],
			[keyB, { pageId: 'page-2', at: now - 10 }],
			[keyC, { pageId: 'page-3', at: now - 10 }],
		]);
		// Startup: nothing is bound yet.
		const atStartup = paradisNextBindingRestoreLedger(previous, new Map(), now);
		// Later: A is shared with another page; B and C have no share (dropped, or their pane is not back).
		const later = paradisNextBindingRestoreLedger(atStartup, new Map([[keyA, 'page-9']]), now + 5);
		assert.deepStrictEqual({
			atStartup: [...atStartup],
			later: [...later].sort((a, b) => a[1].pageId.localeCompare(b[1].pageId)),
		}, {
			atStartup: [...previous],
			later: [[keyB, { pageId: 'page-2', at: now - 10 }], [keyC, { pageId: 'page-3', at: now - 10 }], [keyA, { pageId: 'page-9', at: now + 5 }]],
		});
	});

	test('does not rewrite the time of an unchanged binding until it gets old, but rewrites it when the origin changes', () => {
		const origins = new Map([['page-1', 'https://a.example']]);
		const previous = new Map([[keyA, { pageId: 'page-1', at: now, origins: { 'page-1': 'https://a.example' } }]]);
		const soon = paradisNextBindingRestoreLedger(previous, new Map([[keyA, 'page-1']]), now + 60_000, new Map(), origins);
		const navigated = paradisNextBindingRestoreLedger(previous, new Map([[keyA, 'page-1']]), now + 60_000, new Map(), new Map([['page-1', 'https://b.example']]));
		const later = paradisNextBindingRestoreLedger(previous, new Map([[keyA, 'page-1']]), now + PARADIS_BINDING_RESTORE_REFRESH_MS, new Map(), origins);
		assert.deepStrictEqual({
			soonSerializedUnchanged: paradisSerializeBindingRestoreLedger(soon) === paradisSerializeBindingRestoreLedger(previous),
			navigated: navigated.get(keyA),
			later: later.get(keyA),
		}, {
			soonSerializedUnchanged: true,
			navigated: { pageId: 'page-1', at: now + 60_000, origins: { 'page-1': 'https://b.example' } },
			later: { pageId: 'page-1', at: now + PARADIS_BINDING_RESTORE_REFRESH_MS, origins: { 'page-1': 'https://a.example' } },
		});
	});

	test('offers only the same pane and the same page on the same origin, once both are back and the pane is not bound yet', () => {
		const origins = { 'page-1': 'https://a.example', 'page-2': 'https://a.example', 'page-3': 'https://a.example' };
		const ledger = new Map([
			[keyA, { pageId: 'page-1', at: now, origins }],
			[keyB, { pageId: 'page-2', at: now, origins }],
			[keyC, { pageId: 'page-3', at: now, origins }],
		]);
		const live = new Map([[keyA, 'token-a'], [keyB, 'token-b'], [keyC, 'token-c']]);
		const sameOrigin = () => 'https://a.example';
		assert.deepStrictEqual({
			ready: paradisBindingRestoreCandidates(ledger, live, new Set([keyB]), new Set(['page-1', 'page-2']), sameOrigin),
			paneMissing: paradisBindingRestoreCandidates(ledger, new Map(), new Set(), new Set(['page-1']), sameOrigin),
			moved: paradisBindingRestoreCandidates(ledger, live, new Set([keyB, keyC]), new Set(['page-1']), () => 'https://b.example'),
			originUnknownYet: paradisBindingRestoreCandidates(ledger, live, new Set([keyB, keyC]), new Set(['page-1']), () => undefined),
			legacyRow: paradisBindingRestoreCandidates(new Map([[keyA, { pageId: 'page-1', at: now }]]), live, new Set(), new Set(['page-1']), sameOrigin),
		}, {
			ready: { candidates: [{ key: keyA, token: 'token-a', pageId: 'page-1', morePageIds: [], origins }], dropped: [] },
			paneMissing: { candidates: [], dropped: [] },
			moved: { candidates: [], dropped: [{ key: keyA, pageId: 'page-1', reason: 'moved' }] },
			originUnknownYet: { candidates: [], dropped: [] },
			legacyRow: { candidates: [], dropped: [{ key: keyA, pageId: 'page-1', reason: 'unverified' }] },
		});
	});

	test('compares pages by scheme and host, and cannot compare a URL it cannot read', () => {
		assert.deepStrictEqual([
			'https://App.Example/path?q=1#x',
			'https://app.example:8443/',
			'http://localhost:3000/a',
			'file:///home/example/a.html',
			'about:blank',
			'not a url',
			'',
			undefined,
		].map(paradisBindingRestoreOrigin), ['https://app.example', 'https://app.example:8443', 'http://localhost:3000', 'file://', 'about://', undefined, undefined, undefined]);
	});

	// 1 つのペインへ複数のページを共有していたら、current のほかのページも古い順に控える
	test('keeps the other pages a pane shares, oldest first, and offers the ones that are back', () => {
		const origin = new Map(['page-1', 'page-2', 'page-3'].map(pageId => [pageId, 'https://a.example']));
		const next = paradisNextBindingRestoreLedger(new Map(), new Map([[keyA, 'page-3']]), now, new Map([[keyA, ['page-1', 'page-2', 'page-3', 'page-1']]]), origin);
		const parsed = paradisParseBindingRestoreLedger(paradisSerializeBindingRestoreLedger(next), now);
		// 前の版の Para Code が書いた台帳（more・origins 無し）と、壊れた more・origins も読める
		const legacy = paradisParseBindingRestoreLedger(JSON.stringify({ [keyB]: { pageId: 'page-5', at: now }, [keyC]: { pageId: 'page-6', at: now, more: [1, '', 'page-7'], origins: { 'page-6': 5, 'page-7': 'https://a.example', 'page-8': 'https://a.example' } } }), now);
		const live = new Map([[keyA, 'token-a']]);
		const origins = { 'page-2': 'https://a.example', 'page-1': 'https://a.example', 'page-3': 'https://a.example' };
		assert.deepStrictEqual({
			entry: parsed.get(keyA),
			legacy: [...legacy.values()],
			candidates: paradisBindingRestoreCandidates(parsed, live, new Set(), new Set(['page-2', 'page-3']), () => 'https://a.example').candidates,
			// current のページが無くなっていたら、2 枚目以降のうち最後に共有した生きているページを current として戻す
			withoutCurrent: paradisBindingRestoreCandidates(parsed, live, new Set(), new Set(['page-1', 'page-2']), () => 'https://a.example').candidates,
			// 行から 1 ページを外す（current を外したら、残りの最後が current になる）
			removed: [paradisRemovePageFromBindingRestoreEntry(next.get(keyA) ?? { pageId: 'page-3', at: now }, 'page-3'), paradisRemovePageFromBindingRestoreEntry({ pageId: 'page-1', at: now }, 'page-1')],
		}, {
			entry: { pageId: 'page-3', at: now, more: ['page-2', 'page-1'], origins },
			legacy: [{ pageId: 'page-5', at: now }, { pageId: 'page-6', at: now, more: ['page-7'], origins: { 'page-7': 'https://a.example' } }],
			candidates: [{ key: keyA, token: 'token-a', pageId: 'page-3', morePageIds: ['page-2'], origins }],
			withoutCurrent: [{ key: keyA, token: 'token-a', pageId: 'page-1', morePageIds: ['page-2'], origins }],
			removed: [{ pageId: 'page-1', at: now, more: ['page-2'], origins: { 'page-2': 'https://a.example', 'page-1': 'https://a.example' } }, undefined],
		});
	});
});
