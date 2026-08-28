/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisBrowserProfilePartition,
	paradisBrowserProfileSessionId,
	paradisIsValidProfileId,
	paradisProfileIdFromSessionId,
	paradisProfileIdFromUuid,
} from '../../common/paradisBrowserProfileId.js';

suite('paradisBrowserProfileId', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a profile scope resolves to its own persist: partition and session id', () => {
		assert.deepStrictEqual(
			paradisBrowserProfilePartition({ scope: 'profile', profileId: 'a3f19c2b7e04' }),
			{
				partition: 'persist:paracode-browser-profile-a3f19c2b7e04',
				sessionId: 'profile:a3f19c2b7e04',
				profileId: 'a3f19c2b7e04',
			},
		);
	});

	test('the session id round-trips back to the profile id', () => {
		const profileId = 'a3f19c2b7e04';
		assert.strictEqual(paradisProfileIdFromSessionId(paradisBrowserProfileSessionId(profileId)), profileId);
	});

	test('built-in scopes and malformed ids never produce a profile partition', () => {
		// 既存の3スコープはそのまま upstream の switch へ落ちなければならない。
		assert.strictEqual(paradisBrowserProfilePartition({ scope: 'global' }), undefined);
		assert.strictEqual(paradisBrowserProfilePartition({ scope: 'workspace', profileId: 'a3f19c2b7e04' }), undefined);
		assert.strictEqual(paradisBrowserProfilePartition({ scope: 'ephemeral' }), undefined);
		// 壊れたIDをパーティション名へ持ち込ませない（Chromium のパーティション名として不正、
		// あるいは他のプロファイルと衝突しうるため）。
		assert.strictEqual(paradisBrowserProfilePartition({ scope: 'profile' }), undefined);
		assert.strictEqual(paradisBrowserProfilePartition({ scope: 'profile', profileId: '' }), undefined);
		assert.strictEqual(paradisBrowserProfilePartition({ scope: 'profile', profileId: 'A3F19C2B7E04' }), undefined);
		assert.strictEqual(paradisBrowserProfilePartition({ scope: 'profile', profileId: 'a3f19c2b7e0' }), undefined);
		assert.strictEqual(paradisBrowserProfilePartition({ scope: 'profile', profileId: '../../etc/passwd' }), undefined);
	});

	test('non-profile session ids are not read as profiles', () => {
		assert.deepStrictEqual(
			[
				paradisProfileIdFromSessionId('global'),
				paradisProfileIdFromSessionId('workspace:abc'),
				paradisProfileIdFromSessionId('ephemeral:abc'),
				paradisProfileIdFromSessionId('profile:nope'),
				paradisProfileIdFromSessionId(undefined),
			],
			[undefined, undefined, undefined, undefined, undefined],
		);
	});

	test('a uuid is reduced to a valid 12 hex profile id', () => {
		const profileId = paradisProfileIdFromUuid('A3F19C2B-7E04-4b1a-9f2c-0123456789ab');
		assert.strictEqual(profileId, 'a3f19c2b7e04');
		assert.ok(paradisIsValidProfileId(profileId));
	});
});
