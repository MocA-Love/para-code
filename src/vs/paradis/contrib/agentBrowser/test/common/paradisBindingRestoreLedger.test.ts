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
	paradisNextBindingRestoreLedger,
	paradisParseBindingRestoreLedger,
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

	test('keeps current bindings and untried startup rows, and forgets unshared, closed or vanished ones', () => {
		const previous = new Map([
			[keyA, { pageId: 'page-1', at: now - 10 }],
			[keyB, { pageId: 'page-2', at: now - 10 }],
			[keyC, { pageId: 'page-3', at: now - 10 }],
		]);
		// Startup: nothing is bound yet, every row is still waiting to be restored.
		const atStartup = paradisNextBindingRestoreLedger(previous, new Set([keyA, keyB, keyC]), new Map(), now);
		// Later: A was restored, B was tried (the user declined or the page was closed), C's pane never came back.
		const later = paradisNextBindingRestoreLedger(atStartup, new Set(), new Map([[keyA, 'page-1']]), now);
		// The user moved A to another page.
		const moved = paradisNextBindingRestoreLedger(later, new Set(), new Map([[keyA, 'page-9']]), now + 5);
		assert.deepStrictEqual({
			atStartup: [...atStartup.keys()].sort(),
			later: [...later],
			moved: [...moved],
		}, {
			atStartup: [keyA, keyB, keyC].sort(),
			later: [[keyA, { pageId: 'page-1', at: now - 10 }]],
			moved: [[keyA, { pageId: 'page-9', at: now + 5 }]],
		});
	});

	test('does not rewrite the time of an unchanged binding until it gets old', () => {
		const previous = new Map([[keyA, { pageId: 'page-1', at: now }]]);
		const soon = paradisNextBindingRestoreLedger(previous, new Set(), new Map([[keyA, 'page-1']]), now + 60_000);
		const later = paradisNextBindingRestoreLedger(previous, new Set(), new Map([[keyA, 'page-1']]), now + PARADIS_BINDING_RESTORE_REFRESH_MS);
		assert.deepStrictEqual({
			soonSerializedUnchanged: paradisSerializeBindingRestoreLedger(soon) === paradisSerializeBindingRestoreLedger(previous),
			later: later.get(keyA),
		}, {
			soonSerializedUnchanged: true,
			later: { pageId: 'page-1', at: now + PARADIS_BINDING_RESTORE_REFRESH_MS },
		});
	});

	test('offers only the same pane and the same page, once both are back and the pane is not bound yet', () => {
		const ledger = new Map([
			[keyA, { pageId: 'page-1', at: now }],
			[keyB, { pageId: 'page-2', at: now }],
			[keyC, { pageId: 'page-3', at: now }],
		]);
		const live = new Map([[keyA, 'token-a'], [keyB, 'token-b'], [keyC, 'token-c']]);
		assert.deepStrictEqual({
			ready: paradisBindingRestoreCandidates(ledger, new Set([keyA, keyB, keyC]), live, new Set([keyB]), new Set(['page-1', 'page-2'])),
			paneMissing: paradisBindingRestoreCandidates(ledger, new Set([keyA]), new Map(), new Set(), new Set(['page-1'])),
			alreadyTried: paradisBindingRestoreCandidates(ledger, new Set(), live, new Set(), new Set(['page-1'])),
		}, {
			ready: [{ key: keyA, token: 'token-a', pageId: 'page-1' }],
			paneMissing: [],
			alreadyTried: [],
		});
	});
});
