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
import { IParadisAgentChatSource, IParadisAgentChatView } from '../../common/paradisAgentChat.js';
import { IParadisAgentChatTerminal, ParadisAgentChatInput } from '../../browser/paradisAgentChatInput.js';
import { ParadisAgentChatSession } from '../../browser/paradisAgentChatSession.js';

class FakeTerminal implements IParadisAgentChatTerminal {
	readonly sent: string[] = [];
	screen = '';
	front: 'agent' | 'shell' | 'other' | 'unknown' = 'agent';
	paste = true;
	async sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void> {
		this.sent.push(`${bracketedPasteMode ? 'paste:' : ''}${JSON.stringify(text)}${shouldExecute ? '+exec' : ''}`);
	}
	readScreen(): string { return this.screen; }
	foreground() { return this.front; }
	bracketedPasteMode(): boolean { return this.paste; }
}

suite('ParadisAgentChatInput', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(view: Partial<IParadisAgentChatView>) {
		const disposables = store.add(new DisposableStore());
		let current: IParadisAgentChatView = { token: 't', agent: 'claude', epoch: 'e', rev: 0, reset: true, messages: [], live: null, interaction: null, busy: false, ...view };
		const claims: string[] = [];
		const source: IParadisAgentChatSource = {
			onDidChangeAgentChat: Event.None,
			watchAgentChat: async () => { },
			getAgentChat: async () => current,
			getAgentChatFullText: async () => undefined,
			getAgentChatImage: async () => undefined,
			getAgentChatCommands: async () => [],
			answerAgentChatApproval: async (_token, id, choice) => { claims.push(`codex:${id}:${choice}`); return true; },
			claimAgentChatInteraction: async (_token, kind, id) => { claims.push(`claim:${kind}:${id}`); return true; },
			releaseAgentChatInteraction: async (_token, kind, id, sent) => { claims.push(`release:${kind}:${id}:${sent}`); },
		};
		const terminal = new FakeTerminal();
		const session = disposables.add(new ParadisAgentChatSession('t', source, new NullLogService()));
		const input = new ParadisAgentChatInput({ source, terminal: () => terminal, session: () => session }, 0);
		return { input, terminal, claims, setView: (next: Partial<IParadisAgentChatView>) => { current = { ...current, ...next }; } };
	}

	test('sends a message only while the agent is in front and nothing waits for an answer, without control characters', async () => {
		const { input, terminal, setView } = setup({});
		const results: (string | undefined)[] = [];
		terminal.front = 'shell';
		results.push(await input.sendMessage(1, 't', 'hello'));
		terminal.front = 'agent';
		setView({ agentExited: true });
		results.push(await input.sendMessage(1, 't', 'hello'));
		setView({ agentExited: undefined });
		terminal.screen = 'Bash command\n npm test\nDo you want to proceed?\n❯ 1. Yes';
		results.push(await input.sendMessage(1, 't', 'hello'));
		terminal.screen = '';
		terminal.paste = false;
		results.push(await input.sendMessage(1, 't', 'two\nlines'));
		terminal.paste = true;
		results.push(await input.sendMessage(1, 't', 'a\u001b[201~b\u0007\ncd  '));
		assert.deepStrictEqual({ blocked: results.slice(0, 4).map(result => result !== undefined), last: results[4], sent: terminal.sent }, {
			blocked: [true, true, true, true],
			last: undefined,
			sent: ['paste:"a[201~b\\ncd"', '"\\r"'],
		});
	});

	test('answers questions only after their choices appear on screen, and approvals only while the prompt is shown', async () => {
		const question = { rev: 0, role: 'assistant' as const, kind: 'question' as const, text: 'Q?', toolUseId: 'q1', questionGroup: 'g', options: [{ label: 'Alpha' }, { label: 'Beta' }] };
		const { input, terminal, claims, setView } = setup({ interaction: { kind: 'question', id: 'g' }, pendingQuestions: [question] });
		terminal.screen = '❯ 1. Alpha\n  2. Beta';
		const answered = await input.answerQuestions(1, 't', 'g', [{ kind: 'option', index: 1 }]);
		setView({ pendingQuestions: [{ ...question, options: [] }] });
		const noMarker = await input.answerQuestions(1, 't', 'g', [{ kind: 'text', optionCount: 0, text: 'x' }]);

		setView({ interaction: { kind: 'approval', id: 'approval:e:0', choices: [{ id: 'yes', label: '許可', tone: 'approve' }] }, pendingQuestions: undefined });
		terminal.screen = 'Do you want to proceed?\n❯ 1. Yes';
		const approved = await input.answerApproval(1, 't', 'approval:e:0', 'yes');
		// 答え終えた承認は、中継に残っていても画面から消えていれば文を送れる。まだ画面にあれば送らない
		const whilePromptStillShown = await input.sendMessage(1, 't', 'next');
		terminal.screen = '';
		const afterPromptGone = await input.sendMessage(1, 't', 'next');
		setView({ interaction: { kind: 'approval', id: 'codex:thread:1', choices: [{ id: '0', label: 'Yes', tone: 'approve' }] } });
		const codex = await input.answerApproval(1, 't', 'codex:thread:1', '0');

		assert.deepStrictEqual({ answered, noMarker: noMarker !== undefined, approved, whilePromptStillShown: whilePromptStillShown !== undefined, afterPromptGone, codex, sent: terminal.sent, claims }, {
			answered: undefined,
			noMarker: true,
			approved: undefined,
			whilePromptStillShown: true,
			afterPromptGone: undefined,
			codex: undefined,
			sent: ['"2"', '"1"', '"\\r"', 'paste:"next"', '"\\r"'],
			claims: ['claim:question:g', 'release:question:g:true', 'claim:approval:approval:e:0', 'release:approval:approval:e:0:true', 'codex:codex:thread:1:0'],
		});
	});
});
