/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisBrowserProfile,
	PARADIS_BROWSER_PROFILE_COLORS,
	paradisDeserializeProfiles,
	paradisFindProfileByName,
	paradisIsDuplicateProfileName,
	paradisNormalizeProfileName,
	paradisSerializeProfiles,
} from '../../common/paradisBrowserProfileModel.js';

function profile(id: string, name: string): IParadisBrowserProfile {
	return { id, name, color: PARADIS_BROWSER_PROFILE_COLORS[0], createdAt: 1, lastUsedAt: 2 };
}

suite('paradisBrowserProfileModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names are trimmed, collapsed, and capped at 64 characters', () => {
		assert.deepStrictEqual(
			[
				paradisNormalizeProfileName('  PRD  '),
				paradisNormalizeProfileName('検証用\t\nアカウント   A'),
				paradisNormalizeProfileName('x'.repeat(80)).length,
			],
			['PRD', '検証用 アカウント A', 64],
		);
	});

	test('name matching is NFKC- and case-insensitive, so an agent can pass any spelling', () => {
		const profiles = [profile('a3f19c2b7e04', 'TEST')];
		assert.deepStrictEqual(
			[
				paradisFindProfileByName(profiles, 'test')?.id,
				paradisFindProfileByName(profiles, 'ＴＥＳＴ')?.id,
				paradisFindProfileByName(profiles, '  Test  ')?.id,
				paradisFindProfileByName(profiles, 'TES')?.id,
				paradisFindProfileByName(profiles, '')?.id,
			],
			['a3f19c2b7e04', 'a3f19c2b7e04', 'a3f19c2b7e04', undefined, undefined],
		);
	});

	test('duplicate detection uses the same matching, and ignores the profile being renamed', () => {
		const profiles = [profile('a3f19c2b7e04', 'TEST'), profile('b1c2d3e4f506', 'PRD')];
		assert.deepStrictEqual(
			[
				paradisIsDuplicateProfileName(profiles, 'test'),
				paradisIsDuplicateProfileName(profiles, 'test', 'a3f19c2b7e04'),
				paradisIsDuplicateProfileName(profiles, 'STAGING'),
			],
			[true, false, false],
		);
	});

	test('the ledger round-trips, and corrupt or partial entries degrade to an empty/filtered list', () => {
		const profiles = [profile('a3f19c2b7e04', 'TEST'), profile('b1c2d3e4f506', 'PRD')];
		assert.deepStrictEqual(paradisDeserializeProfiles(paradisSerializeProfiles(profiles)), profiles);

		assert.deepStrictEqual(
			[
				paradisDeserializeProfiles(undefined),
				paradisDeserializeProfiles(''),
				paradisDeserializeProfiles('{ not json'),
				paradisDeserializeProfiles('{"id":"a3f19c2b7e04"}'),
				// 壊れた1件（不正なID・名前なし）と重複IDは捨て、読める分だけ残す。
				paradisDeserializeProfiles(JSON.stringify([
					{ id: 'nope', name: 'X', color: '#fff', createdAt: 1, lastUsedAt: 2 },
					{ id: 'a3f19c2b7e04', name: '   ', color: '#fff', createdAt: 1, lastUsedAt: 2 },
					{ id: 'a3f19c2b7e04', name: 'TEST', color: PARADIS_BROWSER_PROFILE_COLORS[0], createdAt: 1, lastUsedAt: 2 },
					{ id: 'a3f19c2b7e04', name: 'TEST duplicate id', color: '#fff', createdAt: 9, lastUsedAt: 9 },
				])),
			],
			[[], [], [], [], [profile('a3f19c2b7e04', 'TEST')]],
		);
	});
});
