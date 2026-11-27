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
import type { ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentChatSource, IParadisAgentChatView } from '../../common/paradisAgentChat.js';
import { PARADIS_AGENT_KINDS, ParadisAgentKind } from '../../common/paradisAgentDescriptor.js';
import { IParadisAgentChatTerminal, ParadisAgentChatInput, paradisCodexApprovalFormOptions, paradisIsShellProcessName, paradisDraftIsOnly } from '../../browser/paradisAgentChatInput.js';
import { paradisScreenShowsAgentPrompt, paradisScreenShowsPermissionPrompt } from '../../browser/paradisAgentTuiInput.js';
import { ParadisAgentChatSession } from '../../browser/paradisAgentChatSession.js';
import { CODEX_EXEC_APPROVAL_DETAIL, CODEX_EXEC_APPROVAL_SCREEN, CODEX_MCP_APPROVAL_DETAIL, CODEX_MCP_APPROVAL_SCREEN, CODEX_WORKING_SCREEN } from './paradisCodexPromptScreens.js';

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
	status: ParadisAgentStatus | undefined;
	agentStatus(): ParadisAgentStatus | undefined { return this.status; }
	focused = false;
	hasKeyboardFocus(): boolean { return this.focused; }
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

/** codex-cli 0.155.1 の request_user_input の実画面（フェーズ6の実機確認）。 */
const CODEX_QUESTION_SCREEN = [
	'Question 1/1 (1 unanswered)',
	'Which environment should I deploy to?',
	'',
	'› 1. Development (Recommended)  dev',
	'  2. Production                 prod',
	'  3. None of the above          Optionally, add details in notes (tab).',
	'',
	'tab to add notes | enter to submit answer | esc to interrupt',
].join('\n');

/** Claude Code 2.1.283 の、計画が空の ExitPlanMode の実画面。 */
const EXIT_PLAN_SCREEN = [
	'──────────────────────────────────────',
	'Exit plan mode?',
	'',
	' Claude wants to exit plan mode',
	'',
	'❯ 1. Yes, and switch to default (ask each time) for this session',
	'  2. No',
].join('\n');

/** 返答の本文に確認の文言と番号の例があり、その下に入力欄が出ている実画面（Claude Code 2.1.283）。 */
const BODY_LIST_SCREEN = [
	'● 説明の例です。TUI では次のように表示されます:',
	'',
	'  Do you want to proceed?',
	'  1. Yes',
	'  2. No',
	'',
	'  以上です。',
	'',
	'✻ Cogitated for 0s · done 16:33',
	'',
	'──────────────────────────────────────',
	'❯ ',
	'──────────────────────────────────────',
	'  ▸▸ accept edits on (shift+tab to cycle) · ← for agents',
].join('\n');

/** codex-cli 0.160.0 の Plan モードの後の選択画面（Enter で「実装に進む」が選ばれる）。 */
const CODEX_PLAN_MENU_SCREEN = [
	'  Implement this plan?',
	'',
	'\u203a 1. Yes, implement this plan          Switch to Default and start coding',
	'  2. Yes, clear context and implement  Start a fresh thread',
	'  3. No, stay in Plan mode             Continue planning with the model',
	'',
	'  enter select \u00b7 esc back',
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
		return { input, terminal, source, claims, setView: (next: Partial<IParadisAgentChatView>) => { current = { ...current, ...next }; } };
	}

	test('pastes a message into Antigravity CLI only while it waits for input, and leaves its questions to the terminal', async () => {
		const question = { rev: 0, role: 'assistant' as const, kind: 'question' as const, text: 'どちらにしますか', toolUseId: 'agy-1-0', questionGroup: 'agy-1-0', options: [{ label: 'A' }, { label: 'B' }] };
		const fixture = setup({ agent: 'antigravity', sessionId: '00000000-0000-4000-8000-00000000a6e5' });
		const blocked: Record<string, boolean> = {};
		for (const status of ['permission', 'question', 'working'] as const) {
			fixture.terminal.status = status;
			blocked[status] = await fixture.input.sendMessage(1, 't', '続けて') !== undefined;
		}
		fixture.terminal.status = undefined;
		fixture.terminal.front = 'unknown';
		const unknownForeground = await fixture.input.sendMessage(1, 't', '続けて') !== undefined;
		fixture.terminal.front = 'agent';
		const sent = await fixture.input.sendMessage(1, 't', '続けて');
		fixture.setView({ messages: [question], interaction: { kind: 'question', id: 'agy-1-0' }, pendingQuestions: [question] });
		const answer = await fixture.input.answerQuestions(1, 't', 'agy-1-0', [{ kind: 'option', index: 0 }]);
		assert.deepStrictEqual({ blocked, unknownForeground, sent, answerRefused: answer !== undefined, keys: fixture.terminal.sent }, {
			blocked: { permission: true, question: true, working: true },
			unknownForeground: true,
			sent: undefined,
			answerRefused: true,
			keys: ['paste:"続けて"', '"\\r"'],
		});
	});

	test('does not type into Claude Code while the mod says a screen like /model is open', async () => {
		const fixture = setup({ agent: 'claude' });
		let open: boolean | undefined = true;
		fixture.source.isAgentChatDialogOpen = async () => open;
		const refused = await fixture.input.sendMessage(1, 't', '続けて');
		open = undefined;
		const sent = await fixture.input.sendMessage(1, 't', '続けて');
		assert.deepStrictEqual({ refused, sent }, { refused: 'ターミナルで画面が開いています。閉じてから送ってください', sent: undefined });
	});

	test('delivers a bot message to a working agent only when it holds messages until its next turn, and never on top of the owner\'s draft', async () => {
		const claude = setup({ agent: 'claude' });
		const codex = setup({ agent: 'codex' });
		const working = { working: true, refuseDraft: true };
		const results = {
			claudeWorking: await claude.input.sendMessageOutcome(1, 't', 'hi', working),
			codexWorking: await codex.input.sendMessageOutcome(1, 't', 'hi', working),
			codexIdle: await codex.input.sendMessageOutcome(1, 't', 'hi', { working: false, refuseDraft: true }),
		};
		const drafting = setup({ agent: 'claude' });
		let draft: string | undefined = 'まだ途中の指示';
		drafting.source.getAgentChatDraft = async () => draft;
		const draftRefused = await drafting.input.sendMessageOutcome(1, 't', 'hi', working);
		const typedBeforeDraftRefused = drafting.terminal.sent.length;
		draft = '';
		const draftEmpty = await drafting.input.sendMessageOutcome(1, 't', 'hi', working);
		// 貼った後に利用者が打ち足した: Enter を送らない（届いたか分からない）
		const appended = setup({ agent: 'claude' });
		let appendedDraft = '';
		appended.source.getAgentChatDraft = async () => appendedDraft;
		appended.terminal.onKey = text => { appendedDraft = `${text} と追記`; };
		const appendedResult = await appended.input.sendMessageOutcome(1, 't', 'hi', working);
		// 書きかけを読めない宛先（Codex）: 利用者がそのターミナルを操作中なら送らない、離れていれば送る
		const unreadable = setup({ agent: 'codex' });
		unreadable.terminal.focused = true;
		const focusedResult = await unreadable.input.sendMessageOutcome(1, 't', 'hi', { working: false, refuseDraft: true });
		const typedWhileFocused = unreadable.terminal.sent.length;
		const focusedOwnSend = await unreadable.input.sendMessage(1, 't', 'mine');
		unreadable.terminal.focused = false;
		const unfocusedResult = await unreadable.input.sendMessageOutcome(1, 't', 'hi', { working: false, refuseDraft: true });
		assert.deepStrictEqual({
			focusedResult,
			typedWhileFocused,
			focusedOwnSend,
			unfocusedResult: unfocusedResult.kind,
			...results,
			typedClaude: claude.terminal.sent,
			typedCodex: codex.terminal.sent,
			draftRefused,
			typedBeforeDraftRefused,
			draftEmpty: draftEmpty.kind,
			appended: appendedResult.kind,
			appendedTyped: appended.terminal.sent,
			draftOnly: [paradisDraftIsOnly('', undefined), paradisDraftIsOnly('hi', undefined), paradisDraftIsOnly('hi', 'hi'), paradisDraftIsOnly('[Pasted text #1 +4 lines]', 'long'), paradisDraftIsOnly('x hi', 'hi')],
		}, {
			claudeWorking: { kind: 'sent' },
			codexWorking: { kind: 'refused', code: 'working', message: 'エージェントが作業中です。終わってから送ってください' },
			codexIdle: { kind: 'sent' },
			typedClaude: ['paste:"hi"', '"\\r"'],
			typedCodex: ['paste:"hi"', '"\\r"'],
			draftRefused: { kind: 'refused', code: 'draft', message: '入力欄に書きかけの文があります' },
			typedBeforeDraftRefused: 0,
			draftEmpty: 'sent',
			appended: 'unknown',
			appendedTyped: ['paste:"hi"'],
			draftOnly: [true, false, true, true, false],
			focusedResult: { kind: 'refused', code: 'focused', message: '利用者がこのターミナルを操作中です' },
			typedWhileFocused: 0,
			// 利用者自身の送信（チャット表示・部屋）はフォーカスで止めない
			focusedOwnSend: undefined,
			unfocusedResult: 'sent',
		});
	});

	test('does not type into Codex while its choice menu is on the screen, since Enter would pick the default choice', async () => {
		const fixture = setup({ agent: 'codex' });
		fixture.terminal.screen = CODEX_PLAN_MENU_SCREEN;
		const refused = await fixture.input.sendMessage(1, 't', '続けて');
		fixture.terminal.screen = CODEX_WORKING_SCREEN;
		const sent = await fixture.input.sendMessage(1, 't', '続けて');
		assert.deepStrictEqual({ refused, sent, typed: fixture.terminal.sent.length > 0 }, {
			refused: 'ターミナルに選択の画面が出ています。ターミナルで選んでから送ってください',
			sent: undefined,
			typed: true,
		});
	});

	test('answers an Antigravity CLI approval through the waiting approval hook, never with keys', async () => {
		const fixture = setup({ agent: 'antigravity', sessionId: '00000000-0000-4000-8000-00000000a6e6', interaction: { kind: 'approval', id: 'call_1', detail: 'npm test' } });
		fixture.terminal.screen = PERMISSION_SCREEN;
		const allowed = await fixture.input.answerApproval(1, 't', 'call_1', 'yes');
		const option = await fixture.input.answerApproval(1, 't', 'call_1', 'opt:1', 'Yes');
		fixture.source.answerAgentChatApproval = async () => false;
		const gone = await fixture.input.answerApproval(1, 't', 'call_1', 'no');
		assert.deepStrictEqual({ allowed, optionRefused: option !== undefined, goneRefused: gone !== undefined, claims: fixture.claims, keys: fixture.terminal.sent }, {
			allowed: undefined,
			optionRefused: true,
			goneRefused: true,
			claims: ['codex:call_1:yes'],
			keys: [],
		});
	});

	test('sends OpenCode messages and exact pending answers through the API without any PTY fallback', async () => {
		const question = { rev: 0, role: 'assistant' as const, kind: 'question' as const, text: 'Choose a plan', toolUseId: 'opencode:req_question', questionGroup: 'opencode:req_question', options: [{ label: 'First' }] };
		const fixture = setup({ agent: 'opencode', sessionId: 'ses_saved' });
		const calls: string[] = [];
		fixture.source.sendOpenCodeAgentMessage = async (_token, sid, text) => { calls.push(`message:${sid}:${text}`); return true; };
		fixture.source.answerOpenCodeAgentQuestions = async (_token, sid, id) => { calls.push(`question:${sid}:${id}`); return true; };
		fixture.source.answerOpenCodeAgentApproval = async (_token, sid, id, choice) => { calls.push(`approval:${sid}:${id}:${choice}`); return false; };
		fixture.terminal.paste = false;
		assert.strictEqual(await fixture.input.sendMessage(1, 't', 'two\nlines'), undefined);
		fixture.setView({ interaction: { kind: 'question', id: 'opencode:req_question' }, pendingQuestions: [question] });
		assert.strictEqual(await fixture.input.answerQuestions(1, 't', 'opencode:req_question', [{ kind: 'option', index: 0 }]), undefined);
		fixture.setView({ interaction: { kind: 'approval', id: 'opencode:req_permission', detail: 'bash' } });
		assert.notStrictEqual(await fixture.input.answerApproval(1, 't', 'opencode:req_permission', 'yes'), undefined);
		assert.deepStrictEqual({ calls, sent: fixture.terminal.sent, claims: fixture.claims }, {
			calls: ['message:ses_saved:two\nlines', 'question:ses_saved:opencode:req_question', 'approval:ses_saved:opencode:req_permission:yes'], sent: [], claims: [],
		});
	});

	test('asks to check on the PC when OpenCode took a message but never answered, instead of reporting a failed send', async () => {
		const fixture = setup({ agent: 'opencode', sessionId: 'ses_saved' });
		fixture.source.sendOpenCodeAgentMessage = async () => 'unconfirmed';
		const failed = setup({ agent: 'opencode', sessionId: 'ses_saved' });
		failed.source.sendOpenCodeAgentMessage = async () => false;
		const [unconfirmed, rejected] = [await fixture.input.sendMessage(1, 't', 'continue'), await failed.input.sendMessage(1, 't', 'continue')];
		assert.deepStrictEqual({ unconfirmed: unconfirmed?.includes('PC のターミナルで確かめて'), rejected: rejected?.includes('送れませんでした'), sent: [...fixture.terminal.sent, ...failed.terminal.sent] }, { unconfirmed: true, rejected: true, sent: [] });
	});

	test('does not type into OpenCode when its API is unavailable or its session identity is missing', async () => {
		const fixture = setup({ agent: 'opencode', sessionId: 'ses_saved' });
		assert.notStrictEqual(await fixture.input.sendMessage(1, 't', 'continue'), undefined);
		fixture.setView({ sessionId: undefined });
		fixture.source.sendOpenCodeAgentMessage = async () => { throw new Error('Must not send without session identity'); };
		assert.notStrictEqual(await fixture.input.sendMessage(1, 't', 'continue'), undefined);
		assert.deepStrictEqual(fixture.terminal.sent, []);
	});

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

	test('answers a question with a preview with its number and Enter, keeps plain questions on the number alone, and refuses "Other" on a preview question', async () => {
		// Claude Code 2.1.288（tmux で実測）: preview のある質問の数字キーは選ぶだけで確定しない。Enter で確定し、単問は送信、多問は次の質問へ
		const preview = { rev: 0, role: 'assistant' as const, kind: 'question' as const, text: 'エラーはどう見せますか?', toolUseId: 'q1', questionGroup: 'g', questionIndex: 0, options: [{ label: 'Toast', preview: '# Toast' }, { label: 'Inline', preview: '# Inline' }] };
		const plain = { rev: 1, role: 'assistant' as const, kind: 'question' as const, text: '色は?', toolUseId: 'q1', questionGroup: 'g', questionIndex: 1, options: [{ label: 'Red' }, { label: 'Blue' }] };
		const { input, terminal, setView } = setup({ interaction: { kind: 'question', id: 'g' }, pendingQuestions: [preview] });
		terminal.screen = ['エラーはどう見せますか?', '❯ 1. Toast', '  2. Inline', 'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel'].join('\n');
		const single = await input.answerQuestions(1, 't', 'g', [{ kind: 'option', index: 1 }]);
		const singleSent = [...terminal.sent];
		terminal.sent.length = 0;
		const other = await input.answerQuestions(1, 't', 'g', [{ kind: 'text', optionCount: 2, text: 'no notes' }]);
		const otherSent = [...terminal.sent];
		setView({ pendingQuestions: [preview, plain] });
		const mixed = await input.answerQuestions(1, 't', 'g', [{ kind: 'option', index: 1 }, { kind: 'option', index: 0 }]);
		assert.deepStrictEqual({ single, singleSent, other: other !== undefined, otherSent, mixed, mixedSent: terminal.sent }, {
			single: undefined,
			singleSent: ['"2"', '"\\r"'],
			other: true,
			otherSent: [],
			mixed: undefined,
			// Q1（preview）は番号と Enter、Q2（ふつう）は番号だけ、最後に確認画面の Enter
			mixedSent: ['"2"', '"\\r"', '"1"', '"\\r"'],
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

	test('the "yes" of a Claude Code plan approval picks the row that is not auto mode, and is not sent when no row allows it', async () => {
		// Claude Code 2.1.332 の実画面（1 番が auto mode に入る行）
		const plan332 = [
			'  ' + '─'.repeat(116),
			'   Ready to code?',
			'',
			'   Here is Claude\'s plan:',
			'  ' + '╌'.repeat(116),
			'   Plan',
			'',
			'   1. Do the first thing',
			'   2. Do the second thing',
			'  ' + '╌'.repeat(116),
			'  ' + '─'.repeat(116),
			'   Claude has written up a plan and is ready to execute. Would you like to proceed?',
			'',
			'   ❯ 1. Yes, and use auto mode',
			'     2. Yes, manually approve edits',
			'     3. Tell Claude what to change',
			'        shift+tab to approve with this feedback',
			'',
			'   ctrl+g to edit in Vim · ~/.claude/plans/plan-zzplanfile-smooth-snail.md',
		].join('\n');
		// 承認が保留された計画（1 番は自由入力の行で、`1` は確定にならない）
		const withheld332 = [
			'   (the plan is too large to be shown in full — approval is withheld; send feedback asking for a shorter plan, or',
			'   press Esc)',
			'  ' + '╌'.repeat(116),
			'  ' + '─'.repeat(116),
			'   Claude has written up a plan and is ready to execute. Would you like to proceed?',
			'',
			'   ❯ 1. Tell Claude what to change',
			'',
			'   ctrl+g to edit in Vim · ~/.claude/plans/plan-zzplanwh-valiant-abelson.md',
		].join('\n');
		const approval = { kind: 'approval' as const, id: 'approval:e:9', choices: [{ id: 'yes', label: '許可', tone: 'approve' as const }] };
		const { input, terminal, claims } = setup({ interaction: approval });
		terminal.screen = withheld332;
		const withheld = await input.answerApproval(1, 't', approval.id, 'yes');
		const sentWhileWithheld = [...terminal.sent];
		terminal.screen = plan332;
		terminal.onKey = () => { terminal.screen = '\u23fa Working\u2026'; };
		const approved = await input.answerApproval(1, 't', approval.id, 'yes');
		assert.deepStrictEqual({ withheldRefused: withheld !== undefined, sentWhileWithheld, approved, sent: terminal.sent, claims }, {
			withheldRefused: true,
			sentWhileWithheld: [],
			approved: undefined,
			sent: ['"2"'],
			claims: ['claim:approval:approval:e:9', 'release:approval:approval:e:9:false', 'claim:approval:approval:e:9', 'release:approval:approval:e:9:true'],
		});
	});

	test('answers a tall Codex command approval with y and a Codex tool approval form with 1 or Esc, only for its own tool', async () => {
		const exec = { kind: 'approval' as const, id: 'approval:e:2', detail: CODEX_EXEC_APPROVAL_DETAIL };
		const { input, terminal, setView } = setup({ agent: 'codex', interaction: exec });
		const sentFor = async (screen: string, id: string, choice: string) => {
			terminal.sent.length = 0;
			terminal.screen = screen;
			// 答えたら確認が閉じて作業中の表示になる
			terminal.onKey = () => { terminal.screen = CODEX_WORKING_SCREEN; };
			const error = await input.answerApproval(1, 't', id, choice);
			return { error, sent: [...terminal.sent] };
		};
		const execYes = await sentFor(CODEX_EXEC_APPROVAL_SCREEN, exec.id, 'yes');
		const tool = { kind: 'approval' as const, id: 'approval:e:3', detail: CODEX_MCP_APPROVAL_DETAIL };
		setView({ interaction: tool });
		const toolYes = await sentFor(CODEX_MCP_APPROVAL_SCREEN, tool.id, 'yes');
		const toolNo = await sentFor(CODEX_MCP_APPROVAL_SCREEN, tool.id, 'no');
		// 画面に出ているのは別のツールの許可
		setView({ interaction: { ...tool, id: 'approval:e:4', detail: 'mcp__para-browser__board_ask_human: {"question":"?"}' } });
		const otherTool = await sentFor(CODEX_MCP_APPROVAL_SCREEN, 'approval:e:4', 'yes');
		assert.deepStrictEqual({ execYes, toolYes, toolNo, otherTool: { refused: otherTool.error !== undefined, sent: otherTool.sent } }, {
			execYes: { error: undefined, sent: ['"y"'] },
			toolYes: { error: undefined, sent: ['"1"'] },
			toolNo: { error: undefined, sent: ['"\\u001b"'] },
			otherTool: { refused: true, sent: [] },
		});
	});

	test('answers a numbered option of a Codex tool approval form only while the same label is on screen, for the board', async () => {
		const tool = { kind: 'approval' as const, id: 'approval:e:5', detail: CODEX_MCP_APPROVAL_DETAIL };
		const { input, terminal } = setup({ agent: 'codex', interaction: tool });
		const options = paradisCodexApprovalFormOptions(CODEX_MCP_APPROVAL_SCREEN, CODEX_MCP_APPROVAL_DETAIL);
		const answer = async (choice: string, label?: string) => {
			terminal.sent.length = 0;
			terminal.screen = CODEX_MCP_APPROVAL_SCREEN;
			terminal.onKey = () => { terminal.screen = CODEX_WORKING_SCREEN; };
			const error = await input.answerApproval(1, 't', tool.id, choice, label);
			return { refused: error !== undefined, sent: [...terminal.sent] };
		};
		assert.deepStrictEqual({
			options: options?.map(option => option.n),
			// 別の承認の確認には選択肢を出さない
			otherApproval: paradisCodexApprovalFormOptions(CODEX_MCP_APPROVAL_SCREEN, 'mcp__para-browser__board_ask_human: {}'),
			notForm: paradisCodexApprovalFormOptions(CODEX_EXEC_APPROVAL_SCREEN, CODEX_EXEC_APPROVAL_DETAIL),
			session: await answer('opt:2', options![1].label),
			// 見せた文言と画面の文言が違えば送らない
			changed: await answer('opt:2', options![2].label),
			withoutLabel: await answer('opt:2'),
		}, {
			options: [1, 2, 3, 4],
			otherApproval: undefined,
			notForm: undefined,
			session: { refused: false, sent: ['"2"'] },
			changed: { refused: true, sent: [] },
			withoutLabel: { refused: true, sent: [] },
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
			screens: [PERMISSION_SCREEN, 'Would you like to proceed?\n❯ 1. Yes, and auto-accept edits', 'Do you want to proceed?\n\n> ', EXIT_PLAN_SCREEN, BODY_LIST_SCREEN].map(paradisScreenShowsPermissionPrompt),
			questionScreens: [CODEX_QUESTION_SCREEN, BODY_LIST_SCREEN].map(screen => paradisScreenShowsAgentPrompt(screen)),
		}, {
			locked: true,
			sent: [],
			shells: [true, true, true, true, true],
			agents: [false, false, false, false, false],
			screens: [true, true, false, true, false],
			questionScreens: [true, false],
		});
	});

	test('does not send while Codex asks a request_user_input question', async () => {
		const { input, terminal, setView } = setup({ agent: 'codex', messages: [{ rev: 0, role: 'assistant', kind: 'tool_use', tool: 'request_user_input', text: '{}', toolUseId: 'call_1' }] });
		const whileAsking = await input.sendMessage(1, 't', 'deploy to dev');
		setView({ messages: [{ rev: 0, role: 'assistant', kind: 'tool_use', tool: 'request_user_input', text: '{}', toolUseId: 'call_1' }, { rev: 1, role: 'tool', kind: 'tool_result', text: 'ok', toolUseId: 'call_1' }] });
		// 中継の会話に呼び出しが出る前でも、画面の質問（実画面の文言）で止まる
		terminal.screen = CODEX_QUESTION_SCREEN;
		const onScreen = await input.sendMessage(1, 't', 'deploy to dev');
		assert.deepStrictEqual({ whileAsking: whileAsking !== undefined, onScreen: onScreen !== undefined, sent: terminal.sent }, { whileAsking: true, onScreen: true, sent: [] });
	});

	test('routes sends, question answers and approval answers by agent kind, with the same refusals for every kind', async () => {
		const question = { rev: 0, role: 'assistant' as const, kind: 'question' as const, text: 'どちらの案で進めますか?', toolUseId: 'q1', questionGroup: 'g', options: [{ label: 'Yes' }, { label: 'No' }] };
		const questionScreen = ['どちらの案で進めますか?', '❯ 1. Yes', '  2. No', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
		type Fixture = ReturnType<typeof setup>;
		const run = async (agent: ParadisAgentKind, prepare: (fixture: Fixture) => void, act: (input: ParadisAgentChatInput) => Promise<string | undefined>) => {
			const fixture = setup({ agent, sessionId: 'ses_1' });
			fixture.source.sendOpenCodeAgentMessage = async (_token, sid, text) => { fixture.claims.push(`api:message:${sid}:${text}`); return true; };
			fixture.source.answerOpenCodeAgentQuestions = async (_token, sid, id) => { fixture.claims.push(`api:question:${sid}:${id}`); return true; };
			fixture.source.answerOpenCodeAgentApproval = async (_token, sid, id, choice) => { fixture.claims.push(`api:approval:${sid}:${id}:${choice}`); return true; };
			prepare(fixture);
			const error = await act(fixture.input);
			return { error, keys: fixture.terminal.sent, calls: fixture.claims };
		};
		const approvalOf = (agent: ParadisAgentKind) => ({ kind: 'approval' as const, id: 'approval:e:0', detail: agent === 'codex' ? CODEX_EXEC_APPROVAL_DETAIL : 'Bash: npm test -- auth' });
		const showApproval = (agent: ParadisAgentKind) => (fixture: Fixture) => {
			fixture.setView({ interaction: approvalOf(agent) });
			fixture.terminal.screen = agent === 'codex' ? CODEX_EXEC_APPROVAL_SCREEN : PERMISSION_SCREEN;
		};
		const table: Record<string, object> = {};
		for (const agent of PARADIS_AGENT_KINDS) {
			table[agent] = {
				send: await run(agent, () => { }, input => input.sendMessage(1, 't', 'hello')),
				sendFromShell: await run(agent, fixture => { fixture.terminal.front = 'shell'; }, input => input.sendMessage(1, 't', 'hello')),
				sendWhileApprovalWaits: await run(agent, showApproval(agent), input => input.sendMessage(1, 't', 'hello')),
				question: await run(agent, fixture => {
					fixture.setView({ messages: [question], interaction: { kind: 'question', id: 'g' }, pendingQuestions: [question] });
					fixture.terminal.screen = questionScreen;
				}, input => input.answerQuestions(1, 't', 'g', [{ kind: 'option', index: 1 }])),
				approval: await run(agent, showApproval(agent), input => input.answerApproval(1, 't', 'approval:e:0', 'yes')),
				approvalAlways: await run(agent, showApproval(agent), input => input.answerApproval(1, 't', 'approval:e:0', 'always')),
			};
		}
		// 送る直前の取り直しで、会話が OpenCode のものに変わっていた（入力欄へは打たない）
		table.becameOpenCode = await run('claude', fixture => {
			const getAgentChat = fixture.source.getAgentChat;
			let reads = 0;
			fixture.source.getAgentChat = async (...args) => {
				if (++reads === 2) {
					fixture.setView({ agent: 'opencode' });
				}
				return getAgentChat(...args);
			};
		}, input => input.sendMessage(1, 't', 'hello'));
		assert.deepStrictEqual(table, {
			claude: {
				send: { error: undefined, keys: ['paste:"hello"', '"\\r"'], calls: [] },
				sendFromShell: { error: 'エージェントが前面で動いていません。ターミナルで確かめてください', keys: [], calls: [] },
				sendWhileApprovalWaits: { error: 'エージェントが回答を待っています。先に質問・許可の確認に答えてください', keys: [], calls: [] },
				question: { error: undefined, keys: ['"2"'], calls: ['claim:question:g', 'release:question:g:true'] },
				approval: { error: undefined, keys: ['"1"'], calls: ['claim:approval:approval:e:0', 'release:approval:approval:e:0:true'] },
				approvalAlways: { error: undefined, keys: [], calls: ['codex:approval:e:0:always'] },
			},
			codex: {
				send: { error: undefined, keys: ['paste:"hello"', '"\\r"'], calls: [] },
				sendFromShell: { error: 'エージェントが前面で動いていません。ターミナルで確かめてください', keys: [], calls: [] },
				sendWhileApprovalWaits: { error: 'エージェントが回答を待っています。先に質問・許可の確認に答えてください', keys: [], calls: [] },
				question: { error: undefined, keys: ['"2"'], calls: ['claim:question:g', 'release:question:g:true'] },
				approval: { error: undefined, keys: ['"y"'], calls: ['claim:approval:approval:e:0', 'release:approval:approval:e:0:true'] },
				approvalAlways: { error: undefined, keys: [], calls: ['codex:approval:e:0:always'] },
			},
			opencode: {
				send: { error: undefined, keys: [], calls: ['api:message:ses_1:hello'] },
				sendFromShell: { error: undefined, keys: [], calls: ['api:message:ses_1:hello'] },
				sendWhileApprovalWaits: { error: 'OpenCode の会話が変わったか、回答を待っています', keys: [], calls: [] },
				question: { error: undefined, keys: [], calls: ['api:question:ses_1:g'] },
				approval: { error: undefined, keys: [], calls: ['api:approval:ses_1:approval:e:0:yes'] },
				approvalAlways: { error: undefined, keys: [], calls: ['api:approval:ses_1:approval:e:0:always'] },
			},
			antigravity: {
				send: { error: undefined, keys: ['paste:"hello"', '"\\r"'], calls: [] },
				sendFromShell: { error: 'ターミナルで Antigravity CLI が動いていることを確かめられませんでした。ターミナルで確かめてください', keys: [], calls: [] },
				sendWhileApprovalWaits: { error: 'Antigravity CLI が質問の回答を待っています。ターミナルで答えてから送ってください', keys: [], calls: [] },
				question: { error: 'Antigravity CLI の質問・確認にはまだチャット欄から答えられません。ターミナルで答えてください', keys: [], calls: [] },
				approval: { error: undefined, keys: [], calls: ['codex:approval:e:0:yes'] },
				approvalAlways: { error: 'この確認にはここから答えられなくなりました。ターミナルで答えてください', keys: [], calls: [] },
			},
			becameOpenCode: { error: 'OpenCode の会話が変わったか、回答を待っています', keys: [], calls: [] },
		});
	});
});
