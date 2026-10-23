/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisPairingOfferSlot } from '../../common/paradisMobilePairingOffer.js';

suite('ParadisPairingOfferSlot', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 以前は SAS の計算を待つ間に 2 件目の要求が共有の公開鍵を書き換え、SAS で確かめた端末とは別の鍵が登録された
	test('a second request that comes while the first one\'s code is being computed does not replace its key', async () => {
		const slot = new ParadisPairingOfferSlot();
		const firstCode = new DeferredPromise<string>();
		const first = slot.offer({ pubKey: new Uint8Array([1]), name: 'first' }, () => firstCode.p);
		const second = await slot.offer({ pubKey: new Uint8Array([2]), name: 'second' }, async () => 'second-code');
		firstCode.complete('first-code');
		const shown = await first;
		assert.deepStrictEqual({ second, shown, kept: slot.shown }, {
			second: undefined,
			shown: { pubKey: new Uint8Array([1]), name: 'first', sasCode: 'first-code' },
			kept: { pubKey: new Uint8Array([1]), name: 'first', sasCode: 'first-code' },
		});
	});

	test('takes the next request only when the first one could not compute its code', async () => {
		const slot = new ParadisPairingOfferSlot();
		const failed = await slot.offer({ pubKey: new Uint8Array([1]) }, async () => { throw new Error('bad key'); }).then(() => 'resolved', () => 'rejected');
		const next = await slot.offer({ pubKey: new Uint8Array([2]) }, async () => 'code');
		assert.deepStrictEqual({ failed, next }, { failed: 'rejected', next: { pubKey: new Uint8Array([2]), sasCode: 'code' } });
	});
});
