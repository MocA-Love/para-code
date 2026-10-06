/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisNotifyDismissStore } from '../../node/paradisNotifyDismissStore.js';

suite('ParadisNotifyDismissStore (Q242 A)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createStore(file: { content: string | undefined }) {
		return disposables.add(new ParadisNotifyDismissStore({
			read: async () => file.content,
			write: async content => { file.content = content; },
			warn: () => { },
			now: () => 1_000,
			subscribeHooks: false,
		}));
	}

	test('persists settlements across a restart and settles prompts when a hook shows the answer', async () => {
		const file: { content: string | undefined } = { content: undefined };
		const first = createStore(file);
		await first.ready;
		first.ledger.record('q1', 'tok-a', 'agent-question', 500, 'tool-1');
		first.ledger.record('d1', 'tok-a', 'agent-done', 510);
		first.ledger.markDismissed('d1', 600, true);
		first.changed();
		await first.flush();

		const second = createStore(file);
		await second.ready;
		const answered: (readonly string[])[] = [];
		disposables.add(second.onDidAnswer(ids => answered.push(ids)));
		// PC のターミナルで答えた（hook の PostToolUse がその ID で来た）。関係しない hook は何もしない
		second.handleHookEvent({ token: 'tok-a', event: 'PreToolUse', toolUseId: 'tool-1', at: 700 });
		second.handleHookEvent({ token: 'tok-a', event: 'PostToolUse', toolUseId: 'tool-1', at: 700 });
		await second.flush();
		const third = createStore(file);
		await third.ready;
		assert.deepStrictEqual({
			answered,
			raw: file.content?.includes('tok-a'),
			log: { ...third.ledger.since(undefined, 0), ledger: third.ledger.ledgerId === second.ledger.ledgerId },
		}, {
			answered: [['q1']],
			raw: false,
			log: { ledger: true, seq: 2, ids: ['d1', 'q1'] },
		});
	});
});
