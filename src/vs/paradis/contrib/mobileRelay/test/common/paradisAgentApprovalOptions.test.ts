/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisApprovalOptionKey, paradisApprovalOptionLabelsMatch, paradisApprovalOptionShownAs, paradisApprovalOptionsForMobile, paradisApprovalScreenPiece, paradisApprovalSuggestionLabels, paradisMobileApprovalOptionKey, paradisParseApprovalOptionChoice, paradisParseApprovalOptions, paradisReadExpectedApprovalOption, paradisSplitCodexFormOption } from '../../common/paradisAgentApprovalOptions.js';

suite('paradisAgentApprovalOptions (W2-21)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 【推測】Claude Code 2.1 系の許可の画面の形（選択肢の行の並びと、下の操作説明）。
	const claudeScreen = [
		'● Bash(git push origin main)',
		'  ⎿  Running…',
		'',
		' Bash command',
		'',
		'   git push origin main',
		'   Push to the remote',
		'',
		' Do you want to proceed?',
		' ❯ 1. Yes',
		`   2. Yes, and don't ask again for git push commands in`,
		'      /Users/example/projects/demo',
		'   3. No, and tell Claude what to do differently (esc)',
		'',
		' Esc to cancel · Tab to amend',
		'',
	].join('\n');

	// codex-cli 0.155.1 の実画面（フェーズ6の実機確認）。選択肢と操作説明の間に空行が無い。
	const codexScreen = [
		'Would you like to run the following command?',
		'$ touch p6-codex-made.txt',
		'› 1. Yes, proceed (y)',
		`  2. Yes, and don't ask again for commands that start with 'touch p6-codex-made.txt' (p)`,
		'  3. No, and tell Codex what to do differently (esc)',
		'Press enter to confirm or esc to cancel',
	].join('\n');

	test('reads the numbered options at the bottom, joining wrapped labels and ignoring the footer', () => {
		assert.deepStrictEqual(paradisParseApprovalOptions(claudeScreen), [
			{ n: 1, label: 'Yes' },
			{ n: 2, label: `Yes, and don't ask again for git push commands in /Users/example/projects/demo` },
			{ n: 3, label: 'No, and tell Claude what to do differently (esc)', shortcut: 'esc' },
		]);
		assert.deepStrictEqual(paradisParseApprovalOptions(codexScreen), [
			{ n: 1, label: 'Yes, proceed (y)', shortcut: 'y' },
			{ n: 2, label: `Yes, and don't ask again for commands that start with 'touch p6-codex-made.txt' (p)`, shortcut: 'p' },
			{ n: 3, label: 'No, and tell Codex what to do differently (esc)', shortcut: 'esc' },
		]);
	});

	test('reads options drawn inside a box and prefers the last run over a numbered list in the conversation', () => {
		const screen = [
			'Plan:',
			'1. Build the app',
			'2. Run the tests',
			'╭──────────────────────────────╮',
			'│ Do you want to proceed?      │',
			'│ ❯ 1. Yes                     │',
			'│   2. No                      │',
			'╰──────────────────────────────╯',
		].join('\n');
		assert.deepStrictEqual(paradisParseApprovalOptions(screen), [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }]);
	});

	test('joins a label that the terminal wrapped to column 0 when a later option follows', () => {
		const screen = [
			' Do you want to proceed?',
			' ❯ 1. Yes',
			`   2. Yes, and don't ask again for git push commands in /Users/example/projects/a-very-long-`,
			'directory-name',
			'   3. No, and tell Claude what to do differently (esc)',
		].join('\n');
		assert.deepStrictEqual(paradisParseApprovalOptions(screen)?.map(option => option.label), [
			'Yes',
			`Yes, and don't ask again for git push commands in /Users/example/projects/a-very-long- directory-name`,
			'No, and tell Claude what to do differently (esc)',
		]);
	});

	test('returns undefined when fewer than two options, a broken sequence or ten or more options are on screen', () => {
		const ten = Array.from({ length: 10 }, (_, index) => `  ${index + 1}. Option ${index + 1}`).join('\n');
		assert.deepStrictEqual({
			single: paradisParseApprovalOptions(' ❯ 1. Yes\n'),
			broken: paradisParseApprovalOptions(' ❯ 1. Yes\n   3. No\n'),
			// 10 番目がある並びは数字 1 文字で選べないので、並びごと扱わない
			ten: paradisParseApprovalOptions(ten),
			empty: paradisParseApprovalOptions(''),
		}, { single: undefined, broken: undefined, ten: undefined, empty: undefined });
	});

	test('matches labels regardless of where the pane width wrapped them', () => {
		assert.deepStrictEqual({
			wrapped: paradisApprovalOptionLabelsMatch(`Yes, and don't ask again for git push`, `Yes, and don't ask again for git  push`),
			rewrapped: paradisApprovalOptionLabelsMatch('Yes, allow all edits during this session', 'Yes, allow all edits during thissession'),
			different: paradisApprovalOptionLabelsMatch('Yes', 'No'),
			empty: paradisApprovalOptionLabelsMatch('', ''),
		}, { wrapped: true, rewrapped: true, different: false, empty: false });
	});

	test('parses opt:<n> answers and the expected option carried by the relay', () => {
		assert.deepStrictEqual({
			two: paradisParseApprovalOptionChoice('opt:2'),
			zero: paradisParseApprovalOptionChoice('opt:0'),
			ten: paradisParseApprovalOptionChoice('opt:10'),
			yes: paradisParseApprovalOptionChoice('yes'),
			expected: paradisReadExpectedApprovalOption({ n: 2, label: 'Yes' }),
			badNumber: paradisReadExpectedApprovalOption({ n: 12, label: 'Yes' }),
			noLabel: paradisReadExpectedApprovalOption({ n: 2 }),
		}, { two: 2, zero: undefined, ten: undefined, yes: undefined, expected: { n: 2, label: 'Yes' }, badNumber: undefined, noLabel: undefined });
	});

	test('sends the digit for Claude, the shortcut for Codex, and hides Codex options that cannot be sent', () => {
		const codex = paradisParseApprovalOptions(codexScreen)!;
		const codexWithoutShortcut = paradisParseApprovalOptions('› 1. Yes, proceed (y)\n  2. Maybe later\n');
		assert.deepStrictEqual({
			claude: paradisApprovalOptionKey('claude', { n: 3, label: 'No' }),
			codexAllow: paradisApprovalOptionKey('codex', codex[1]),
			codexDeny: paradisApprovalOptionKey('codex', codex[2]),
			codexNoShortcut: paradisApprovalOptionKey('codex', { n: 2, label: 'Maybe later' }),
			forMobileClaude: paradisApprovalOptionsForMobile('claude', paradisParseApprovalOptions(claudeScreen))?.map(option => option.n),
			forMobileCodex: paradisApprovalOptionsForMobile('codex', codex)?.[0],
			forMobileCodexHidden: paradisApprovalOptionsForMobile('codex', codexWithoutShortcut),
		}, {
			claude: '3',
			codexAllow: 'p',
			codexDeny: '\u001b',
			codexNoShortcut: undefined,
			forMobileClaude: [1, 2, 3],
			// モバイルへは番号と文言だけ（近道は送らない）
			forMobileCodex: { n: 1, label: 'Yes, proceed (y)' },
			forMobileCodexHidden: undefined,
		});
	});

	// Codex の MCP のツールの許可のフォームは、画面で名前と説明が別の列に並ぶ。ボードとモバイルには名前を出す（古いアプリも名前をそのまま出す）
	test('shows only the names of a Codex tool approval form, and still matches the screen when the phone answers with the name', () => {
		const form = [
			'  Field 1/1',
			'  Allow the para-browser MCP server to run tool "click"?',
			'  › 1. Allow                   Run the tool and continue',
			'    2. Allow for this session  Run the tool and remember this choice for this',
			'                               session',
			'    3. Always allow            Run the tool and remember this choice for',
			'                               future tool calls',
			'    4. Cancel                  Cancel this tool call',
			'  enter to submit | esc to cancel',
		].join('\n');
		const options = paradisParseApprovalOptions(form)!;
		assert.deepStrictEqual({
			split: [...options.map(option => paradisSplitCodexFormOption(option.label)), paradisSplitCodexFormOption('Yes, proceed (y)')],
			forMobile: paradisApprovalOptionsForMobile('codex', options, true)?.map(option => option.label),
			twoOnly: paradisApprovalOptionsForMobile('codex', [options[0], { n: 2, label: 'Cancel Cancel this tool call' }], true),
			// 名前で答えたものは、フォームのときだけ名前で照らす。「Allow」が「Allow for this session」に当たらない
			shownAs: [
				paradisApprovalOptionShownAs(options[1].label, 'Allow for this session', true),
				paradisApprovalOptionShownAs(options[1].label, 'Allow', true),
				paradisApprovalOptionShownAs(options[1].label, 'Allow for this session', false),
				paradisApprovalOptionShownAs(options[1].label, options[1].label, false),
			],
		}, {
			split: [
				{ label: 'Allow', detail: 'Run the tool and continue' },
				{ label: 'Allow for this session', detail: 'Run the tool and remember this choice for this session' },
				{ label: 'Always allow', detail: 'Run the tool and remember this choice for future tool calls' },
				{ label: 'Cancel', detail: 'Cancel this tool call' },
				{ label: 'Yes, proceed (y)' },
			],
			// 最後の「Cancel」はアプリの「拒否」（Esc）と同じなので渡さない
			forMobile: ['Allow', 'Allow for this session', 'Always allow'],
			// 許可と取り消しだけのフォームは、選択肢を渡さない（アプリは「許可 / 拒否」のまま）
			twoOnly: undefined,
			shownAs: [true, false, false, true],
		});
	});

	// 名前はどのツールのフォームでも同じ。スマホで X の「常に許可」を押したとき、画面が Y のフォームなら送らない
	test('sends a numbered option of a Codex tool approval form only when the form on screen is for the card\'s tool', () => {
		const form = (tool: string) => [
			`• Calling para-browser.${tool}`,
			'  Field 1/1',
			`  Allow the para-browser MCP server to run tool "${tool}"?`,
			'  › 1. Allow                   Run the tool and continue',
			'    2. Allow for this session  Run the tool and remember this choice for this session',
			'    3. Always allow            Run the tool and remember this choice for future tool calls',
			'    4. Cancel                  Cancel this tool call',
			'  enter to submit | esc to cancel',
		].join('\n');
		const optionsOf = (screen: string) => screen.split('\n').slice(3).join('\n');
		const piece = paradisApprovalScreenPiece('mcp__para-browser__click: {"uid":"1"}', 'codex');
		const always = { n: 3, label: 'Always allow' };
		assert.deepStrictEqual({
			own: paradisMobileApprovalOptionKey('codex', form('click'), optionsOf(form('click')), always, piece),
			otherTool: paradisMobileApprovalOptionKey('codex', form('click_by'), optionsOf(form('click_by')), always, piece),
			noPiece: paradisMobileApprovalOptionKey('codex', form('click'), optionsOf(form('click')), always, undefined),
			changedLabel: paradisMobileApprovalOptionKey('codex', form('click'), optionsOf(form('click')), { n: 3, label: 'Allow for this session' }, piece),
			// コマンドの許可（フォームではない）は今までどおり、行末の近道を文言で確かめて送る
			exec: paradisMobileApprovalOptionKey('codex', codexScreen, codexScreen, { n: 2, label: `Yes, and don't ask again for commands that start with 'touch p6-codex-made.txt' (p)` }, undefined),
		}, {
			own: '3',
			otherTool: undefined,
			noPiece: undefined,
			changedLabel: undefined,
			exec: 'p',
		});
	});

	test('shortens permission_suggestions for display and ignores unknown shapes', () => {
		assert.deepStrictEqual({
			rules: paradisApprovalSuggestionLabels([
				{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'WebFetch' }], behavior: 'allow', destination: 'localSettings' },
				{ type: 'setMode', mode: 'acceptEdits', destination: 'session' },
				{ type: 'addDirectories', directories: ['/Users/example/projects/demo'] },
				{ type: 'unknown' },
				'garbage',
			]),
			none: paradisApprovalSuggestionLabels(undefined),
			empty: paradisApprovalSuggestionLabels([]),
		}, {
			rules: ['Bash(npm test:*)', 'WebFetch', 'mode: acceptEdits', '/Users/example/projects/demo'],
			none: undefined,
			empty: undefined,
		});
	});
});
