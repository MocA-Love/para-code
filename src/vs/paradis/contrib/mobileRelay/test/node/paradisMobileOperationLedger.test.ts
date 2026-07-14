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
	const owner = { windowId: 1, windowSession: 'current', rendererGeneration: 4 };

	test('実行中の重複を再配送せず完了後だけ結果を再生する', () => {
		const ledger = new ParadisMobileOperationLedger();
		assert.deepStrictEqual(ledger.begin('mobile', 'operation', 3, 1, owner), { kind: 'started' });
		assert.deepStrictEqual(ledger.begin('mobile', 'operation', 3, 1, owner), { kind: 'pending' });
		assert.strictEqual(ledger.complete('mobile', 'operation', owner, 'accepted'), true);
		assert.deepStrictEqual(ledger.begin('mobile', 'operation', 3, 1, owner), { kind: 'final', status: 'accepted' });
	});

	test('詳細結果キャッシュから消えた同じrun/seqを再実行しない', () => {
		const ledger = new ParadisMobileOperationLedger(1);
		ledger.begin('mobile', 'old-operation', 8, 1, owner);
		ledger.finalize('mobile', 'old-operation', 'accepted');
		ledger.begin('mobile', 'new-operation', 8, 2, owner);
		ledger.finalize('mobile', 'new-operation', 'accepted');

		assert.deepStrictEqual(ledger.begin('mobile', 'old-operation', 8, 1, owner), { kind: 'unknown' });
	});

	test('timeoutを結果不明にして同じownerからの遅延完了を受理する', () => {
		const ledger = new ParadisMobileOperationLedger();
		ledger.begin('mobile', 'operation', 2, 9, owner);
		assert.strictEqual(ledger.markOutcomeUnknown('mobile', 'operation', owner), true);
		assert.deepStrictEqual(ledger.lookup('mobile', 'operation'), { kind: 'unknown' });
		assert.strictEqual(ledger.complete('mobile', 'operation', owner, 'accepted'), true);
		assert.deepStrictEqual(ledger.lookup('mobile', 'operation'), { kind: 'final', status: 'accepted' });
	});

	test('新しいmobile runを見た後は古いrunの未記録IDを実行しない', () => {
		const ledger = new ParadisMobileOperationLedger();
		ledger.begin('mobile', 'new-run', 5, 1, owner);

		assert.deepStrictEqual(ledger.begin('mobile', 'old-run', 4, 99, owner), { kind: 'unknown' });
	});

	test('別Renderer windowの高水位は保留操作へ影響しない', () => {
		const ledger = new ParadisMobileOperationLedger();
		const otherOwner = { windowId: 8, windowSession: 'other', rendererGeneration: 12 };
		assert.deepStrictEqual(ledger.begin('mobile', 'newer-other-window', 5, 11, otherOwner), { kind: 'started' });
		assert.deepStrictEqual(ledger.begin('mobile', 'older-this-window', 5, 10, owner), { kind: 'started' });
	});

	test('新しいmobile runは別Renderer windowにも世代防壁を適用する', () => {
		const ledger = new ParadisMobileOperationLedger();
		const otherOwner = { windowId: 8, windowSession: 'other', rendererGeneration: 12 };
		assert.deepStrictEqual(ledger.begin('mobile', 'new-run', 5, 1, owner), { kind: 'started' });
		assert.deepStrictEqual(ledger.begin('mobile', 'old-run-other-window', 4, 99, otherOwner), { kind: 'unknown' });
	});

	test('generationが異なるRendererからの完了を拒否する', () => {
		const ledger = new ParadisMobileOperationLedger();
		ledger.begin('mobile', 'operation', 1, 1, owner);

		assert.strictEqual(ledger.complete('mobile', 'operation', { ...owner, rendererGeneration: 3 }, 'accepted'), false);
		assert.deepStrictEqual(ledger.lookup('mobile', 'operation'), { kind: 'pending' });
	});

	test('結果不明の詳細を上限時に退避しても高水位で再実行を防ぐ', () => {
		const ledger = new ParadisMobileOperationLedger(1000, 1);
		ledger.begin('mobile', 'old', 1, 1, owner);
		ledger.markOutcomeUnknown('mobile', 'old', owner);

		assert.deepStrictEqual(ledger.begin('mobile', 'new', 1, 2, owner), { kind: 'started' });
		assert.deepStrictEqual(ledger.begin('mobile', 'old', 1, 1, owner), { kind: 'unknown' });
	});
});
