/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisBrowserLiveEntry,
	IParadisBrowserLiveViewState,
	PARADIS_BROWSER_LIVE_MAX_COLUMNS,
	paradisBrowserLiveCaptureDelayMs,
	paradisBrowserLiveDisplayTitle,
	paradisBrowserLiveDisplayUrl,
	paradisBrowserLiveInActiveSpace,
	paradisBrowserLiveRetryDelayMs,
	paradisDefaultBrowserLiveViewState,
	paradisFilterBrowserLiveEntries,
	paradisGroupBrowserLiveEntries,
	paradisHasBrowserLiveFilter,
	paradisParseBrowserLiveViewState,
	paradisSerializeBrowserLiveViewState,
	paradisSortBrowserLiveEntries,
	paradisSummarizeBrowserLiveEntries,
} from '../../common/paradisBrowserLiveWindow.js';

function entry(viewId: string, options: Partial<IParadisBrowserLiveEntry> = {}): IParadisBrowserLiveEntry {
	return {
		viewId,
		title: `title-${viewId}`,
		url: `https://example.com/${viewId}`,
		favicon: undefined,
		loading: false,
		errorText: undefined,
		visible: false,
		agents: [],
		order: 0,
		stateKey: 'space-a',
		spaceName: 'repo / main',
		spaceColor: '#4d78cc',
		inActiveSpace: true,
		...options,
	};
}

function state(overrides: Partial<IParadisBrowserLiveViewState> = {}): IParadisBrowserLiveViewState {
	return { ...paradisDefaultBrowserLiveViewState(), ...overrides };
}

suite('Paradis Browser Live Window', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('view state round-trips and repairs broken input', () => {
		const saved = paradisSerializeBrowserLiveViewState(state({
			columns: 5, sharedOnly: true, activeSpaceOnly: true, spaces: ['space-a'], hidden: ['view-1'],
			sort: 'space', group: 'none', cadence: 'smooth',
		}));
		assert.deepStrictEqual(paradisParseBrowserLiveViewState(saved), {
			columns: 5,
			sharedOnly: true,
			activeSpaceOnly: true,
			spaces: ['space-a'],
			hidden: ['view-1'],
			sort: 'space',
			group: 'none',
			cadence: 'smooth',
		});

		// 空のスペース配列は「すべて」に戻す (空の一覧を見せない)。
		assert.strictEqual(paradisParseBrowserLiveViewState(JSON.stringify({ spaces: [] })).spaces, undefined);

		// 壊れた値・未知の値・範囲外はすべて既定へ落ちる (起動不能にしない)。
		assert.deepStrictEqual(
			[
				paradisParseBrowserLiveViewState(undefined),
				paradisParseBrowserLiveViewState('not json'),
				paradisParseBrowserLiveViewState('null'),
				paradisParseBrowserLiveViewState(JSON.stringify({ sort: 'nope', group: 'nope', cadence: 'turbo', columns: 'many' })),
			],
			[
				paradisDefaultBrowserLiveViewState(),
				paradisDefaultBrowserLiveViewState(),
				paradisDefaultBrowserLiveViewState(),
				paradisDefaultBrowserLiveViewState(),
			],
		);

		assert.strictEqual(
			paradisParseBrowserLiveViewState(JSON.stringify({ columns: PARADIS_BROWSER_LIVE_MAX_COLUMNS + 10 })).columns,
			PARADIS_BROWSER_LIVE_MAX_COLUMNS,
		);
	});

	test('filters by sharing, space and the hidden list', () => {
		const entries = [
			entry('a', { agents: ['Claude'] }),
			entry('b'),
			entry('c', { agents: ['Codex', 'Claude'], stateKey: 'space-b', inActiveSpace: false }),
		];

		assert.deepStrictEqual(
			[
				paradisFilterBrowserLiveEntries(entries, state({ sharedOnly: true })).map(item => item.viewId),
				paradisFilterBrowserLiveEntries(entries, state({ activeSpaceOnly: true })).map(item => item.viewId),
				paradisFilterBrowserLiveEntries(entries, state({ sharedOnly: true, activeSpaceOnly: true })).map(item => item.viewId),
				paradisFilterBrowserLiveEntries(entries, state({ spaces: ['space-b'] })).map(item => item.viewId),
				paradisFilterBrowserLiveEntries(entries, state({ hidden: ['a', 'c'] })).map(item => item.viewId),
				paradisFilterBrowserLiveEntries(entries, state()).map(item => item.viewId),
				paradisSummarizeBrowserLiveEntries(entries),
				[
					paradisHasBrowserLiveFilter(state()),
					paradisHasBrowserLiveFilter(state({ hidden: ['a'] })),
					paradisHasBrowserLiveFilter(state({ spaces: ['space-a'] })),
				],
			],
			[
				['a', 'c'],
				['a', 'b'],
				['a'],
				['c'],
				['b'],
				['a', 'b', 'c'],
				{ total: 2, shared: 1, totalAll: 3, sharedAll: 2 },
				[false, true, true],
			],
		);
	});

	test('keeps the active space first, then applies the chosen order', () => {
		const entries = [
			entry('b', { title: 'Zebra', order: 1 }),
			entry('a', { title: 'Apple', order: 2, agents: ['Claude'] }),
			entry('c', { title: 'Mango', order: 0 }),
			// 別スペースのページは、どの並びでも手元のページの後ろへ回す。
			entry('d', { title: 'Alpha', order: 3, agents: ['Codex'], stateKey: 'space-b', inActiveSpace: false }),
		];

		assert.deepStrictEqual(
			[
				paradisSortBrowserLiveEntries(entries, state({ sort: 'editor' })).map(item => item.viewId),
				paradisSortBrowserLiveEntries(entries, state({ sort: 'title' })).map(item => item.viewId),
				paradisSortBrowserLiveEntries(entries, state({ sort: 'shared' })).map(item => item.viewId),
				paradisSortBrowserLiveEntries(entries, state({ sort: 'space' })).map(item => item.viewId),
			],
			[
				['c', 'b', 'a', 'd'],
				['a', 'c', 'b', 'd'],
				['a', 'c', 'b', 'd'],
				// スペース名は同じなので、手元のぶんはタブの並びのまま。別スペースは後ろ。
				['c', 'b', 'a', 'd'],
			],
		);
	});

	test('groups by space in the order the tiles already have', () => {
		const entries = [
			entry('a', { order: 0 }),
			entry('c', { order: 1, stateKey: 'space-b', spaceName: 'shop / cart', spaceColor: '#b180d7', inActiveSpace: false }),
			entry('b', { order: 2 }),
			entry('d', { order: 3, stateKey: undefined, spaceName: '', spaceColor: undefined }),
		];
		const sorted = paradisSortBrowserLiveEntries(entries, state());

		assert.deepStrictEqual(
			[
				paradisGroupBrowserLiveEntries(sorted, state({ group: 'space' }), 'unknown')
					.map(group => [group.label, group.color, group.entries.map(item => item.viewId)]),
				paradisGroupBrowserLiveEntries(sorted, state({ group: 'none' }), 'unknown')
					.map(group => [group.label, group.entries.map(item => item.viewId)]),
			],
			[
				[
					['repo / main', '#4d78cc', ['a', 'b']],
					['unknown', undefined, ['d']],
					['shop / cart', '#b180d7', ['c']],
				],
				[['', ['a', 'b', 'd', 'c']]],
			],
		);
	});

	test('treats only proven members of the active space as local', () => {
		// 'pending' は「手元のもの」ではなく「まだ分からない」。ウィンドウのリロード後に
		// 他スペースのページが恒久的に pending で残るため、ここを倒すと別スペースのタブに
		// 閉じる・再読み込みが出てしまう。
		assert.deepStrictEqual(
			[
				paradisBrowserLiveInActiveSpace({ kind: 'managed', stateKey: 'space-a' }, 'space-a'),
				paradisBrowserLiveInActiveSpace({ kind: 'managed', stateKey: 'space-b' }, 'space-a'),
				paradisBrowserLiveInActiveSpace({ kind: 'unscoped' }, 'space-a'),
				paradisBrowserLiveInActiveSpace({ kind: 'unscoped' }, undefined),
				paradisBrowserLiveInActiveSpace({ kind: 'pending' }, 'space-a'),
				paradisBrowserLiveInActiveSpace({ kind: 'pending' }, undefined),
				paradisBrowserLiveInActiveSpace({ kind: 'managed', stateKey: 'space-a' }, undefined),
			],
			[true, false, true, true, false, false, false],
		);
	});

	test('shows a readable title and url', () => {
		assert.deepStrictEqual(
			[
				paradisBrowserLiveDisplayTitle(entry('a', { title: '  Dashboard  ' })),
				paradisBrowserLiveDisplayTitle(entry('a', { title: '', url: 'https://www.example.com/path/' })),
				paradisBrowserLiveDisplayTitle(entry('a', { title: '', url: 'about:blank' })),
				paradisBrowserLiveDisplayUrl('http://localhost:3000/'),
				paradisBrowserLiveDisplayUrl('https://www.example.com/a?b=c'),
				paradisBrowserLiveDisplayUrl('   '),
			],
			[
				'Dashboard',
				'example.com/path',
				// allow-any-unicode-next-line
				'新しいタブ',
				'localhost:3000',
				'example.com/a?b=c',
				'',
			],
		);
	});

	test('keeps following hidden pages, just less often', () => {
		const shown = { visible: true };
		const hidden = { visible: false };

		assert.deepStrictEqual(
			[
				paradisBrowserLiveCaptureDelayMs('off', shown),
				paradisBrowserLiveCaptureDelayMs('off', hidden),
				paradisBrowserLiveCaptureDelayMs('normal', shown),
				paradisBrowserLiveCaptureDelayMs('normal', hidden),
				paradisBrowserLiveCaptureDelayMs('smooth', shown),
				paradisBrowserLiveCaptureDelayMs('smooth', hidden),
				paradisBrowserLiveRetryDelayMs(1000, 1),
				paradisBrowserLiveRetryDelayMs(1000, 3),
				paradisBrowserLiveRetryDelayMs(1000, 99),
				// 短い間隔でも、失敗時の待ちは1秒を下回らない。
				paradisBrowserLiveRetryDelayMs(350, 1),
			],
			[0, 0, 1000, 2500, 350, 1000, 1000, 4000, 8000, 1000],
		);
	});
});
