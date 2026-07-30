/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisAggregateAgentStatus, paradisSortAgentStatuses } from '../../common/paradisWorkspaceSwitch.js';

suite('ParadisAgentStatusAggregation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks the status that needs attention the most', () => {
		assert.deepStrictEqual([
			paradisAggregateAgentStatus([]),
			paradisAggregateAgentStatus(['review']),
			// 動作中が残っていても代表値は「動作中」。完了が消えて見えなくなるのを補うのが内訳の役目
			paradisAggregateAgentStatus(['review', 'working']),
			paradisAggregateAgentStatus(['working', 'review', 'permission']),
			paradisAggregateAgentStatus(['review', 'question']),
			paradisAggregateAgentStatus(['question', 'permission']),
		], [undefined, 'review', 'working', 'permission', 'question', 'permission']);
	});

	test('ignores unknown statuses instead of letting them latch as the representative', () => {
		// IPC 越しに届く文字列なので、バージョン差で未知の値が混ざり得る
		const withUnknown: ParadisAgentStatus[] = ['future-state' as ParadisAgentStatus, 'permission'];
		assert.deepStrictEqual([
			paradisAggregateAgentStatus(withUnknown),
			paradisAggregateAgentStatus(['future-state' as ParadisAgentStatus]),
		], ['permission', undefined]);
	});

	test('sorts by priority so that truncation only ever drops the least urgent', () => {
		const sorted = paradisSortAgentStatuses(['review', 'working', 'review', 'permission', 'question', 'working']);
		assert.deepStrictEqual(sorted, ['permission', 'question', 'working', 'working', 'review', 'review']);
	});

	test('does not mutate the given array', () => {
		const original: ParadisAgentStatus[] = ['review', 'permission'];
		paradisSortAgentStatuses(original);
		assert.deepStrictEqual(original, ['review', 'permission']);
	});
});
