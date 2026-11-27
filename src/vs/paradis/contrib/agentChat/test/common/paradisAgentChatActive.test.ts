/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentChatActiveTracker, paradisAgentChatActive } from '../../common/paradisAgentChatActive.js';

suite('paradisAgentChatActive', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a pane is active only in chat mode with a conversation, and the tracker reports panes that enter or leave', () => {
		const tracker = store.add(new ParadisAgentChatActiveTracker());
		const changes: number[] = [];
		store.add(tracker.onDidChange(instanceId => changes.push(instanceId)));
		const chatMode = new Set<number>();
		const tokens = new Map<number, string>();
		const update = () => tracker.update(chatMode, instanceId => paradisAgentChatActive(true, tokens.get(instanceId)));
		const log: (readonly [boolean, boolean, number[]])[] = [];
		const snapshot = () => {
			log.push([tracker.isActive(1), tracker.isActive(2), changes.splice(0)]);
		};

		// チャット表示でも会話が無ければ見えていない。会話が付いたら見える
		chatMode.add(1);
		update();
		snapshot();
		tokens.set(1, 'a');
		update();
		snapshot();
		// 変わらなければ知らせない
		update();
		snapshot();
		// 2 が加わり、1 はチャット表示をやめる
		chatMode.add(2);
		tokens.set(2, 'b');
		chatMode.delete(1);
		update();
		snapshot();
		// 会話が消えたら見えなくなる
		tokens.delete(2);
		update();
		snapshot();

		assert.deepStrictEqual({
			log,
			judge: [paradisAgentChatActive(false, 'a'), paradisAgentChatActive(true, undefined), paradisAgentChatActive(true, 'a')],
		}, {
			log: [
				[false, false, []],
				[true, false, [1]],
				[true, false, []],
				[false, true, [1, 2]],
				[false, false, [2]],
			],
			judge: [false, false, true],
		});
	});
});
