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
import { IParadisAgentChatTerminal, ParadisAgentChatInput, paradisIsShellProcessName } from '../../browser/paradisAgentChatInput.js';
import { paradisScreenShowsPermissionPrompt } from '../../browser/paradisAgentTuiInput.js';
import { ParadisAgentChatSession } from '../../browser/paradisAgentChatSession.js';

class FakeTerminal implements IParadisAgentChatTerminal {
	readonly sent: string[] = [];
	screen = '';
	front: 'agent' | 'shell' | 'unknown' = 'agent';
	paste = true;
	/** 打鍵で画面が変わる様子（`1` で許可の確認が閉じる等）。 */
	onKey: ((text: string) => void) | undefined;
	async sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void> {
		this.sent.push(`${bracketedPasteMode ? 'paste:' : ''}${JSON.stringify(text)}${shouldExecute ? '+exec' : ''}`);
		this.onKey?.(text);
	}
	readScreen(): string { return this.screen; }
	foreground() { return this.front; }
	bracketedPasteMode(): boolean { return this.paste; }
}

const PERMISSION_SCREEN = [
	'● Bash(npm test -- auth)',
	'╭────────────────────────────────╮',
	'│ Bash command                    │',
	'│   npm test -- auth              │',
	'│ Do you want to proceed?         │',
	'│ ❯ 1. Yes                        │',
	'│   2. No, and tell Claude        │',
	'╰────────────────────────────────╯',
].join('\n');

suite('ParadisAgentChatInput', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(view: Partial<IParadisAgentChatView>, claimResult = true) {
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
			claimAgentChatInteraction: async (_token, kind, id) => { claims.push(`claim:${kind}:${id}`); return claimResult; },
			releaseAgentChatInteraction: async (_token, kind, id, sent) => { claims.push(`release:${kind}:${id}:${sent}`); },
		};
		const terminal = new FakeTerminal();
		const session = disposables.add(new ParadisAgentChatSession('t', source, new NullLogService()));
		const input = new ParadisAgentChatInput({ source, terminal: () => terminal, session: () => session }, 0, 300);
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
		terminal.screen = PERMISSION_SCREEN;
		results.push(await input.sendMessage(1, 't', 'hello'));
		terminal.screen = '';
		terminal.paste = false;
		results.push(await input.sendMessage(1, 't', 'two\nlines'));
		terminal.paste = true;
		// エージェントの返答の本文に同じ文言があるだけで、下端に入力欄が出ているなら送れる
		terminal.screen = ['⏺ 3つ案があります。Do you want to proceed?', '', '> ', '? for shortcuts'].join('\n');
		results.push(await input.sendMessage(1, 't', 'a\u001b[201~b\u0007\ncd  '));
		assert.deepStrictEqual({ blocked: results.slice(0, 4).map(result => result !== undefined), last: results[4], sent: terminal.sent }, {
			blocked: [true, true, true, true],
			last: undefined,
			sent: ['paste:"a[201~b\\ncd"', '"\\r"'],
		});
	});

	test('answers questions only while their own choices are on screen and no permission prompt is shown', async () => {
		const question = { rev: 0, role: 'assistant' as const, kind: 'question' as const, text: 'どちらの案で進めますか?', toolUseId: 'q1', questionGroup: 'g', options: [{ label: 'Yes' }, { label: 'No' }] };
		const { input, terminal, claims, setView } = setup({ interaction: { kind: 'question', id: 'g' }, pendingQuestions: [question] });
		// ラベル `Yes` は許可の確認にもあるが、質問の画面ではないので打鍵しない
		terminal.screen = PERMISSION_SCREEN;
		const onPermission = await input.answerQuestions(1, 't', 'g', [{ kind: 'option', index: 0 }]);
		terminal.screen = ['どちらの案で進めますか?', '❯ 1. Yes', '  2. No', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
		const answered = await input.answerQuestions(1, 't', 'g', [{ kind: 'option', index: 1 }]);
		setView({ pendingQuestions: [{ ...question, options: [] }] });
		const noMarker = await input.answerQuestions(1, 't', 'g', [{ kind: 'text', optionCount: 0, text: 'x' }]);
		assert.deepStrictEqual({ onPermission: onPermission !== undefined, answered, noMarker: noMarker !== undefined, sent: terminal.sent, claims }, {
			onPermission: true,
			answered: undefined,
			noMarker: true,
			sent: ['"2"'],
			claims: ['claim:question:g', 'release:question:g:false', 'claim:question:g', 'release:question:g:true'],
		});
	});

	test('answers an approval only when its own prompt is on screen, stops before a stray Enter, and hands Codex approvals to the app-server', async () => {
		const approval = { kind: 'approval' as const, id: 'approval:e:0', detail: 'Bash: npm test -- auth', choices: [{ id: 'yes', label: '許可', tone: 'approve' as const }] };
		const { input, terminal, claims, setView } = setup({ interaction: approval });
		// 画面に出ているのは別のコマンドの確認
		terminal.screen = PERMISSION_SCREEN.replace(/npm test -- auth/g, 'rm -rf dist');
		const otherPrompt = await input.answerApproval(1, 't', approval.id, 'yes');
		// `1` で確認が閉じたら、残りの Enter は送らない
		terminal.screen = PERMISSION_SCREEN;
		terminal.onKey = key => { if (key === '1') { terminal.screen = '⏺ Bash(npm test -- auth)\n  ⎿ Running…'; } };
		const approved = await input.answerApproval(1, 't', approval.id, 'yes');
		terminal.onKey = undefined;
		// 答え終えた承認は、中継に残っていても画面から消えていれば文を送れる
		const afterAnswer = await input.sendMessage(1, 't', 'next');
		setView({ interaction: { kind: 'approval', id: 'codex:thread:1', choices: [{ id: '0', label: 'Yes', tone: 'approve' }] } });
		const codex = await input.answerApproval(1, 't', 'codex:thread:1', '0');
		assert.deepStrictEqual({ otherPrompt: otherPrompt !== undefined, approved, afterAnswer, codex, sent: terminal.sent, claims }, {
			otherPrompt: true,
			approved: undefined,
			afterAnswer: undefined,
			codex: undefined,
			sent: ['"1"', 'paste:"next"', '"\\r"'],
			claims: ['claim:approval:approval:e:0', 'release:approval:approval:e:0:false', 'claim:approval:approval:e:0', 'release:approval:approval:e:0:true', 'codex:codex:thread:1:0'],
		});
	});

	test('does not type while another place holds the answer, and tells shells apart from agents by the foreground process name', async () => {
		const { input, terminal } = setup({ interaction: { kind: 'approval', id: 'approval:e:1', detail: 'Bash: npm test' } }, false);
		terminal.screen = PERMISSION_SCREEN;
		const locked = await input.answerApproval(1, 't', 'approval:e:1', 'yes');
		assert.deepStrictEqual({
			locked: locked !== undefined,
			sent: terminal.sent,
			shells: ['zsh', '-zsh', 'bash', 'pwsh.exe', 'fish'].map(paradisIsShellProcessName),
			agents: ['claude', 'node', 'codex', 'cc', 'npx'].map(paradisIsShellProcessName),
			screens: [PERMISSION_SCREEN, 'Would you like to proceed?\n❯ 1. Yes, and auto-accept edits', 'Do you want to proceed?\n\n> '].map(paradisScreenShowsPermissionPrompt),
		}, {
			locked: true,
			sent: [],
			shells: [true, true, true, true, true],
			agents: [false, false, false, false, false],
			screens: [true, true, false],
		});
	});
});
