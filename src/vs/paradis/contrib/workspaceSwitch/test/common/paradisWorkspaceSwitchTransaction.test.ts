/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisWorkspaceSwitchTransaction, paradisParseWorkspaceSwitchTransactions, paradisSerializeWorkspaceSwitchTransactions, paradisWorkspaceSwitchRecoveryEndpoint } from '../../common/paradisWorkspaceSwitchTransaction.js';

suite('paradisWorkspaceSwitchTransaction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips an interrupted target-applied switch', () => {
		const transaction: IParadisWorkspaceSwitchTransaction = {
			version: 1,
			id: 'transaction-a',
			createdAt: 1,
			fromStateKey: 'space:a',
			fromUri: 'file:///a',
			toStateKey: 'space:b',
			toUri: 'file:///b',
			phase: 'targetApplied',
		};
		assert.deepStrictEqual(paradisParseWorkspaceSwitchTransactions(paradisSerializeWorkspaceSwitchTransactions([transaction])), [transaction]);
	});

	test('rejects a partial transaction instead of guessing a recovery target', () => {
		assert.deepStrictEqual(paradisParseWorkspaceSwitchTransactions('{"version":1,"entries":[{"fromStateKey":"space:a"}]}'), []);
	});

	test('does not apply a Working Set before its phase proves that snapshot is safe', () => {
		assert.deepStrictEqual({
			startedFrom: paradisWorkspaceSwitchRecoveryEndpoint('started', 'from'),
			startedTo: paradisWorkspaceSwitchRecoveryEndpoint('started', 'to'),
			sourceCapturedFrom: paradisWorkspaceSwitchRecoveryEndpoint('sourceCaptured', 'from'),
			sourceCapturedTo: paradisWorkspaceSwitchRecoveryEndpoint('sourceCaptured', 'to'),
		}, {
			startedFrom: undefined,
			startedTo: undefined,
			sourceCapturedFrom: 'from',
			sourceCapturedTo: undefined,
		});
	});

	test('uses the folder endpoint after target apply', () => {
		for (const phase of ['targetApplied', 'foldersCommitted'] as const) {
			assert.strictEqual(paradisWorkspaceSwitchRecoveryEndpoint(phase, 'from'), 'from');
			assert.strictEqual(paradisWorkspaceSwitchRecoveryEndpoint(phase, 'to'), 'to');
		}
	});

	test('never serializes a journal that its own reader rejects for size', () => {
		const transactions = Array.from({ length: 128 }, (_, index): IParadisWorkspaceSwitchTransaction => ({
			version: 1,
			id: `transaction-${index}`,
			createdAt: index + 1,
			ownerWindowId: 1,
			fromStateKey: `space:${'a'.repeat(100)}`,
			fromUri: `file:///${'a'.repeat(100)}`,
			toStateKey: `space:${'b'.repeat(100)}`,
			toUri: `file:///${'b'.repeat(100)}`,
			phase: 'sourceCaptured',
		}));
		const raw = paradisSerializeWorkspaceSwitchTransactions(transactions);
		assert.ok(raw.length <= 32_768);
		assert.ok(paradisParseWorkspaceSwitchTransactions(raw).length > 0);
	});
});
