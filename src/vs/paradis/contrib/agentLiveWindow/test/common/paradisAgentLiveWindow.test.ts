/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisAgentLiveEntry,
	IParadisAgentLiveViewState,
	ParadisAgentLiveStatus,
	paradisApplyAgentLiveManualDrop,
	paradisDefaultAgentLiveViewState,
	paradisFilterAgentLiveEntries,
	paradisFormatAgentLiveDuration,
	paradisGroupAgentLiveEntries,
	paradisHasAgentLiveFilter,
	paradisParseAgentLiveViewState,
	paradisSerializeAgentLiveViewState,
	paradisSortAgentLiveEntries,
} from '../../common/paradisAgentLiveWindow.js';

const NOW = 1_000_000;

function entry(token: string, status: ParadisAgentLiveStatus, options: Partial<IParadisAgentLiveEntry> = {}): IParadisAgentLiveEntry {
	return {
		token,
		instanceId: Number(token.replace(/\D/g, '')) || 1,
		stateKey: `space-${token}`,
		spaceName: `space-${token}`,
		spaceColor: undefined,
		detail: 'main',
		title: token,
		status,
		since: NOW - 1000,
		lastOutputAt: NOW - 1000,
		...options,
	};
}

function state(overrides: Partial<IParadisAgentLiveViewState> = {}): IParadisAgentLiveViewState {
	return { ...paradisDefaultAgentLiveViewState(), ...overrides };
}

suite('Paradis - agent live window', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('filters by status, space, attention and hidden', () => {
		const entries = [
			entry('a', 'permission'),
			entry('b', 'working'),
			entry('c', 'idle'),
		];

		assert.deepStrictEqual(
			[
				paradisFilterAgentLiveEntries(entries, state()).map(item => item.token),
				paradisFilterAgentLiveEntries(entries, state({ statuses: ['working', 'idle'] })).map(item => item.token),
				paradisFilterAgentLiveEntries(entries, state({ attentionOnly: true })).map(item => item.token),
				paradisFilterAgentLiveEntries(entries, state({ spaces: ['space-b'] })).map(item => item.token),
				paradisFilterAgentLiveEntries(entries, state({ hidden: ['a'] })).map(item => item.token),
			],
			[
				['a', 'b', 'c'],
				['b', 'c'],
				['a'],
				['b'],
				['b', 'c'],
			],
		);
	});

	test('sorts by attention, elapsed and manual order, keeping pins on top', () => {
		const entries = [
			entry('working-new', 'working', { since: NOW - 1000 }),
			entry('permission-old', 'permission', { since: NOW - 60_000 }),
			entry('working-old', 'working', { since: NOW - 300_000 }),
			entry('question-new', 'question', { since: NOW - 2000 }),
		];

		assert.deepStrictEqual(
			[
				paradisSortAgentLiveEntries(entries, state({ sort: 'attention' }), NOW).map(item => item.token),
				paradisSortAgentLiveEntries(entries, state({ sort: 'elapsed' }), NOW).map(item => item.token),
				paradisSortAgentLiveEntries(entries, state({ sort: 'manual', manualOrder: ['question-new', 'working-old'] }), NOW).map(item => item.token),
				paradisSortAgentLiveEntries(entries, state({ sort: 'attention', pinned: ['working-new'] }), NOW).map(item => item.token),
			],
			[
				['permission-old', 'question-new', 'working-old', 'working-new'],
				['working-old', 'permission-old', 'question-new', 'working-new'],
				// 手動順に無いものは末尾へ回り、トークン順で安定する。
				['question-new', 'working-old', 'permission-old', 'working-new'],
				['working-new', 'permission-old', 'question-new', 'working-old'],
			],
		);
	});

	test('groups by space and status while preserving the sorted order', () => {
		const entries = [
			entry('a', 'permission', { stateKey: 'repo1', spaceName: 'repo1' }),
			entry('b', 'working', { stateKey: 'repo2', spaceName: 'repo2' }),
			entry('c', 'working', { stateKey: 'repo1', spaceName: 'repo1' }),
		];
		const label = (status: ParadisAgentLiveStatus): string => `status:${status}`;

		assert.deepStrictEqual(
			[
				paradisGroupAgentLiveEntries(entries, state({ group: 'space' }), label).map(group => [group.key, group.entries.map(item => item.token)]),
				paradisGroupAgentLiveEntries(entries, state({ group: 'status' }), label).map(group => [group.label, group.entries.map(item => item.token)]),
				paradisGroupAgentLiveEntries(entries, state({ group: 'none' }), label).map(group => group.entries.map(item => item.token)),
			],
			[
				[['repo1', ['a', 'c']], ['repo2', ['b']]],
				[['status:permission', ['a']], ['status:working', ['b', 'c']]],
				[['a', 'b', 'c']],
			],
		);
	});

	test('manual drop seeds the order from what is currently visible', () => {
		const visible = ['a', 'b', 'c', 'd'];

		assert.deepStrictEqual(
			[
				// 手動順が空 (自動ソート中) からのドロップ: 見えている並びを土台にする。
				paradisApplyAgentLiveManualDrop([], visible, 'd', 'b'),
				// 既存の手動順があるときは、そこだけを動かす。
				paradisApplyAgentLiveManualDrop(['a', 'b', 'c', 'd'], visible, 'a', 'c'),
				// 一覧に居ないトークンへ落ちた場合は末尾へ回す。
				paradisApplyAgentLiveManualDrop(['a', 'b'], ['a', 'b'], 'a', 'zzz'),
			],
			[
				['a', 'd', 'b', 'c'],
				['b', 'a', 'c', 'd'],
				['b', 'a'],
			],
		);
	});

	test('parses stored view state and falls back on damaged values', () => {
		const stored = JSON.stringify({
			statuses: ['working', 'nonsense'],
			spaces: [],
			attentionOnly: true,
			sort: 'nonsense',
			sortDesc: false,
			group: 'status',
			columns: 99,
			dense: true,
			pinTop: false,
			manualOrder: ['a', 3],
			pinned: ['b'],
			hidden: ['c'],
		});

		assert.deepStrictEqual(
			[
				paradisParseAgentLiveViewState(stored),
				paradisParseAgentLiveViewState('{ broken'),
				paradisParseAgentLiveViewState(undefined),
			],
			[
				{
					statuses: ['working'],
					spaces: undefined,
					attentionOnly: true,
					sort: 'attention',
					sortDesc: false,
					group: 'status',
					columns: 4,
					dense: true,
					pinTop: false,
					manualOrder: ['a'],
					pinned: ['b'],
					hidden: ['c'],
				},
				paradisDefaultAgentLiveViewState(),
				paradisDefaultAgentLiveViewState(),
			],
		);
	});

	test('sorts by status, last output and space name, and honours the direction toggle', () => {
		const entries = [
			entry('b-review', 'review', { spaceName: 'beta', since: NOW - 5000, lastOutputAt: NOW - 5000 }),
			entry('a-working', 'working', { spaceName: 'alpha', since: NOW - 9000, lastOutputAt: NOW - 1000 }),
			entry('c-permission', 'permission', { spaceName: 'gamma', since: NOW - 1000, lastOutputAt: NOW - 9000 }),
		];

		assert.deepStrictEqual(
			[
				paradisSortAgentLiveEntries(entries, state({ sort: 'status' }), NOW).map(item => item.token),
				paradisSortAgentLiveEntries(entries, state({ sort: 'status', sortDesc: false }), NOW).map(item => item.token),
				paradisSortAgentLiveEntries(entries, state({ sort: 'updated' }), NOW).map(item => item.token),
				paradisSortAgentLiveEntries(entries, state({ sort: 'space' }), NOW).map(item => item.token),
				paradisSortAgentLiveEntries(entries, state({ sort: 'space', sortDesc: false }), NOW).map(item => item.token),
				// pinTop を切ると、ピンは並び順に影響しない。
				paradisSortAgentLiveEntries(entries, state({ sort: 'status', pinTop: false, pinned: ['b-review'] }), NOW).map(item => item.token),
				paradisSortAgentLiveEntries([], state(), NOW),
			],
			[
				['c-permission', 'a-working', 'b-review'],
				['b-review', 'a-working', 'c-permission'],
				['a-working', 'b-review', 'c-permission'],
				['a-working', 'b-review', 'c-permission'],
				['c-permission', 'b-review', 'a-working'],
				['c-permission', 'a-working', 'b-review'],
				[],
			],
		);
	});

	test('reports whether any filter is active and round-trips the stored state', () => {
		const filtered = state({ hidden: ['a'] });

		assert.deepStrictEqual(
			[
				paradisHasAgentLiveFilter(state()),
				paradisHasAgentLiveFilter(state({ attentionOnly: true })),
				paradisHasAgentLiveFilter(state({ statuses: ['working'] })),
				paradisHasAgentLiveFilter(state({ spaces: ['repo1'] })),
				paradisHasAgentLiveFilter(filtered),
				// 並び替えや列数は「絞り込み」ではない。
				paradisHasAgentLiveFilter(state({ sort: 'manual', columns: 2, pinned: ['a'] })),
				paradisParseAgentLiveViewState(paradisSerializeAgentLiveViewState(filtered)),
			],
			[false, true, true, true, true, false, filtered],
		);
	});

	test('formats durations', () => {
		assert.deepStrictEqual(
			[0, 42_000, 187_000, 8_100_000].map(paradisFormatAgentLiveDuration),
			['0秒', '42秒', '3分07秒', '2時間15分'],
		);
	});
});
