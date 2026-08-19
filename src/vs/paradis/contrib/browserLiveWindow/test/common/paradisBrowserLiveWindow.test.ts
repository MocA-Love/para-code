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
	paradisBrowserLiveRetryDelayMs,
	paradisDefaultBrowserLiveViewState,
	paradisFilterBrowserLiveEntries,
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
		...options,
	};
}

function state(overrides: Partial<IParadisBrowserLiveViewState> = {}): IParadisBrowserLiveViewState {
	return { ...paradisDefaultBrowserLiveViewState(), ...overrides };
}

suite('Paradis Browser Live Window', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('view state round-trips and repairs broken input', () => {
		const saved = paradisSerializeBrowserLiveViewState(state({ columns: 5, sharedOnly: true, sort: 'shared', cadence: 'smooth' }));
		assert.deepStrictEqual(paradisParseBrowserLiveViewState(saved), {
			columns: 5,
			sharedOnly: true,
			sort: 'shared',
			cadence: 'smooth',
		});

		// 壊れた値・未知の値・範囲外はすべて既定へ落ちる (起動不能にしない)。
		assert.deepStrictEqual(
			[
				paradisParseBrowserLiveViewState(undefined),
				paradisParseBrowserLiveViewState('not json'),
				paradisParseBrowserLiveViewState('null'),
				paradisParseBrowserLiveViewState(JSON.stringify({ sort: 'nope', cadence: 'turbo', columns: 'many' })),
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

	test('filters to shared pages and summarizes them', () => {
		const entries = [
			entry('a', { agents: ['Claude'] }),
			entry('b'),
			entry('c', { agents: ['Codex', 'Claude'] }),
		];

		assert.deepStrictEqual(
			[
				paradisFilterBrowserLiveEntries(entries, state({ sharedOnly: true })).map(item => item.viewId),
				paradisFilterBrowserLiveEntries(entries, state({ sharedOnly: false })).map(item => item.viewId),
				paradisSummarizeBrowserLiveEntries(entries),
			],
			[
				['a', 'c'],
				['a', 'b', 'c'],
				{ total: 3, shared: 2 },
			],
		);
	});

	test('sorts by tab order, title and shared-first', () => {
		const entries = [
			entry('b', { title: 'Zebra', order: 1 }),
			entry('a', { title: 'Apple', order: 2, agents: ['Claude'] }),
			entry('c', { title: 'Mango', order: 0 }),
		];

		assert.deepStrictEqual(
			[
				paradisSortBrowserLiveEntries(entries, state({ sort: 'editor' })).map(item => item.viewId),
				paradisSortBrowserLiveEntries(entries, state({ sort: 'title' })).map(item => item.viewId),
				paradisSortBrowserLiveEntries(entries, state({ sort: 'shared' })).map(item => item.viewId),
			],
			[
				['c', 'b', 'a'],
				['a', 'c', 'b'],
				// 共有中が先頭。残りはタブの並びのまま (同じ状態のものを入れ替えない)。
				['a', 'c', 'b'],
			],
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

	test('only captures what can change, and backs off after failures', () => {
		const shown = { visible: true, shared: false };
		const hidden = { visible: false, shared: false };
		// 画面に出ていないページで中身が動くのは、エージェントが操作しているものだけ。
		const hiddenShared = { visible: false, shared: true };

		assert.deepStrictEqual(
			[
				paradisBrowserLiveCaptureDelayMs('off', shown),
				paradisBrowserLiveCaptureDelayMs('normal', shown),
				paradisBrowserLiveCaptureDelayMs('smooth', shown),
				paradisBrowserLiveCaptureDelayMs('normal', hidden),
				paradisBrowserLiveCaptureDelayMs('smooth', hidden),
				paradisBrowserLiveCaptureDelayMs('normal', hiddenShared),
				paradisBrowserLiveCaptureDelayMs('smooth', hiddenShared),
				paradisBrowserLiveCaptureDelayMs('off', hiddenShared),
				paradisBrowserLiveRetryDelayMs(1000, 1),
				paradisBrowserLiveRetryDelayMs(1000, 3),
				paradisBrowserLiveRetryDelayMs(1000, 99),
				// 短い間隔でも、失敗時の待ちは1秒を下回らない。
				paradisBrowserLiveRetryDelayMs(350, 1),
			],
			[0, 1000, 350, 0, 0, 5000, 5000, 0, 1000, 4000, 8000, 1000],
		);
	});
});
