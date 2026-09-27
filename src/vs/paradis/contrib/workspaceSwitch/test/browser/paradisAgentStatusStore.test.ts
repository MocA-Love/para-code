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

	test('remembers a review acknowledged by the viewer until the pane reports again', () => {
		// 定期実行の見張りが「既読で消えた」と「取得の失敗で消えた」を見分けるのに使う
		const { store, fired } = createStore();
		store.setInstanceStates(new Map([[7, 'working']]), new Set([7]));
		const afterWorking = fired();
		store.setInstanceStates(new Map(), new Set([7]), new Set([7]));
		const acknowledged = store.wasReviewAcknowledged(7);
		const afterAck = fired();
		store.setInstanceStates(new Map(), new Set());
		const afterPollFailure = store.wasReviewAcknowledged(7);
		store.setInstanceStates(new Map([[7, 'working']]), new Set([7]));

		assert.deepStrictEqual({ afterWorking, acknowledged, afterAck, afterPollFailure, afterNextTurn: store.wasReviewAcknowledged(7) },
			{ afterWorking: 1, acknowledged: true, afterAck: 2, afterPollFailure: true, afterNextTurn: false });
	});

	test('says which panes stopped for the user in the same update that removes their status, and forgets it once they report again', () => {
		// タブの印が、許可の拒否による状態の消滅を完了と数えないのに使う
		const { store, fired } = createStore();
		store.setInstanceStates(new Map([[7, 'permission'], [8, 'working']]), new Set([7, 8]));
		let seenOnRemoval: boolean | undefined;
		const listener = store.onDidChangeAgentStatuses(() => { seenOnRemoval ??= store.wasStoppedForUser(7); });
		// 8 は状態が付いているので載らない
		store.setInstanceStates(new Map([[8, 'working']]), new Set([7, 8]), undefined, new Set([7, 8]));
		listener.dispose();
		const stopped = { seven: store.wasStoppedForUser(7), eight: store.wasStoppedForUser(8) };
		const beforeNextTurn = fired();
		store.setInstanceStates(new Map([[7, 'working'], [8, 'working']]), new Set([7, 8]));

		assert.deepStrictEqual({ seenOnRemoval, stopped, beforeNextTurn, afterNextTurn: store.wasStoppedForUser(7) },
			{ seenOnRemoval: true, stopped: { seven: true, eight: false }, beforeNextTurn: 2, afterNextTurn: false });
	});

});
