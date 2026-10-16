/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisPermissionPromptHash, paradisPermissionPromptParts, paradisPromptRegionShows, paradisScreenShowsAgentPrompt, paradisScreenShowsPermissionPrompt, paradisVisibleTerminalLogicalText } from '../../browser/paradisAgentTuiInput.js';
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
