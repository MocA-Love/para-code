/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileRendererLeaseAuthority } from '../../common/paradisMobileWindowLease.js';

suite('ParadisMobileRendererLeaseAuthority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('同じwindowの再接続へ単調増加世代を発行し旧接続の切断で新世代を消さない', () => {
		const authority = new ParadisMobileRendererLeaseAuthority();
		const oldConnection = {};
		const newConnection = {};
		authority.addConnection('window:7', oldConnection);
		const oldLease = authority.claim('window:7', 'old-session');
		authority.addConnection('window:7', newConnection);
		const newLease = authority.claim('window:7', 'new-session');

		assert.strictEqual(oldLease?.rendererGeneration, 1);
		assert.strictEqual(newLease?.rendererGeneration, 2);
		assert.strictEqual(authority.validate(oldLease!), false);
		assert.strictEqual(authority.validate(newLease!), true);

		authority.removeConnection('window:7', oldConnection);
		assert.deepStrictEqual(authority.manifest(), [newLease]);
	});

	test('未claimの特殊windowをmanifestへ混ぜずcontext外からのclaimを拒否する', () => {
		const authority = new ParadisMobileRendererLeaseAuthority();
		authority.addConnection('window:3', {});

		assert.deepStrictEqual(authority.manifest(), []);
		assert.strictEqual(authority.claim('shared-process', 'forged'), undefined);
	});
});
