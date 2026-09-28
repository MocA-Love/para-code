/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getParadisChangelogFeedUrl, resolveParadisUpdateChannel } from '../../common/paradisUpdateChannel.js';

suite('ParadisUpdateChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves the channel as setting > stamped channel > quality', () => {
		const cases: { name: string; quality?: string; paradisUpdateChannel?: string; configuredChannel?: string }[] = [
			{ name: 'stable build', quality: 'stable' },
			{ name: 'beta build', quality: 'stable', paradisUpdateChannel: 'beta' },
			{ name: 'setting wins over stamp', quality: 'stable', paradisUpdateChannel: 'beta', configuredChannel: 'stable' },
			{ name: 'setting wins over quality', quality: 'stable', configuredChannel: 'beta' },
			{ name: 'empty stamp', quality: 'stable', paradisUpdateChannel: '' },
			{ name: 'blank stamp', quality: 'stable', paradisUpdateChannel: '  ' },
			{ name: 'stamp with spaces is trimmed', quality: 'stable', paradisUpdateChannel: ' beta ' },
			{ name: 'unsafe stamp', quality: 'stable', paradisUpdateChannel: 'beta/../stable' },
			{ name: 'uppercase stamp', quality: 'stable', paradisUpdateChannel: 'Beta' },
			{ name: 'unsafe setting', quality: 'stable', paradisUpdateChannel: 'beta', configuredChannel: '../x' },
			{ name: 'no quality' },
			{ name: 'no quality, beta stamp', paradisUpdateChannel: 'beta' },
		];

		assert.deepStrictEqual(
			cases.map(({ name, quality, paradisUpdateChannel, configuredChannel }) => [name, resolveParadisUpdateChannel({ quality, paradisUpdateChannel }, configuredChannel)]),
			[
				['stable build', 'stable'],
				['beta build', 'beta'],
				['setting wins over stamp', 'stable'],
				['setting wins over quality', 'beta'],
				['empty stamp', 'stable'],
				['blank stamp', 'stable'],
				['stamp with spaces is trimmed', 'beta'],
				['unsafe stamp', 'stable'],
				['uppercase stamp', 'stable'],
				['unsafe setting', 'beta'],
				['no quality', undefined],
				['no quality, beta stamp', 'beta'],
			]
		);
	});

	test('builds the changelog URL for the same channel as the update feed', () => {
		const updateUrl = 'https://updates.example';

		assert.deepStrictEqual([
			getParadisChangelogFeedUrl({ updateUrl, quality: 'stable' }),
			getParadisChangelogFeedUrl({ updateUrl, quality: 'stable', paradisUpdateChannel: 'beta' }),
			getParadisChangelogFeedUrl({ updateUrl, quality: 'stable', paradisUpdateChannel: 'beta' }, 'stable'),
			getParadisChangelogFeedUrl({ updateUrl }),
			getParadisChangelogFeedUrl({ quality: 'stable', paradisUpdateChannel: 'beta' }),
		], [
			'https://updates.example/api/changelog/stable',
			'https://updates.example/api/changelog/beta',
			'https://updates.example/api/changelog/stable',
			'https://updates.example/api/changelog/stable',
			undefined,
		]);
	});
});
