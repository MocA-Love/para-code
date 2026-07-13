/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileOperationLedger } from '../../node/paradisMobileOperationLedger.js';

suite('ParadisMobileOperationLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('実行中の重複operationIdを再配送せず完了後だけ結果を再生する', () => {
		const ledger = new ParadisMobileOperationLedger();
		const owner = { windowId: 1, windowSession: 'current' };

		assert.deepStrictEqual(ledger.begin('mobile', 'operation', owner), { kind: 'started' });
		assert.deepStrictEqual(ledger.begin('mobile', 'operation', owner), { kind: 'pending' });
		assert.strictEqual(ledger.complete('mobile', 'operation', owner, 'accepted'), true);
		assert.deepStrictEqual(ledger.begin('mobile', 'operation', owner), { kind: 'final', status: 'accepted' });
	});

	test('古いRenderer sessionからの完了を拒否する', () => {
		const ledger = new ParadisMobileOperationLedger();
		ledger.begin('mobile', 'operation', { windowId: 1, windowSession: 'current' });

		assert.strictEqual(ledger.complete('mobile', 'operation', { windowId: 1, windowSession: 'old' }, 'accepted'), false);
		assert.deepStrictEqual(ledger.begin('mobile', 'operation', { windowId: 1, windowSession: 'current' }), { kind: 'pending' });
	});

	test('所有者解決前の拒否結果も再生する', () => {
		const ledger = new ParadisMobileOperationLedger();
		ledger.finalize('mobile', 'operation', 'terminal-not-found');

		assert.deepStrictEqual(ledger.begin('mobile', 'operation', { windowId: 1, windowSession: 'current' }), { kind: 'final', status: 'terminal-not-found' });
	});

	test('Renderer交代時にそのleaseの実行中操作だけを失敗確定する', () => {
		const ledger = new ParadisMobileOperationLedger();
		ledger.begin('mobile-a', 'operation-a', { windowId: 1, windowSession: 'old' });
		ledger.begin('mobile-b', 'operation-b', { windowId: 2, windowSession: 'other' });

		assert.deepStrictEqual(ledger.finalizeOwner({ windowId: 1, windowSession: 'old' }, 'stale-renderer'), [
			{ mobileId: 'mobile-a', operationId: 'operation-a', status: 'stale-renderer' },
		]);
		assert.deepStrictEqual(ledger.lookup('mobile-a', 'operation-a'), { kind: 'final', status: 'stale-renderer' });
		assert.deepStrictEqual(ledger.lookup('mobile-b', 'operation-b'), { kind: 'pending' });
	});
});
