/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCoerceGithubStatusMaxAge, ParadisGithubLookupCache, paradisGithubStatusMaxAge } from '../../common/paradisGithubLookupCache.js';

suite('ParadisGithubLookupCache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reuses values within the lifetime, keeps final ones forever and the last one after expiry', () => {
		let now = 0;
		const cache = new ParadisGithubLookupCache<string | undefined>(1000, 10, value => value === 'closed', () => now);
		cache.set('open', 'open');
		cache.set('closed', 'closed');
		cache.set('none', undefined);
		const within = { open: cache.getFresh('open'), closed: cache.getFresh('closed'), none: cache.getFresh('none') };
		now = 1000;
		const expired = { open: cache.getFresh('open'), closed: cache.getFresh('closed'), none: cache.getFresh('none'), lastOpen: cache.getLast('open') };

		assert.deepStrictEqual({ within, expired }, {
			within: { open: { value: 'open' }, closed: { value: 'closed' }, none: { value: undefined } },
			expired: { open: undefined, closed: { value: 'closed' }, none: undefined, lastOpen: { value: 'open' } },
		});
	});

	test('drops the least recently stored entries beyond the limit', () => {
		const cache = new ParadisGithubLookupCache<number>(1000, 2, undefined, () => 0);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('a', 3);
		cache.set('c', 4);

		assert.deepStrictEqual([cache.getLast('a'), cache.getLast('b'), cache.getLast('c')], [{ value: 3 }, undefined, { value: 4 }]);
	});

	test('picks 5 minutes for the current space and 15 for the others, and bounds what arrives over IPC', () => {
		assert.deepStrictEqual({
			active: paradisGithubStatusMaxAge(true),
			other: paradisGithubStatusMaxAge(false),
			// 古いクライアントは間隔を渡さない。今いるスペースと同じに扱う
			missing: paradisCoerceGithubStatusMaxAge(undefined),
			tooLong: paradisCoerceGithubStatusMaxAge(86_400_000),
			negative: paradisCoerceGithubStatusMaxAge(-1),
		}, { active: 270_000, other: 870_000, missing: 270_000, tooLong: 870_000, negative: 0 });
	});

	test('shares a running fetch for the same key', async () => {
		const cache = new ParadisGithubLookupCache<number>(1000, 10);
		let fetches = 0;
		const fetch = async () => {
			const value = ++fetches;
			await Promise.resolve();
			return value;
		};

		const results = await Promise.all([cache.dedupe('a', fetch), cache.dedupe('a', fetch), cache.dedupe('b', fetch)]);
		const later = await cache.dedupe('a', fetch);

		assert.deepStrictEqual({ results, later, fetches }, { results: [1, 1, 2], later: 3, fetches: 3 });
	});
});
