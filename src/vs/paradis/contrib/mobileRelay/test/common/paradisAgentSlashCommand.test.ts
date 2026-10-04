/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test fixtures)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCodexComposerHoldsCommand, paradisParseSlashCommand, paradisReadSlashCheck, paradisSlashCommandRejected, paradisSlashRejectionMessage } from '../../common/paradisAgentSlashCommand.js';

suite('ParadisAgentSlashCommand', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the command at the start of the text and leaves paths and prose alone', () => {
		assert.deepStrictEqual([
			'/context',
			'  /review 123 please',
			'/mcp__docs__summarize a\nb',
			'/Users/example/file.ts を見て',
			'/',
			'hello /context',
		].map(paradisParseSlashCommand), [
			{ name: 'context', args: '' },
			{ name: 'review', args: '123 please' },
			{ name: 'mcp__docs__summarize', args: 'a\nb' },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('counts only a refusal that appeared after sending (Claude Code 2.1.289 and Codex 0.160.0 wording)', () => {
		const claudeLine = '⏺ Unknown command: /nonexistentxyz';
		const codexLine = '• Unrecognized command \'/nonexistentxyz\'. Type "/" for a list of supported commands.';
		assert.deepStrictEqual({
			claudeNew: paradisSlashCommandRejected('claude', 'nonexistentxyz', '', `${claudeLine}\n❯ `),
			claudeOld: paradisSlashCommandRejected('claude', 'nonexistentxyz', claudeLine, `${claudeLine}\n❯ `),
			claudeAgain: paradisSlashCommandRejected('claude', 'nonexistentxyz', claudeLine, `${claudeLine}\n${claudeLine}`),
			longerName: paradisSlashCommandRejected('claude', 'nonexistent', '', claudeLine),
			codex: paradisSlashCommandRejected('codex', 'nonexistentxyz', '', codexLine),
			wrongAgent: paradisSlashCommandRejected('claude', 'nonexistentxyz', '', codexLine),
		}, { claudeNew: true, claudeOld: false, claudeAgain: true, longerName: false, codex: true, wrongAgent: false });
	});

	test('sees whether the Codex composer still holds the refused text, only when the name ends there', () => {
		const screen = (composer: string) => `• Unrecognized command '/x'.\n\u203A ${composer}\n  gpt-6 medium · Context 0% used`;
		assert.deepStrictEqual([
			paradisCodexComposerHoldsCommand(screen('/x foo bar'), 'x'),
			paradisCodexComposerHoldsCommand(screen('/x'), 'x'),
			paradisCodexComposerHoldsCommand(screen('/xyz foo'), 'x'),
			paradisCodexComposerHoldsCommand(screen('/x:y'), 'x'),
			paradisCodexComposerHoldsCommand(screen('Ask Codex to do anything'), 'x'),
			paradisCodexComposerHoldsCommand('no composer here', 'x'),
		], [true, true, false, false, false, false]);
	});

	test('sees the refused text in a Codex composer that a narrow pane wrapped', () => {
		assert.deepStrictEqual([
			paradisCodexComposerHoldsCommand('\u203A /a-rather-long-\n  command-name foo\n  fake-model default', 'a-rather-long-command-name'),
			paradisCodexComposerHoldsCommand('\u203A /a-rather-long-command-name\n  foo\n  fake-model default', 'a-rather-long-command-name'),
			paradisCodexComposerHoldsCommand('\u203A /a-rather-long-\n  command-names\n  fake-model default', 'a-rather-long-command-name'),
		], [true, true, false]);
	});

	test('finds a refusal that a narrow pane wrapped onto several lines', () => {
		const wrapped = '• Unrecognized command \'/a-rather-long-\n  command-name\'. Type "/" for a\n  list of supported commands.';
		const wrappedAtSpace = '• Unrecognized\n  command \'/x\'.';
		assert.deepStrictEqual([
			paradisSlashCommandRejected('codex', 'a-rather-long-command-name', '', wrapped),
			paradisSlashCommandRejected('codex', 'a-rather-long-command-name', wrapped, wrapped),
			paradisSlashCommandRejected('codex', 'x', '', wrappedAtSpace),
		], [true, false, true]);
	});
	test('reads the check the shared process attaches, and words the refusal', () => {
		assert.deepStrictEqual({
			checks: [{ agent: 'codex', command: 'x' }, { agent: 'other', command: 'x' }, { agent: 'claude', command: 'a b' }, undefined].map(paradisReadSlashCheck),
			messages: [paradisSlashRejectionMessage('codex', 'x'), paradisSlashRejectionMessage('claude', 'x', 'no command named /x in this session')],
		}, {
			checks: [{ agent: 'codex', command: 'x' }, undefined, undefined, undefined],
			messages: ['Codex に /x というコマンドはありません', 'Claude Code が /x を実行しませんでした（no command named /x in this session）'],
		});
	});
});
