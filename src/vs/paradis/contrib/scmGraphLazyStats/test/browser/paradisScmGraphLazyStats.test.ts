/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISCMHistoryItem, ISCMHistoryItemViewModel, ISCMHistoryProvider } from '../../../../../workbench/contrib/scm/common/history.js';
import { ISCMProvider } from '../../../../../workbench/contrib/scm/common/scm.js';
import { paradisSetupScmGraphLazyStats } from '../../browser/paradisScmGraphLazyStats.js';
import { IParadisScmGraphStats, ParadisScmGraphStatsCache } from '../../common/paradisScmGraphStatsCache.js';

suite('Paradis SCM graph lazy stats hover', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const stats: IParadisScmGraphStats = { files: 21, insertions: 1359, deletions: 44 };

	/** 呼ばれるたびに保留の約束を作る resolveHistoryItem。 */
	function createFixture(historyItem: Partial<ISCMHistoryItem> = {}, kind: ISCMHistoryItemViewModel['kind'] = 'node') {
		const pending: { token: CancellationToken; result: DeferredPromise<IParadisScmGraphStats | undefined> }[] = [];
		const historyProvider = {
			resolveHistoryItem: async (_id: string, token?: CancellationToken) => {
				const result = new DeferredPromise<IParadisScmGraphStats | undefined>();
				pending.push({ token: token ?? CancellationToken.None, result });
				const value = await result.p;
				return value === undefined ? undefined : { id: 'c1', parentIds: [], subject: '', message: '', statistics: value };
			}
		} as Pick<ISCMHistoryProvider, 'resolveHistoryItem'> as ISCMHistoryProvider;
		const provider = { id: 'git0', historyProvider: constObservable(historyProvider) } as Pick<ISCMProvider, 'id' | 'historyProvider'> as ISCMProvider;
		const viewModel = { historyItem: { id: 'c1', parentIds: [], subject: '', message: '', ...historyItem }, kind } as Pick<ISCMHistoryItemViewModel, 'historyItem' | 'kind'> as ISCMHistoryItemViewModel;

		const content = document.createElement('div');
		for (const name of ['author', 'refs', 'commands']) {
			const section = document.createElement('div');
			section.className = name;
			content.appendChild(section);
		}
		const lazyStats = store.add(paradisSetupScmGraphLazyStats(content, provider, viewModel, new ParadisScmGraphStatsCache()));
		const sections = () => [...content.children].map(child => child.classList.contains('paradis-scm-graph-lazy-stats') ? `stats: ${child.textContent}` : child.className);
		return { pending, lazyStats, sections };
	}

	test('shows a counting line under the message, then replaces it with the numbers', async () => {
		const { pending, lazyStats, sections } = createFixture();

		const before = sections();
		lazyStats.hoverOptions.onDidShow?.();
		const counting = sections();
		pending[0].result.complete(stats);
		await timeout(0);

		assert.deepStrictEqual({ before, counting, done: sections() }, {
			before: ['author', 'refs', 'commands'],
			counting: ['author', 'stats: 変更量を数えています…', 'refs', 'commands'],
			done: ['author', 'stats: 21 個のファイルが変更済み, 1359 個の挿入(+), 44 個の削除(-)', 'refs', 'commands'],
		});
	});

	test('clears the counting line when the hover hides, joins the same query when it comes back, and reuses the count', async () => {
		const { pending, lazyStats, sections } = createFixture();

		lazyStats.hoverOptions.onDidShow?.();
		lazyStats.hoverOptions.onDidHide?.();
		const afterHide = { sections: sections(), queryCancelled: pending[0].token.isCancellationRequested };

		lazyStats.hoverOptions.onDidShow?.();
		pending[0].result.complete(stats);
		await timeout(0);
		lazyStats.hoverOptions.onDidHide?.();
		lazyStats.hoverOptions.onDidShow?.();

		assert.deepStrictEqual({ afterHide, queries: pending.length, shown: sections() }, {
			afterHide: { sections: ['author', 'refs', 'commands'], queryCancelled: false },
			queries: 1,
			shown: ['author', 'stats: 21 個のファイルが変更済み,\u00a01359 個の挿入(+),\u00a044 個の削除(-)', 'refs', 'commands'],
		});
	});

	test('removes the counting line when the count fails or finds no change', async () => {
		const { pending, lazyStats, sections } = createFixture();

		lazyStats.hoverOptions.onDidShow?.();
		pending[0].result.complete(undefined);
		await timeout(0);
		const failed = sections();
		lazyStats.hoverOptions.onDidHide?.();
		lazyStats.hoverOptions.onDidShow?.();
		pending[1].result.complete({ files: 0, insertions: 0, deletions: 0 });
		await timeout(0);

		assert.deepStrictEqual({ failed, empty: sections() }, { failed: ['author', 'refs', 'commands'], empty: ['author', 'refs', 'commands'] });
	});

	test('leaves rows alone when the provider already gave stats or the row is not a commit', () => {
		const withStats = createFixture({ statistics: stats });
		const incoming = createFixture({}, 'incoming-changes');

		assert.deepStrictEqual([withStats.lazyStats.hoverOptions, incoming.lazyStats.hoverOptions], [{}, {}]);
	});
});
