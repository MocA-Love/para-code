/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSleepingChatGuide, paradisSleepingChatView } from '../../browser/paradisBotSleepingChatEditor.js';

suite('Paradis bot sleeping chat editor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('読めた会話は読むだけの写し（動いていない・許可も質問も無い）にし、読めなければ写しを出さず「話しかけると起きる」案内で入力欄は止めない', () => {
		const message = { rev: 1, role: 'assistant' as const, kind: 'text' as const, text: '降りません。' };
		assert.deepStrictEqual({
			read: paradisSleepingChatView('sleeping:b', { agent: 'claude', messages: [message], truncated: true }),
			readGuide: paradisSleepingChatGuide({ agent: 'claude', messages: [message], truncated: false }),
			unreadable: paradisSleepingChatView('sleeping:b', { agent: 'codex', messages: [], truncated: false, unreadable: true }),
			unreadableGuide: paradisSleepingChatGuide({ agent: 'codex', messages: [], truncated: false, unreadable: true }),
		}, {
			read: { token: 'sleeping:b', agent: 'claude', epoch: 'sleeping', rev: 1, reset: true, messages: [message], truncated: true, live: null, interaction: null, busy: false },
			readGuide: undefined,
			unreadable: undefined,
			unreadableGuide: { notice: '前の会話を読めません。話しかけると続きから起きます', sendable: true },
		});
	});
});
