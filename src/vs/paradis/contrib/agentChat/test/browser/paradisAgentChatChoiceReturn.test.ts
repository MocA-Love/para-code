/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentChatChoiceReturn } from '../../browser/paradisAgentChatChoiceReturn.js';

suite('ParadisAgentChatChoiceReturn', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('returns to the chat once the choice menu closes, but not after the user switched back on their own', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const menus = new Set([1, 2]);
		const chat = new Set<number>();
		const returned: number[] = [];
		const watcher = store.add(new ParadisAgentChatChoiceReturn({
			showsChoiceMenu: id => menus.has(id),
			exists: () => true,
			isChatMode: id => chat.has(id),
			returnToChat: id => { returned.push(id); chat.add(id); },
		}, 1000));
		watcher.watch(1);
		watcher.watch(2);
		await new Promise(resolve => setTimeout(resolve, 1000));
		const whileOpen = [...returned];
		// 1 は選び終えた。2 は利用者が自分でチャットへ戻した後に画面が消えた
		menus.delete(1);
		chat.add(2);
		menus.delete(2);
		await new Promise(resolve => setTimeout(resolve, 1000));
		await new Promise(resolve => setTimeout(resolve, 1000));
		assert.deepStrictEqual({ whileOpen, returned }, { whileOpen: [], returned: [1] });
	}));
});
