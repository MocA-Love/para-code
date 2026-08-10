/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisAgentStatusStore } from '../../browser/paradisAgentStatusStore.js';

suite('ParadisAgentStatusStore', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createStore(): { store: ParadisAgentStatusStore; fired: () => number } {
		const store = disposables.add(new ParadisAgentStatusStore());
		let count = 0;
		disposables.add(store.onDidChangeAgentStatuses(() => count++));
		return { store, fired: () => count };
	}

	function breakdowns(entries: [string, ParadisAgentStatus[]][]): Map<string, ParadisAgentStatus[]> {
		return new Map(entries);
	}

	test('keeps the breakdown and derives the representative status from it', () => {
		const { store } = createStore();
		store.setScopeBreakdowns(breakdowns([['space-a', ['working', 'review', 'working']]]));

		assert.deepStrictEqual({
			breakdown: [...store.getScopeBreakdown('space-a')],
			status: store.getScopeStatus('space-a'),
			missingBreakdown: [...store.getScopeBreakdown('space-b')],
			missingStatus: store.getScopeStatus('space-b'),
		}, {
			// 内訳は優先度の降順で保持される (打ち切りで消えるのが常に低優先度になるように)
			breakdown: ['working', 'working', 'review'],
			status: 'working',
			missingBreakdown: [],
			missingStatus: undefined,
		});
	});

	test('fires only when the breakdown actually changes', () => {
		const { store, fired } = createStore();
		const counts: number[] = [];

		store.setScopeBreakdowns(breakdowns([['space-a', ['working']]]));
		counts.push(fired());
		// 同じ内容 (順序違いを含む) では発火しない: 2秒ポーリングのたびに再描画させないため
		store.setScopeBreakdowns(breakdowns([['space-a', ['working']]]));
		store.setScopeBreakdowns(breakdowns([['space-a', ['working']]]));
		counts.push(fired());
		store.setScopeBreakdowns(breakdowns([['space-a', ['review', 'working']]]));
		counts.push(fired());
		store.setScopeBreakdowns(breakdowns([['space-a', ['working', 'review']]]));
		counts.push(fired());
		// 件数が同じでもキーが入れ替わったら別の状態
		store.setScopeBreakdowns(breakdowns([['space-b', ['working', 'review']]]));
		counts.push(fired());
		// 空にする (ポーリング失敗が続いたときのクリア) と発火し、2度目は発火しない
		store.setScopeBreakdowns(breakdowns([]));
		store.setScopeBreakdowns(breakdowns([]));
		counts.push(fired());

		assert.deepStrictEqual(counts, [1, 1, 2, 2, 3, 4]);
	});

	test('clearing the breakdown clears the representative status too', () => {
		const { store } = createStore();
		store.setScopeBreakdowns(breakdowns([['space-a', ['permission']]]));
		store.setScopeBreakdowns(breakdowns([]));

		assert.deepStrictEqual({
			breakdown: [...store.getScopeBreakdown('space-a')],
			status: store.getScopeStatus('space-a'),
		}, { breakdown: [], status: undefined });
	});

	test('does not alias the caller\'s arrays', () => {
		const { store } = createStore();
		const mutable: ParadisAgentStatus[] = ['working'];
		store.setScopeBreakdowns(breakdowns([['space-a', mutable]]));
		mutable.push('permission');

		assert.deepStrictEqual([...store.getScopeBreakdown('space-a')], ['working']);
	});

	test('tracks per-instance states independently of scope breakdowns', () => {
		const { store } = createStore();
		store.setInstanceStates(new Map([[7, 'review']]), new Set([7, 9]));

		assert.deepStrictEqual({
			seven: store.getInstanceStatus(7),
			nine: store.getInstanceStatus(9),
			sevenIsAgent: store.isAgentInstance(7),
			nineIsAgent: store.isAgentInstance(9),
			otherIsAgent: store.isAgentInstance(11),
		}, { seven: 'review', nine: undefined, sevenIsAgent: true, nineIsAgent: true, otherIsAgent: false });
	});

	test('remembers panes whose session was found without a hook, and says when that set changed', () => {
		// hook が届かない場所（WSL のディストロの中）で動いているエージェントを一覧へ載せる根拠。
		// 変わったときだけ通知しないと、一覧が数十秒おきに作り直されてしまう。
		const { store, fired } = createStore();
		store.setDiscoveredAgentPaneTokens(new Set(['pane-a', 'pane-b']));
		const afterFirst = fired();
		store.setDiscoveredAgentPaneTokens(new Set(['pane-b', 'pane-a']));
		const afterSame = fired();
		store.setDiscoveredAgentPaneTokens(new Set(['pane-b']));

		assert.deepStrictEqual({
			a: store.hasDiscoveredAgentSession('pane-a'),
			b: store.hasDiscoveredAgentSession('pane-b'),
			unknown: store.hasDiscoveredAgentSession('pane-c'),
			afterFirst, afterSame, afterRemoval: fired(),
		}, { a: false, b: true, unknown: false, afterFirst: 1, afterSame: 1, afterRemoval: 2 });
	});

});
