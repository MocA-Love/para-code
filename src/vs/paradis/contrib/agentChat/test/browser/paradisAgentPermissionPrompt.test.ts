/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisClaudeResumeScreenPrompt, paradisPermissionPromptHash, paradisPermissionPromptParts, paradisPromptRegionShows, paradisScreenShowsAgentPrompt, paradisScreenShowsClaudeResumePrompt, paradisScreenShowsClaudeYesNoPlanPrompt, paradisScreenShowsPermissionPrompt, paradisScreenShowsQuestionPrompt, paradisVisibleTerminalLogicalText } from '../../browser/paradisAgentTuiInput.js';
import { paradisApprovalScreenPiece, paradisCodexApprovalFormShown, paradisCodexApprovalFormShows, paradisParseApprovalOptions, paradisParsePermissionWarning } from '../../../mobileRelay/common/paradisAgentApprovalOptions.js';
import { CODEX_EXEC_APPROVAL_DETAIL, CODEX_EXEC_APPROVAL_SCREEN, CODEX_MCP_APPROVAL_DETAIL, CODEX_MCP_APPROVAL_SCREEN, CODEX_WORKING_SCREEN } from './paradisCodexPromptScreens.js';

suite('paradisPermissionPromptParts (W2-21 review M1 / M2)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 【推測】Claude Code 2.1 系の許可の画面の形。上に会話の本文の番号付きの箇条書きが残っている。
	const screen = (command: string) => [
		'1. First step',
		'2. Second step',
		'────────────────────────────────────────',
		' Bash command',
		'',
		`   ${command}`,
		'   Push to the remote',
		'',
		' Do you want to proceed?',
		' ❯ 1. Yes',
		`   2. Yes, and don't ask again for git push commands`,
		'   3. No, and tell Claude what to do differently (esc)',
		'',
		' Esc to cancel',
	].join('\n');

	test('reads the options only after the heading and keeps the command lines as the context', () => {
		const parts = paradisPermissionPromptParts(screen('git push origin main'))!;
		assert.deepStrictEqual({
			context: parts.context.split('\n').map(line => line.trim()).filter(line => line.length > 0),
			options: paradisParseApprovalOptions(parts.options)?.map(option => option.n),
		}, {
			context: ['Bash command', 'git push origin main', 'Push to the remote', 'Do you want to proceed?'],
			options: [1, 2, 3],
		});
	});

	test('changes the fingerprint when the command changes but not when only the wrapping changes', () => {
		const base = paradisPermissionPromptHash(paradisPermissionPromptParts(screen('git push origin main'))!.context);
		const other = paradisPermissionPromptHash(paradisPermissionPromptParts(screen('git push --force'))!.context);
		const rewrapped = paradisPermissionPromptHash(paradisPermissionPromptParts(screen('git push origin main').replace('   git push origin main', '   git push\n   origin main'))!.context);
		assert.deepStrictEqual({ changed: base !== other, rewrapped: base === rewrapped }, { changed: true, rewrapped: true });
	});

	test('joins rows the terminal wrapped automatically so a wrapped option does not hide the ones after it', () => {
		const rows = [
			{ text: ' Do you want to proceed?', wrapped: false },
			{ text: ' ❯ 1. Yes', wrapped: false },
			{ text: `   2. Yes, and don't ask again for git push commands in /Users/exa`, wrapped: false },
			{ text: 'mple/projects/demo', wrapped: true },
			{ text: '   3. No, and tell Claude what to do differently (esc)', wrapped: false },
		];
		const instance = {
			xterm: {
				raw: {
					rows: rows.length,
					buffer: { active: { baseY: 0, getLine: (y: number) => ({ isWrapped: rows[y].wrapped, translateToString: () => rows[y].text }) } },
				},
			},
		} as unknown as ITerminalInstance;
		const text = paradisVisibleTerminalLogicalText(instance);
		assert.deepStrictEqual({
			lines: text.split('\n').length,
			options: paradisParseApprovalOptions(paradisPermissionPromptParts(text)!.options)?.map(option => option.label),
		}, {
			lines: 4,
			options: ['Yes', `Yes, and don't ask again for git push commands in /Users/example/projects/demo`, 'No, and tell Claude what to do differently (esc)'],
		});
	});

	test('returns undefined when no permission prompt is on screen', () => {
		assert.strictEqual(paradisPermissionPromptParts('1. First step\n2. Second step\n'), undefined);
	});

	test('reads the warning line between the dashed rule under the command and the heading (Claude Code 2.1.289 screens)', () => {
		// Claude Code 2.1.289 の実画面（パスは匿名化）。説明 → 点線 → コマンド → 点線 → 警告 → 見出し
		const rule = '╌'.repeat(60);
		const prompt = (header: string, command: string, warning: string) => [
			'⏺ Bash(…)',
			'  ⎿  Waiting…',
			'─'.repeat(60),
			` ${header}`,
			' Copy and clean staging',
			rule,
			` │ ${command}`,
			rule,
			` ${warning}`,
			' Do you want to proceed?',
			' ❯ 1. Yes',
			'   2. No',
			'',
			' Esc to cancel · Tab to amend',
		].join('\n');
		const warningOf = (screen: string) => paradisParsePermissionWarning(paradisPermissionPromptParts(screen)!.context);
		assert.deepStrictEqual([
			warningOf(prompt('Bash command', 'cd ~/projects/demo && sh -c "md5 $C/a.txt; rm -rf ./$C/.staging"', 'This shell -c script runs rm and could not be checked')),
			warningOf(prompt('Bash command · from the general-purpose agent', 'cd ~/projects/demo && sh -c "rm -rf ./junk"', 'This command requires approval')),
			warningOf(screen('git push origin main')),
		], ['This shell -c script runs rm and could not be checked', undefined, undefined]);
	});
});

suite('Codex permission prompts on screen (codex-cli 0.162.1)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 空行を詰めた画面（ボードの欄に貼り付けた形）。 */
	const withoutBlankLines = (screen: string) => screen.split('\n').filter(line => line.trim().length > 0).join('\n');

	test('finds a tall command approval whose heading is above the bottom 14 lines, and a tool approval form, with their own pieces', () => {
		const screens = [CODEX_EXEC_APPROVAL_SCREEN, withoutBlankLines(CODEX_EXEC_APPROVAL_SCREEN), CODEX_MCP_APPROVAL_SCREEN, withoutBlankLines(CODEX_MCP_APPROVAL_SCREEN)];
		assert.deepStrictEqual({
			shown: screens.map(paradisScreenShowsPermissionPrompt),
			// 理由の折り返し（`Git` / `管理領域`）をまたいでも一片が当たる
			execPiece: paradisPromptRegionShows(CODEX_EXEC_APPROVAL_SCREEN, paradisApprovalScreenPiece(CODEX_EXEC_APPROVAL_DETAIL, 'codex')!),
			mcpPiece: paradisApprovalScreenPiece(CODEX_MCP_APPROVAL_DETAIL, 'codex'),
			// Claude Code の MCP のツールの確認にはこの文言が出ないので、Claude では作らない（中身の JSON からも作れない）
			claudeMcpPiece: paradisApprovalScreenPiece(CODEX_MCP_APPROVAL_DETAIL),
			mcpShown: paradisPromptRegionShows(CODEX_MCP_APPROVAL_SCREEN, paradisApprovalScreenPiece(CODEX_MCP_APPROVAL_DETAIL, 'codex')!),
			// 同じサーバーの別のツールの許可とは取り違えない
			otherTool: paradisPromptRegionShows(CODEX_MCP_APPROVAL_SCREEN, paradisApprovalScreenPiece('mcp__para-browser__board_ask_human: {}', 'codex')!),
			execOptions: paradisParseApprovalOptions(paradisPermissionPromptParts(CODEX_EXEC_APPROVAL_SCREEN)!.options)?.map(option => option.label),
			mcpContext: paradisPermissionPromptParts(CODEX_MCP_APPROVAL_SCREEN)!.context.split('\n').map(line => line.trim()),
			mcpOptions: paradisParseApprovalOptions(paradisPermissionPromptParts(CODEX_MCP_APPROVAL_SCREEN)!.options)?.map(option => option.label),
			form: [CODEX_MCP_APPROVAL_SCREEN, CODEX_EXEC_APPROVAL_SCREEN].map(paradisCodexApprovalFormShown),
		}, {
			shown: [true, true, true, true],
			execPiece: true,
			mcpPiece: 'run tool "board_complete_step"',
			claudeMcpPiece: undefined,
			mcpShown: true,
			otherTool: false,
			execOptions: ['Yes, proceed (y)', 'Yes, and don\'t ask again for commands that start with `rtk git add -- README.md` (p)', 'No, and tell Codex what to do differently (esc)'],
			mcpContext: ['• Calling para-browser.board_complete_step', '+ Show details', 'Field 1/1'],
			mcpOptions: ['Allow Run the tool and continue', 'Allow for this session Run the tool and remember this choice for this session', 'Always allow Run the tool and remember this choice for future tool calls', 'Cancel Cancel this tool call'],
			form: [true, false],
		});
	});

	test('does not widen the search without the Codex footer at the bottom, and ignores forms that do not ask to allow a tool', () => {
		// 会話の本文に見出しと番号付きの箇条書きが残り、下に作業中の表示がある（操作説明が無いので下端の 14 行だけを見る）
		const bodyAbove = ['  Would you like to run the following command?', '  1. Yes', '  2. No', ...Array.from({ length: 14 }, (_, index) => `  line ${index}`), CODEX_WORKING_SCREEN].join('\n');
		// 許可ではない MCP サーバーからの質問（番号 1 が Allow でない）
		const booleanForm = ['  Field 1/1', '  Pick a color', '  › 1. Red', '    2. Blue', '  enter to submit | esc to cancel'].join('\n');
		// 操作説明が出ていない（確認が閉じた）画面に、閉じる前の見出しが残っている
		const closed = CODEX_EXEC_APPROVAL_SCREEN.replace('  Press enter to confirm or esc to cancel', CODEX_WORKING_SCREEN);
		assert.deepStrictEqual({
			bodyAbove: paradisScreenShowsPermissionPrompt(bodyAbove),
			booleanForm: [paradisScreenShowsPermissionPrompt(booleanForm), paradisCodexApprovalFormShown(booleanForm)],
			closed: paradisScreenShowsPermissionPrompt(closed),
			working: paradisScreenShowsAgentPrompt(CODEX_WORKING_SCREEN),
		}, {
			bodyAbove: false,
			booleanForm: [false, false],
			closed: false,
			working: false,
		});
	});

	test('tells the permission for `click` apart from `click_by`, and does not read the tool name from the conversation above the prompt', () => {
		const form = (tool: string, above: readonly string[] = []) => [
			...above,
			`• Calling para-browser.${tool}`,
			'  Field 1/1',
			`  Allow the para-browser MCP server to run tool "${tool}"?`,
			'  › 1. Allow   Run the tool and continue',
			'    2. Cancel  Cancel this tool call',
			'  enter to submit | esc to cancel',
		].join('\n');
		const click = paradisApprovalScreenPiece('mcp__para-browser__click: {"uid":"1"}', 'codex')!;
		// 確認の上に、前に許可した `click` の呼び出しの行が残っている
		const clickByUnderOldClick = form('click_by', ['• Called para-browser.click({"uid":"1"})', '  run tool "click" was allowed earlier', '', '', '']);
		assert.deepStrictEqual({
			piece: click,
			onClick: [paradisPromptRegionShows(form('click'), click), paradisCodexApprovalFormShows(form('click'), click)],
			onClickBy: [paradisPromptRegionShows(form('click_by'), click), paradisCodexApprovalFormShows(form('click_by'), click)],
			oldLineAbove: [paradisPromptRegionShows(clickByUnderOldClick, click), paradisCodexApprovalFormShows(clickByUnderOldClick, click)],
		}, {
			piece: 'run tool "click"',
			onClick: [true, true],
			onClickBy: [false, false],
			oldLineAbove: [false, false],
		});
	});
});

suite('Claude Code resume prompt on screen (Claude Code 2.1.306)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const RULE = '─'.repeat(60);
	// 2.1.306 の実画面（`--resume` で 5 時間使っていない会話を開いた直後）。上に会話の本文が残る
	const resumePrompt = [
		'❯ Say hi in one word.',
		'',
		'● Hi.',
		'',
		RULE,
		'  Resume this conversation?',
		'',
		'  This conversation has been inactive for 5h and is 800k tokens long. Resuming it will use about 73% of your 5-hour',
		'  usage limit.',
		'',
		'  ❯ 1. Resume',
		'    2. Start a new conversation  Claude can look this one up if you refer to it later',
		'',
		'  Enter to confirm · Esc to resume',
		'',
	].join('\n');
	// 幅 40 桁前後: 本文と選択肢が折り返し、見出しが下から 14 行より上に出る
	const narrow = [
		'─'.repeat(40),
		'  Resume this conversation?',
		'',
		'  This conversation has been inactive',
		'  for 5h and is 800k tokens long.',
		'  Resuming it will use about 73% of',
		'  your 5-hour usage limit.',
		'',
		'  ❯ 1. Resume',
		'    2. Start a new conversation',
		'       Claude can look this one up if',
		'       you refer to it later',
		'',
		'',
		'',
		'  Enter to confirm · Esc to',
		'  resume',
	].join('\n');
	// 答えた後: 見出しと 2 つめの選択肢が会話の本文に別々の行で残り、下に入力欄が出ている
	const answered = [
		'● The dialog said:',
		'  Resume this conversation?',
		'  2. Start a new conversation',
		'',
		RULE,
		'❯ ',
		RULE,
		'  ⏵⏵ auto mode on (shift+tab to cycle)',
	].join('\n');
	// Codex のペインで、同じ文言と操作説明が会話の本文として最下部に出ている
	const codex = [
		'• Claude Code shows this when you resume an old conversation:',
		'  Resume this conversation?',
		'  1. Resume',
		'  2. Start a new conversation',
		'  Enter to confirm · Esc to resume',
	].join('\n');

	test('finds the prompt by its footer, also when it is tall in a narrow pane, only for Claude Code, and not once the prompt box is back', () => {
		assert.deepStrictEqual({
			resume: [paradisScreenShowsClaudeResumePrompt(resumePrompt), paradisScreenShowsAgentPrompt(resumePrompt, 'claude'), paradisScreenShowsAgentPrompt(resumePrompt), paradisScreenShowsPermissionPrompt(resumePrompt)],
			narrow: [paradisScreenShowsClaudeResumePrompt(narrow), paradisScreenShowsAgentPrompt(narrow, 'claude')],
			answered: [paradisScreenShowsClaudeResumePrompt(answered), paradisScreenShowsAgentPrompt(answered, 'claude')],
			codex: [paradisScreenShowsAgentPrompt(codex, 'codex'), paradisScreenShowsAgentPrompt(codex)],
		}, {
			resume: [true, true, false, false],
			narrow: [true, true],
			answered: [false, false],
			codex: [false, false],
		});
	});

	test('finds the resume prompt when keybindings.json renames the cancel key, and the idle form with an unsent message (Claude Code 2.1.332)', () => {
		// 2.1.332 のバイナリから組んだ形（実画面は出せていない）: `Enter` は固定、取り消しのキーは `Confirmation` の `confirm:no` の割り当て
		const rebound = resumePrompt.replace('Enter to confirm · Esc to resume', 'Enter to confirm · ctrl+g to resume');
		// 使っていない間に出る型: 番号が無く、文を打ちかけていると操作説明の先頭に 1 つ足される
		const idle = [
			RULE,
			'  Resume this conversation?',
			'',
			'  This conversation has been inactive for 6h and is 300k tokens long. Resuming it will use about 21% of your 5-hour',
			'  usage limit.',
			'  Your unsent message will still be there after you answer.',
			'',
			'  ❯ Resume',
			'    Start a new conversation',
			'',
			'  ↑/↓ to pick a row first · Enter to confirm · Esc to dismiss',
		].join('\n');
		// 2.1.332 の古いセッションの確認（バイナリの文字列。本文と選択肢の文言が 2.1.309 から変わった）
		const sessionAge332 = [
			RULE,
			'  This session is 2d 3h old and 412.3k tokens.',
			'',
			'  Resuming the full session uses a lot of your usage limits. Resuming from a summary uses less.',
			'',
			'  ❯ 1. Resume from summary (instant, recommended)',
			'    2. Resume full session as-is',
			'    3. Don\'t ask again',
			'',
			'  Enter to confirm · Esc to cancel',
		].join('\n');
		assert.deepStrictEqual(
			[rebound, idle, sessionAge332].map(screen => [paradisClaudeResumeScreenPrompt(screen), paradisScreenShowsAgentPrompt(screen, 'claude')]),
			[['resume', true], ['resume', true], ['session-age', true]],
		);
	});

	// 2.1.309 の実画面（`--resume` で 5 時間使っていない会話を開いた直後。旗 tengu_gleaming_fair のとき）
	const sessionAge = [
		'❯ Say hi in one word.',
		'',
		'● Hi.',
		'',
		RULE,
		'  This session is 4h 59m old and 300k tokens.',
		'',
		'  Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a',
		'  summary.',
		'',
		'  ❯ 1. Resume from summary (recommended)',
		'    2. Resume full session as-is',
		'    3. Don\'t ask me again',
		'',
		'  Enter to confirm · Esc to cancel',
	].join('\n');
	// 2.1.309 のバイナリの文字列から組んだ形（実画面は出せていない）
	const newerModel = [
		RULE,
		'  You\u2019re resuming an Opus 5 session. Continue with Opus 5.5?',
		'',
		'  ❯ 1. Keep Opus 5',
		'    2. Continue with Opus 5.5',
		'',
		'  Enter to confirm · Esc to cancel',
	].join('\n');
	// 同じ汎用の操作説明の、ほかの確認（全画面表示のお誘い）。会話の本文に古いセッションの確認の文言が残っていても当たらない
	const otherDialog = [
		'● Earlier the screen said: This session is 4h 59m old and 300k tokens.',
		'',
		RULE,
		'  Try the new fullscreen renderer?',
		'  ❯ 1. Yes, try it',
		'    2. Not now',
		'  Enter to confirm · Esc to cancel',
	].join('\n');

	test('tells the three prompts shown right after reopening a conversation apart, and not other dialogs with the same footer', () => {
		assert.deepStrictEqual({
			kinds: [resumePrompt, narrow, sessionAge, newerModel, otherDialog, answered].map(paradisClaudeResumeScreenPrompt),
			agent: [paradisScreenShowsAgentPrompt(sessionAge, 'claude'), paradisScreenShowsAgentPrompt(sessionAge, 'codex'), paradisScreenShowsAgentPrompt(newerModel, 'claude'), paradisScreenShowsAgentPrompt(otherDialog, 'claude')],
		}, {
			kinds: ['resume', 'resume', 'session-age', 'newer-model', undefined, undefined],
			agent: [true, false, true, false],
		});
	});

	test('still finds the prompts when keybindings.json renames the keys in the footer (Claude Code 2.1.332)', () => {
		const rebound = (screen: string) => screen.replace('Enter to confirm \u00b7 Esc to cancel', 'ctrl+y to confirm \u00b7 ctrl+g to cancel');
		// 2.1.332 の実画面（`Select` の `enter` を外し、`ctrl+y` に `select:accept` を割り当てたときの質問）
		const question = [
			RULE,
			'\u2190  \u2610 Fruit  \u2610 Color  \u2714 Submit  \u2192',
			'',
			'Which fruit do you want?',
			'',
			'\u276f 1. Apple',
			'     desc Apple',
			'  2. Banana',
			'     desc Banana',
			'  3. Type something.',
			RULE,
			'  4. Chat about this',
			'',
			'ctrl+y to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel',
		].join('\n');
		assert.deepStrictEqual({
			kinds: [sessionAge, newerModel, otherDialog].map(screen => paradisClaudeResumeScreenPrompt(rebound(screen))),
			question: [paradisScreenShowsQuestionPrompt(question), paradisScreenShowsAgentPrompt(question, 'claude'), paradisScreenShowsQuestionPrompt(answered)],
		}, {
			kinds: ['session-age', 'newer-model', undefined],
			question: [true, true, false],
		});
	});
});

suite('Claude Code sub-agent plan approval on screen (Claude Code 2.1.326)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const RULE = '  ' + '\u2500'.repeat(60);
	// 2.1.326 の実画面（計画が空の子エージェントが ExitPlanMode を呼んだとき。120 桁のペイン）
	const emptyPlan = [
		'● planner(hello.txt作成の計画)',
		'  \u23bf  Backgrounded agent (\u2193 to manage \u00b7 ctrl+o to expand)',
		'',
		RULE,
		'   Exit plan mode? \u00b7 from the planner agent',
		'',
		'    Claude wants to exit plan mode',
		'',
		'    \u276f Yes, and switch to default (ask each time) for this session',
		'      No',
	].join('\n');
	// 同じ画面で、貼り付けた文と Enter を捨てた後（注意の行が出る。2.1.326 の実画面）
	const afterText = `${emptyPlan}\n    Not answered yet \u00b7 \u2191/\u2193 to choose \u00b7 Esc to decline`;
	// 計画のある子エージェント（2.1.326 のバイナリの文字列から組み立てた形。見出しは狭いペインで折り返す）
	const withPlan = [
		RULE,
		'   Ready to code? \u00b7 from the planner agent',
		'   Here is Claude\'s plan:',
		'   Create hello.txt containing hi',
		'   Claude has written up a plan and is ready to execute. Would you',
		'   like to proceed?',
		'    \u276f Yes, and switch to default (ask each time) for this session',
		'      No',
	].join('\n');
	// 2.1.332 の実画面（計画が空の子エージェント。上端に入力欄との境の線が付く。文と Enter を捨てた後の注意の行まで 2.1.326 と同じ）
	const emptyPlan332 = [
		'⏺ planner(plan hello)',
		'  \u23bf  Backgrounded agent (\u2193 to manage \u00b7 ctrl+o to expand)',
		'',
		'⏺ MOCKDONE after tool',
		'',
		'✻ Waiting for 1 background agent to finish',
		'',
		'\u2594'.repeat(120),
		'  ' + '\u2500'.repeat(116),
		'   Exit plan mode? \u00b7 from the planner agent',
		'',
		'   Claude wants to exit plan mode',
		'',
		'   \u276f Yes, and switch to default (ask each time) for this session',
		'     No',
		'   Not answered yet \u00b7 \u2191/\u2193 to choose \u00b7 Esc to decline',
	].join('\n');
	// 承認が保留された計画（20 万字を超える・表示できない文字を含む）: `Yes` の行が出ない（2.1.332 のバイナリの文字列から組み立てた形）
	const withheldPlan = [
		RULE,
		'   Ready to code? \u00b7 from the planner agent',
		'   Here is Claude\'s plan:',
		'   (the plan is too large to be shown in full, so it can only be declined)',
		RULE,
		'   Claude has written up a plan and is ready to execute. Would you like to proceed?',
		'',
		'   \u276f No',
	].join('\n');
	// 本会話の計画の確定（番号付き。従来の許可の確認として見つかる）
	const mainPlan = [
		RULE,
		'   Exit plan mode?',
		'    Claude wants to exit plan mode',
		'    \u276f 1. Yes, and switch to default (ask each time) for this session',
		'      2. No, keep planning',
	].join('\n');
	// 承認が済んで入力欄に戻った後（会話の本文に同じ文が残っている）
	const answered = `${emptyPlan}\n${RULE}\n\u276f \n${RULE}`;
	// 2.1.332 の実画面（計画ファイルのある本会話の計画の確定。auto mode が使える環境では 1 番が auto mode になる）
	const mainPlan332 = [
		'  ' + '\u2500'.repeat(116),
		'   Ready to code?',
		'',
		'   Here is Claude\'s plan:',
		'  ' + '\u254c'.repeat(116),
		'   Plan',
		'',
		'   1. Do the first thing',
		'   2. Do the second thing',
		'  ' + '\u254c'.repeat(116),
		'  ' + '\u2500'.repeat(116),
		'   Claude has written up a plan and is ready to execute. Would you like to proceed?',
		'',
		'   \u276f 1. Yes, and use auto mode',
		'     2. Yes, manually approve edits',
		'     3. Tell Claude what to change',
		'        shift+tab to approve with this feedback',
		'',
		'   ctrl+g to edit in Vim \u00b7 ~/.claude/plans/plan-zzplanfile-smooth-snail.md',
	].join('\n');
	// 同じ確定で、承認が保留された計画（2.1.332 の実画面）: 選択肢は自由入力の 1 行だけで、`1` は確定にならない
	const mainPlanWithheld332 = [
		'   (the plan is too large to be shown in full \u2014 approval is withheld; send feedback asking for a shorter plan, or',
		'   press Esc)',
		'  ' + '\u254c'.repeat(116),
		'  ' + '\u2500'.repeat(116),
		'   Claude has written up a plan and is ready to execute. Would you like to proceed?',
		'',
		'   \u276f 1. Tell Claude what to change',
		'',
		'   ctrl+g to edit in Vim \u00b7 ~/.claude/plans/plan-zzplanwh-valiant-abelson.md',
	].join('\n');

	test('finds the yes/no-only plan approval, also when the heading wraps, and refuses chat sends while it is shown', () => {
		assert.deepStrictEqual({
			yesNo: [emptyPlan, afterText, withPlan, mainPlan, answered].map(paradisScreenShowsClaudeYesNoPlanPrompt),
			permission: [emptyPlan, withPlan].map(paradisScreenShowsPermissionPrompt),
			agent: [paradisScreenShowsAgentPrompt(emptyPlan, 'claude'), paradisScreenShowsAgentPrompt(withPlan), paradisScreenShowsAgentPrompt(emptyPlan, 'codex'), paradisScreenShowsAgentPrompt(answered, 'claude')],
		}, {
			yesNo: [true, true, true, false, false],
			permission: [false, false],
			agent: [true, true, false, false],
		});
	});

	test('Claude Code 2.1.332: the same sub-agent approval, a withheld plan with only "No", and the numbered plan approval of the main session', () => {
		assert.deepStrictEqual({
			yesNo: [emptyPlan332, withheldPlan, mainPlan332, mainPlanWithheld332, `${withheldPlan}\n${RULE}\n\u276f \n${RULE}`].map(paradisScreenShowsClaudeYesNoPlanPrompt),
			agent: [emptyPlan332, withheldPlan, mainPlan332, mainPlanWithheld332].map(screen => paradisScreenShowsAgentPrompt(screen, 'claude')),
			permission: [mainPlan332, mainPlanWithheld332].map(paradisScreenShowsPermissionPrompt),
			options: paradisParseApprovalOptions(paradisPermissionPromptParts(mainPlan332)?.options ?? '')?.map(option => `${option.n}. ${option.label}`),
		}, {
			yesNo: [true, true, false, false, false],
			agent: [true, true, true, true],
			permission: [true, true],
			options: ['1. Yes, and use auto mode', '2. Yes, manually approve edits', '3. Tell Claude what to change shift+tab to approve with this feedback'],
		});
	});
});

