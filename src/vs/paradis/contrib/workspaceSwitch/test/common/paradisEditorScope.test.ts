/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisWorkingCopyOwnerLedger, ParadisWorkingCopyOwnerLedgerLoadState } from '../../common/paradisEditorScope.js';

suite('ParadisWorkingCopyOwnerLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const first = { resource: URI.parse('untitled:/Untitled-1'), typeId: '' };
	const sameResourceDifferentType = { resource: first.resource, typeId: 'notebook' };
	const second = { resource: URI.file('/workspace/file.txt'), typeId: 'file' };

	test('uses resource and typeId as the identity and round trips versioned storage', () => {
		const loaded = ParadisWorkingCopyOwnerLedger.load(undefined);
		assert.strictEqual(loaded.state, ParadisWorkingCopyOwnerLedgerLoadState.Missing);

		loaded.ledger.assign(first, 'space-a');
		loaded.ledger.assign(sameResourceDifferentType, 'space-b');
		loaded.ledger.assign(second, 'space-a');

		const restored = ParadisWorkingCopyOwnerLedger.load(loaded.ledger.serialize());
		assert.deepStrictEqual({
			state: restored.state,
			first: restored.ledger.ownerOf(first),
			typed: restored.ledger.ownerOf(sameResourceDifferentType),
			second: restored.ledger.ownerOf(second)
		}, {
			state: ParadisWorkingCopyOwnerLedgerLoadState.Valid,
			first: 'space-a',
			typed: 'space-b',
			second: 'space-a'
		});
	});

	test('treats malformed or unsupported storage as corrupt instead of legacy missing', () => {
		for (const raw of ['{', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ resource: 1 }] })]) {
			const loaded = ParadisWorkingCopyOwnerLedger.load(raw);
			assert.strictEqual(loaded.state, ParadisWorkingCopyOwnerLedgerLoadState.Corrupt);
			assert.strictEqual(loaded.ledger.entries.length, 0);
		}
	});

	test('rekeys same-uri corrections and retires only the requested scope', () => {
		const ledger = ParadisWorkingCopyOwnerLedger.load(undefined).ledger;
		ledger.assign(first, 'temporary');
		ledger.assign(second, 'other');

		ledger.rekey('temporary', 'space-a');
		const retired = ledger.retire('space-a');

		assert.deepStrictEqual({
			retired: retired.map(identifier => [identifier.resource.toString(), identifier.typeId]),
			first: ledger.ownerOf(first),
			second: ledger.ownerOf(second)
		}, {
			retired: [[first.resource.toString(), first.typeId]],
			first: undefined,
			second: 'other'
		});
	});

	test('releases a saved or closed Working Copy only when the expected owner still matches', () => {
		const ledger = ParadisWorkingCopyOwnerLedger.load(undefined).ledger;
		ledger.assign(first, 'space-a');

		assert.strictEqual(ledger.release(first, 'space-b'), false);
		assert.strictEqual(ledger.ownerOf(first), 'space-a');
		assert.strictEqual(ledger.release(first, 'space-a'), true);
		assert.strictEqual(ledger.ownerOf(first), undefined);
	});
});
