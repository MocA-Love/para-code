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
		authority.trackWindow(7);
		authority.addConnection('window:7', oldConnection);
		const oldLease = authority.claim('window:7', oldConnection, 'old-session');
		authority.addConnection('window:7', newConnection);
		const newLease = authority.claim('window:7', newConnection, 'new-session');

		assert.strictEqual(oldLease?.rendererGeneration, 2);
		assert.strictEqual(newLease?.rendererGeneration, 3);
		assert.strictEqual(authority.validate(oldLease!).valid, false);
		assert.strictEqual(authority.validate(newLease!).valid, true);

		authority.removeConnection('window:7', oldConnection);
		assert.deepStrictEqual(authority.manifest().entries.map(entry => ({ windowId: entry.windowId, windowSession: entry.windowSession, rendererGeneration: entry.rendererGeneration, claimed: entry.claimed })), [
			{ ...newLease!, claimed: true },
		]);
	});

	test('未claimの特殊windowをmanifestへ混ぜずcontext外からのclaimを拒否する', () => {
		const authority = new ParadisMobileRendererLeaseAuthority();
		const connection = {};
		authority.addConnection('window:3', connection);

		assert.deepStrictEqual(authority.manifest().entries, []);
		assert.strictEqual(authority.claim('shared-process', connection, 'forged'), undefined);
	});

	test('遅延した旧connectionのclaimを新世代へ結び付けない', () => {
		const authority = new ParadisMobileRendererLeaseAuthority();
		const oldConnection = {};
		const newConnection = {};
		authority.trackWindow(7);
		authority.addConnection('window:7', oldConnection);
		authority.addConnection('window:7', newConnection);

		assert.strictEqual(authority.claim('window:7', oldConnection, 'old-session'), undefined);
		assert.deepStrictEqual(authority.claim('window:7', newConnection, 'new-session'), {
			windowId: 7,
			windowSession: 'new-session',
			rendererGeneration: 3,
		});
	});

	test('実workbench windowはclaim前からpending manifestへ現れる', () => {
		const authority = new ParadisMobileRendererLeaseAuthority();
		authority.trackWindow(11);

		assert.deepStrictEqual(authority.manifest().entries, [{
			windowId: 11,
			rendererGeneration: 1,
			windowRevision: 1,
			claimed: false,
		}]);
	});

	test('claim済みwindowはreloadのIPC gap中もpending manifestへ残りdestroy時だけ消える', () => {
		const authority = new ParadisMobileRendererLeaseAuthority();
		const connection = {};
		authority.trackWindow(5);
		authority.addConnection('window:5', connection);
		authority.claim('window:5', connection, 'session');
		authority.removeConnection('window:5', connection);

		const pending = authority.manifest();
		assert.strictEqual(pending.entries.length, 1);
		assert.strictEqual(pending.entries[0]?.claimed, false);
		assert.strictEqual(authority.destroyWindow(5), true);
		assert.deepStrictEqual(authority.manifest().entries, []);
		assert.ok(authority.manifest().revision > pending.revision);
	});
});
