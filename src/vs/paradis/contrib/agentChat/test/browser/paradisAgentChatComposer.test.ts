/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event as BaseEvent } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisAgentChatCommand, IParadisAgentChatCursor, IParadisAgentChatSource, IParadisAgentChatView } from '../../common/paradisAgentChat.js';
import { IParadisAgentChatComposerHost, ParadisAgentChatComposer, ParadisAgentChatSendKey } from '../../browser/paradisAgentChatComposer.js';
import { ParadisAgentChatSession } from '../../browser/paradisAgentChatSession.js';

class TestComposerHost implements IParadisAgentChatComposerHost {
	sendKey: ParadisAgentChatSendKey = 'enter';
	readonly drafts = new Map<string, string>();
	history: string[] = [];
	getSendKey(): ParadisAgentChatSendKey { return this.sendKey; }
	getDraft(token: string): string { return this.drafts.get(token) ?? ''; }
	setDraft(token: string, text: string): void { this.drafts.set(token, text); }
	getHistory(): readonly string[] { return this.history; }
	async getCommands(): Promise<readonly IParadisAgentChatCommand[]> { return []; }
}

function keydown(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

suite('ParadisAgentChatComposer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let container: HTMLElement;

	setup(() => {
		container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
	});

	teardown(() => container.remove());

	test('sends on Enter, keeps Shift+Enter and the Enter that confirms Japanese input, and follows the send key setting', () => {
		const host = new TestComposerHost();
		const composer = store.add(new ParadisAgentChatComposer(container, host));
		const sent: string[] = [];
		store.add(composer.onDidSubmit(text => sent.push(text)));
		composer.setToken('pane-1');
		const textarea = container.querySelector('textarea')!;
		const type = (value: string) => {
			textarea.value = value;
			textarea.dispatchEvent(new Event('input'));
		};

		type('こんにちは');
		const composing = keydown(textarea, { key: 'Enter', keyCode: 229, isComposing: true });
		const shift = keydown(textarea, { key: 'Enter', keyCode: 13, shiftKey: true });
		keydown(textarea, { key: 'Enter', keyCode: 13 });
		host.sendKey = 'modEnter';
		type('two');
		const plainEnterInModMode = keydown(textarea, { key: 'Enter', keyCode: 13 });
		keydown(textarea, { key: 'Enter', keyCode: 13, metaKey: true, ctrlKey: true });
		type('   ');
		keydown(textarea, { key: 'Enter', keyCode: 13, metaKey: true, ctrlKey: true });

		assert.deepStrictEqual({
			sent,
			composingPrevented: composing.defaultPrevented,
			shiftPrevented: shift.defaultPrevented,
			plainEnterInModModePrevented: plainEnterInModMode.defaultPrevented,
			draft: host.drafts.get('pane-1'),
		}, {
			sent: ['こんにちは', 'two'],
			composingPrevented: false,
			shiftPrevented: false,
			plainEnterInModModePrevented: false,
			draft: '   ',
		});
	});

	test('keeps a draft per pane, recalls sent messages with the up arrow, and blocks sending while the agent waits for an answer', () => {
		const host = new TestComposerHost();
		host.history = ['first', 'second'];
		const composer = store.add(new ParadisAgentChatComposer(container, host));
		const sent: string[] = [];
		store.add(composer.onDidSubmit(text => sent.push(text)));
		const textarea = container.querySelector('textarea')!;
		composer.setToken('pane-1');
		textarea.value = 'draft one';
		textarea.dispatchEvent(new Event('input'));
		composer.setToken('pane-2');
		const pane2Initial = textarea.value;
		composer.setToken('pane-1');
		const pane1Restored = textarea.value;

		textarea.value = '';
		textarea.dispatchEvent(new Event('input'));
		keydown(textarea, { key: 'ArrowUp', keyCode: 38 });
		const recalledLatest = textarea.value;
		keydown(textarea, { key: 'ArrowUp', keyCode: 38 });
		const recalledOlder = textarea.value;
		keydown(textarea, { key: 'ArrowDown', keyCode: 40 });
		keydown(textarea, { key: 'ArrowDown', keyCode: 40 });
		const backToDraft = textarea.value;

		composer.setBlockedReason('質問に答えてから送ってください');
		textarea.value = 'blocked';
		textarea.dispatchEvent(new Event('input'));
		keydown(textarea, { key: 'Enter', keyCode: 13 });

		assert.deepStrictEqual({ pane2Initial, pane1Restored, recalledLatest, recalledOlder, backToDraft, sent }, {
			pane2Initial: '',
			pane1Restored: 'draft one',
			recalledLatest: 'second',
			recalledOlder: 'first',
			backToDraft: '',
			sent: [],
		});
	});
});

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
			onDidChangeAgentChat: BaseEvent.None,
			watchAgentChat: async () => { },
			getAgentChat: async (_token, cursor) => {
				requests.push(cursor);
				return responses.shift();
			},
			getAgentChatFullText: async () => undefined,
			getAgentChatImage: async () => undefined,
			getAgentChatCommands: async () => [],
			answerAgentChatApproval: async () => false,
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
});
