/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisScmGraphStats, ParadisScmGraphStatsCache, paradisHasScmGraphStats } from '../../common/paradisScmGraphStatsCache.js';

suite('Paradis SCM graph stats cache', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const stats: IParadisScmGraphStats = { files: 21, insertions: 1359, deletions: 44 };

	/** 呼ばれた回数と、受け取った取り消しの合図を記録する数える関数。 */
	function createResolver() {
		const calls: CancellationToken[] = [];
		const deferred: DeferredPromise<IParadisScmGraphStats | undefined>[] = [];
		const resolve = (token: CancellationToken) => {
			calls.push(token);
			const promise = new DeferredPromise<IParadisScmGraphStats | undefined>();
			deferred.push(promise);
			return promise.p;
		};
		return { calls, deferred, resolve };
	}

	test('caches a result and shares one query between concurrent requests', async () => {
		const cache = new ParadisScmGraphStatsCache();
		const resolver = createResolver();

		const first = cache.request('a', resolver.resolve, CancellationToken.None);
		const second = cache.request('a', resolver.resolve, CancellationToken.None);
		resolver.deferred[0].complete(stats);
		const results = [await first, await second, await cache.request('a', resolver.resolve, CancellationToken.None)];

		assert.deepStrictEqual({ results, calls: resolver.calls.length, cached: cache.get('a') }, { results: [stats, stats, stats], calls: 1, cached: stats });
	});

	test('returns nothing to waiters that left, but still caches the result git finished with', async () => {
		const cache = new ParadisScmGraphStatsCache();
		const resolver = createResolver();
		const sourceA = new CancellationTokenSource();
		const sourceB = new CancellationTokenSource();

		const first = cache.request('a', resolver.resolve, sourceA.token);
		const second = cache.request('a', resolver.resolve, sourceB.token);
		sourceA.cancel();
		sourceB.cancel();
		const results = [await first, await second];
		const queryCancelled = resolver.calls[0].isCancellationRequested;
		resolver.deferred[0].complete(stats);
		await timeout(0);

		assert.deepStrictEqual({ results, queryCancelled, cached: cache.get('a') }, { results: [undefined, undefined], queryCancelled: false, cached: stats });
		sourceA.dispose();
		sourceB.dispose();
	});

	test('a hover that comes back before the left query finishes joins it instead of asking git again', async () => {
		const cache = new ParadisScmGraphStatsCache();
		const resolver = createResolver();
		const source = new CancellationTokenSource();

		const left = cache.request('a', resolver.resolve, source.token);
		source.cancel();
		const back = cache.request('a', resolver.resolve, CancellationToken.None);
		resolver.deferred[0].complete(stats);

		assert.deepStrictEqual({ left: await left, back: await back, calls: resolver.calls.length }, { left: undefined, back: stats, calls: 1 });
		source.dispose();
	});

	test('a waiter that stays still gets the result after another one leaves', async () => {
		const cache = new ParadisScmGraphStatsCache();
		const resolver = createResolver();
		const source = new CancellationTokenSource();

		const leaving = cache.request('a', resolver.resolve, source.token);
		const staying = cache.request('a', resolver.resolve, CancellationToken.None);
		source.cancel();
		resolver.deferred[0].complete(stats);

		assert.deepStrictEqual([await leaving, await staying, cache.get('a')], [undefined, stats, stats]);
		source.dispose();
	});

	test('does not cache failures or timeouts, so the next hover counts again', async () => {
		const cache = new ParadisScmGraphStatsCache(500, 1);
		const failed = await cache.request('fail', () => Promise.reject(new Error('git failed')), CancellationToken.None);
		const timedOut = await cache.request('slow', () => new Promise(resolve => setTimeout(() => resolve(stats), 50)), CancellationToken.None);

		assert.deepStrictEqual({ failed, timedOut, fail: cache.get('fail'), slow: cache.get('slow') }, { failed: undefined, timedOut: undefined, fail: undefined, slow: undefined });
	});

	test('keeps at most the configured number of commits, dropping the least recently used', async () => {
		const cache = new ParadisScmGraphStatsCache(2);
		await cache.request('a', async () => stats, CancellationToken.None);
		await cache.request('b', async () => stats, CancellationToken.None);
		cache.get('a');
		await cache.request('c', async () => stats, CancellationToken.None);

		assert.deepStrictEqual([cache.get('a'), cache.get('b'), cache.get('c')], [stats, undefined, stats]);
	});

	test('treats a commit without any change as having no stats line', () => {
		assert.deepStrictEqual(
			[paradisHasScmGraphStats(undefined), paradisHasScmGraphStats({ files: 0, insertions: 0, deletions: 0 }), paradisHasScmGraphStats({ files: 1, insertions: 0, deletions: 0 })],
			[false, false, true]
		);
	});
});
