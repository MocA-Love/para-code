/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAuxiliaryWindowScopeLedger, ParadisAuxiliaryWindowScopeLedgerLoadState } from '../../common/paradisAuxiliaryWindowScope.js';

suite('ParadisAuxiliaryWindowScopeLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('persists a fixed owner across changing live window ids', () => {
		const ledger = new ParadisAuxiliaryWindowScopeLedger();
		const entryId = ledger.create('scope:a', [10, 11]);

		assert.strictEqual(ledger.resolve([11]), 'scope:a');
		ledger.updateGroups(entryId, [20]);

		const restored = ParadisAuxiliaryWindowScopeLedger.load(ledger.serialize());
		assert.strictEqual(restored.state, ParadisAuxiliaryWindowScopeLedgerLoadState.Valid);
		assert.strictEqual(restored.ledger.resolve([20]), 'scope:a');
		assert.strictEqual(restored.ledger.resolve([10]), undefined);
	});

	test('does not guess when group ownership conflicts', () => {
		const ledger = new ParadisAuxiliaryWindowScopeLedger();
		ledger.create('scope:a', [10]);
		ledger.create('scope:b', [11]);

		assert.strictEqual(ledger.resolve([10, 11]), undefined);
	});

	test('reports missing and corrupt storage separately', () => {
		assert.strictEqual(
			ParadisAuxiliaryWindowScopeLedger.load(undefined).state,
			ParadisAuxiliaryWindowScopeLedgerLoadState.Missing
		);
		assert.strictEqual(
			ParadisAuxiliaryWindowScopeLedger.load('{broken').state,
			ParadisAuxiliaryWindowScopeLedgerLoadState.Corrupt
		);
	});

	test('retires every auxiliary window owned by a scope', () => {
		const ledger = new ParadisAuxiliaryWindowScopeLedger();
		const first = ledger.create('scope:a', [10]);
		ledger.create('scope:b', [20]);
		const second = ledger.create('scope:a', [30]);

		assert.deepStrictEqual(ledger.retire('scope:a').sort(), [first, second].sort());
		assert.strictEqual(ledger.resolve([10]), undefined);
		assert.strictEqual(ledger.resolve([20]), 'scope:b');
	});
});
