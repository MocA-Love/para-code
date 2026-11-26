/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentChatSlashQuery, paradisAppendAgentChatDraft, paradisInsertAgentChatDraft, paradisSendToAgentPane, paradisFilterAgentChatCommands, paradisPushAgentChatHistory } from '../../common/paradisAgentChatComposerLogic.js';

suite('paradisAgentChatComposerLogic', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('slash completion only while typing the command name, prefix matches first, history without repeats', () => {
		const commands = [
			{ name: 'review', insertText: '/review', description: '', kind: 'command' as const, source: 'built-in' as const },
			{ name: 'model', insertText: '/model', description: '', kind: 'command' as const, source: 'built-in' as const },
			{ name: 'pr-review', insertText: '/pr-review', description: '', kind: 'command' as const, source: 'user' as const },
		];
		assert.deepStrictEqual({
			queries: ['/', '/rev', '/model opus', 'hello /x', '/re'].map((value, index) => paradisAgentChatSlashQuery(value, index === 4 ? 2 : value.length)),
			filtered: paradisFilterAgentChatCommands(commands, 'rev').map(command => command.name),
			all: paradisFilterAgentChatCommands(commands, '').map(command => command.name),
			history: paradisPushAgentChatHistory(paradisPushAgentChatHistory(['a', 'b'], 'b', 3), 'c', 2),
			blank: paradisPushAgentChatHistory(['a'], '   ', 3),
		}, {
			queries: ['', 'rev', undefined, undefined, 'r'],
			filtered: ['review', 'pr-review'],
			all: ['review', 'model', 'pr-review'],
			history: ['b', 'c'],
			blank: ['a'],
		});
	});

	test('puts a draft into an empty input and appends it after a blank line to what the user is writing', () => {
		assert.deepStrictEqual([
			paradisAppendAgentChatDraft('', 'リリースをまとめて'),
			paradisAppendAgentChatDraft('  \n', 'リリースをまとめて'),
			paradisAppendAgentChatDraft('書きかけ\n', 'リリースをまとめて'),
		], [
			{ value: 'リリースをまとめて', result: 'inserted' },
			{ value: 'リリースをまとめて', result: 'inserted' },
			{ value: '書きかけ\n\nリリースをまとめて', result: 'appended' },
		]);
	});

	test('inserts a draft into the visible input, else into the pane draft, and does nothing for a pane not in the chat view or a blank text', () => {
		const run = (chatShown: boolean, visible: boolean, text: string, draft = '') => {
			const calls: string[] = [];
			let stored = draft;
			const result = paradisInsertAgentChatDraft(text, {
				chatShown,
				insertIntoVisibleInput: value => { calls.push(`input:${value}`); return visible ? 'inserted' : undefined; },
				getDraft: () => stored,
				setDraft: value => { stored = value; calls.push(`draft:${value}`); },
			});
			return { result, calls };
		};
		assert.deepStrictEqual({
			visible: run(true, true, '始めて'),
			background: run(true, false, '始めて', '書きかけ'),
			notChat: run(false, true, '始めて'),
			blank: run(true, true, '  \n '),
		}, {
			visible: { result: 'inserted', calls: ['input:始めて'] },
			background: { result: 'appended', calls: ['input:始めて', 'draft:書きかけ\n\n始めて'] },
			notChat: { result: false, calls: [] },
			blank: { result: false, calls: [] },
		});
	});

	test('sends to the pane through the chat input rules, and refuses a pane without an agent or a blank text before sending', async () => {
		const sent: string[] = [];
		const send = async (token: string, text: string) => { sent.push(`${token}:${text}`); return text === '許可待ち' ? 'エージェントが回答を待っています' : undefined; };
		assert.deepStrictEqual({
			sent: await paradisSendToAgentPane('pane', '続けて', send),
			refusedByInput: await paradisSendToAgentPane('pane', '許可待ち', send),
			noAgent: await paradisSendToAgentPane(undefined, '続けて', send),
			blank: await paradisSendToAgentPane('pane', ' \n ', send),
			calls: sent,
		}, {
			sent: undefined,
			refusedByInput: 'エージェントが回答を待っています',
			noAgent: 'このターミナルにはエージェントの会話がありません',
			blank: '送る文がありません',
			calls: ['pane:続けて', 'pane:許可待ち'],
		});
	});
});
