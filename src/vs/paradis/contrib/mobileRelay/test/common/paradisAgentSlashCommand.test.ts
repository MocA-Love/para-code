/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test fixtures)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IParadisAgentModelCatalog, paradisResolveAgentTemplates, paradisSwitchableAgentModels } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { PARADIS_CLAUDE_SETTING_VALUE_PATTERN, paradisClaudeModelSwitch, paradisFindListedClaudeModel, paradisCodexComposerHoldsCommand, paradisParseSlashCommand, paradisReadSlashCheck, paradisSlashCommandRejected, paradisSlashRejectionMessage } from '../../common/paradisAgentSlashCommand.js';

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

	test('sees the refused text in the Codex 0.164 composer, whose prompt marker becomes the slash', () => {
		// Measured on Codex 0.164.0-alpha.3 (2026-10-20): `› /x` is drawn as `/ x`; the command list rows have no space after the slash.
		const screen = (composer: string) => `› hello\n• Unrecognized command '/x'. Type "/" for a list of supported commands.\n${composer}\n  mock-model default · ~/project`;
		assert.deepStrictEqual([
			paradisCodexComposerHoldsCommand(screen('/ x foo bar'), 'x'),
			paradisCodexComposerHoldsCommand(screen('/ x'), 'x'),
			paradisCodexComposerHoldsCommand(screen('/ xyz foo'), 'x'),
			paradisCodexComposerHoldsCommand(screen('/'), 'x'),
			paradisCodexComposerHoldsCommand(screen('  /x         run x'), 'x'),
			paradisCodexComposerHoldsCommand('/ a-rather-long-\n  command-name foo\n  mock-model default', 'a-rather-long-command-name'),
		], [true, true, false, false, false, true]);
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

	test('switches the model with /config model=<alias> for /model <alias>, hands a pinned id to the setting action, and refuses a malformed value', () => {
		assert.deepStrictEqual({
			switched: ['/model sonnet', '  /model Opus[1M] ', '/model default'].map(paradisClaudeModelSwitch),
			setting: ['/model claude-mythos-5-1', '/model claude-opus-4-8[1m]'].map(paradisClaudeModelSwitch),
			refused: ['/model sonnet please', '/model opus;rm'].map(paradisClaudeModelSwitch),
			untouched: ['/model', '/models sonnet', 'use /model sonnet', '/effort high'].map(paradisClaudeModelSwitch),
			values: ['sonnet', 'opus[1m]', 'claude-opus-5-5', 'opus[1m] x', 'opus;rm'].map(value => PARADIS_CLAUDE_SETTING_VALUE_PATTERN.test(value)),
		}, {
			switched: [{ kind: 'switch', text: '/config model=sonnet' }, { kind: 'switch', text: '/config model=opus[1m]' }, { kind: 'switch', text: '/config model=default' }],
			setting: [{ kind: 'setting', value: 'claude-mythos-5-1' }, { kind: 'setting', value: 'claude-opus-4-8[1m]' }],
			refused: [{ kind: 'not-alias', value: 'sonnet please' }, { kind: 'not-alias', value: 'opus;rm' }],
			untouched: [undefined, undefined, undefined, undefined],
			values: [true, true, true, false, false],
		});
	});

	test('switches only to a model the PC lists (its id or the id an alias resolves to)', () => {
		const models = [{ id: 'opus', resolvedModel: 'claude-opus-5-5' }, { id: 'claude-mythos-5-1', resolvedModel: 'claude-mythos-5-1' }, { id: 'sonnet' }];
		assert.deepStrictEqual(['claude-mythos-5-1', 'Claude-Mythos-5-1', 'claude-opus-5-5', 'claude-mythos-5', 'claude-opus-4-8', ''].map(value => paradisFindListedClaudeModel(value, models)),
			['claude-mythos-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', undefined, undefined, undefined]);
	});

	test('switches to Mythos 5.1 while the CLI also lists Mythos 5.2, though a new space offers only 5.2 (Claude Code 2.1.322)', () => {
		const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
		const catalogs: IParadisAgentModelCatalog[] = [{
			agentId: 'claude', cliVersion: '2.1.322', fetchedAt: 0, models: [
				{ id: 'fable', resolvedModel: 'claude-fable-5-2', efforts },
				{ id: 'claude-mythos-5-1', resolvedModel: 'claude-mythos-5-1', efforts },
				{ id: 'claude-mythos-5-2', resolvedModel: 'claude-mythos-5-2', efforts },
			],
		}];
		const templates = paradisResolveAgentTemplates(new TestConfigurationService(), catalogs);
		const switchable = paradisSwitchableAgentModels('claude', templates, catalogs);
		assert.deepStrictEqual({
			newSpace: templates.find(agent => agent.id === 'claude')?.models?.map(model => model.id),
			switched: ['claude-mythos-5-1', 'claude-mythos-5-2', 'claude-fable-5-2', 'opusplan', 'claude-mythos-5'].map(value => paradisFindListedClaudeModel(value, switchable)),
			noCatalog: paradisFindListedClaudeModel('claude-mythos-5-1', paradisSwitchableAgentModels('claude', paradisResolveAgentTemplates(new TestConfigurationService(), []), [])),
		}, {
			newSpace: ['fable', 'claude-mythos-5-2', 'opusplan'],
			switched: ['claude-mythos-5-1', 'claude-mythos-5-2', 'claude-fable-5-2', 'opusplan', undefined],
			noCatalog: undefined,
		});
	});
});
