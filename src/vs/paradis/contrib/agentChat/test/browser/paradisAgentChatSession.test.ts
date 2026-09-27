/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisAgentChatCursor, IParadisAgentChatSource, IParadisAgentChatView } from '../../common/paradisAgentChat.js';
import { ParadisAgentChatSession } from '../../browser/paradisAgentChatSession.js';

suite('ParadisAgentChatSession', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('applies deltas from the cursor and falls back to a full read when the delta does not fit', async () => {
		const requests: (IParadisAgentChatCursor | undefined)[] = [];
		const responses: (IParadisAgentChatView | undefined)[] = [
			{ token: 't', agent: 'codex', epoch: 'e1', rev: 1, reset: true, messages: [{ rev: 0, role: 'user', kind: 'text', text: 'a' }], live: null, interaction: null, busy: false },
			{ token: 't', agent: 'codex', epoch: 'e1', rev: 2, reset: false, messages: [{ rev: 1, role: 'assistant', kind: 'text', text: 'b' }], live: null, interaction: null, busy: true },
			// 読み取りが始め直された（epoch が変わった）のに差分として返ってきた → 全量を取り直す
			{ token: 't', agent: 'codex', epoch: 'e2', rev: 1, reset: false, messages: [], live: null, interaction: null, busy: false },
			{ token: 't', agent: 'codex', epoch: 'e2', rev: 1, reset: true, messages: [{ rev: 0, role: 'user', kind: 'text', text: 'c' }], live: null, interaction: null, busy: false },
		];
		const source: IParadisAgentChatSource = {
			onDidChangeAgentChat: Event.None,
			watchAgentChat: async () => { },
			getAgentChat: async (_token, cursor) => {
				requests.push(cursor);
				return responses.shift();
			},
			getAgentChatFullText: async () => undefined,
			getAgentChatImage: async () => undefined,
			getAgentChatCommands: async () => [],
			answerAgentChatApproval: async () => false,
			claimAgentChatInteraction: async () => true,
			releaseAgentChatInteraction: async () => { },
		};
		const disposables = store.add(new DisposableStore());
		const session = disposables.add(new ParadisAgentChatSession('t', source, new NullLogService()));
		let changes = 0;
		disposables.add(session.onDidChange(() => changes++));
		await session.refresh();
		await session.refresh();
		const afterDelta = session.state?.messages.map(message => message.text);
		await session.refresh();
		assert.deepStrictEqual({
			requests,
			afterDelta,
			final: session.state?.messages.map(message => message.text),
			epoch: session.state?.epoch,
			changes,
		}, {
			requests: [undefined, { epoch: 'e1', rev: 1 }, { epoch: 'e1', rev: 2 }, undefined],
			afterDelta: ['a', 'b'],
			final: ['c'],
			epoch: 'e2',
			changes: 3,
		});
	});
	test('a refresh requested while another is in flight waits for a read that starts after the request', async () => {
		let reads = 0;
		let release: (() => void) | undefined;
		const source: IParadisAgentChatSource = {
			onDidChangeAgentChat: Event.None,
			watchAgentChat: async () => { },
			getAgentChat: async () => {
				const read = ++reads;
				if (read === 1) {
					await new Promise<void>(resolve => release = resolve);
				}
				return { token: 't', agent: 'claude', epoch: 'e', rev: read, reset: true, messages: [], live: null, interaction: read === 1 ? { kind: 'question', id: 'old' } : null, busy: false };
			},
			getAgentChatFullText: async () => undefined,
			getAgentChatImage: async () => undefined,
			getAgentChatCommands: async () => [],
			answerAgentChatApproval: async () => false,
			claimAgentChatInteraction: async () => true,
			releaseAgentChatInteraction: async () => { },
		};
		const disposables = store.add(new DisposableStore());
		const session = disposables.add(new ParadisAgentChatSession('t', source, new NullLogService()));
		const first = session.refresh();
		const second = session.refresh();
		const third = session.refresh();
		release?.();
		await first;
		await second;
		await third;
		assert.deepStrictEqual({ reads, interaction: session.state?.interaction }, { reads: 2, interaction: null });
	});
});
