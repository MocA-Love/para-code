/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentChatView } from '../../common/paradisAgentChat.js';
import { paradisApplyAgentChatView } from '../../common/paradisAgentChatState.js';

function view(fields: Partial<IParadisAgentChatView>): IParadisAgentChatView {
	return { token: 't', agent: 'claude', epoch: 'e1', rev: 0, reset: true, messages: [], live: null, interaction: null, busy: false, ...fields };
}

suite('paradisAgentChatState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('replaces on a snapshot, appends deltas, and asks for a snapshot when the delta does not fit', () => {
		const first = paradisApplyAgentChatView(undefined, view({ rev: 2, messages: [{ rev: 0, role: 'user', kind: 'text', text: 'a' }, { rev: 1, role: 'assistant', kind: 'text', text: 'b' }] }));
		const appended = paradisApplyAgentChatView(first, view({ reset: false, rev: 3, busy: true, messages: [{ rev: 1, role: 'assistant', kind: 'text', text: 'b' }, { rev: 2, role: 'assistant', kind: 'text', text: 'c' }] }));
		const otherEpoch = paradisApplyAgentChatView(appended, view({ reset: false, epoch: 'e2', rev: 1 }));
		const deltaWithoutBase = paradisApplyAgentChatView(undefined, view({ reset: false, rev: 1 }));
		assert.deepStrictEqual({
			first: first?.messages.map(message => message.text),
			appended: [appended?.messages.map(message => message.text), appended?.rev, appended?.busy],
			otherEpoch,
			deltaWithoutBase,
		}, {
			first: ['a', 'b'],
			appended: [['a', 'b', 'c'], 3, true],
			otherEpoch: undefined,
			deltaWithoutBase: undefined,
		});
	});
});
