/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAddClaudePluginDir, paradisClaudeDraftState, paradisClaudeManagedSettingsBlockMods, paradisClaudeModApprovalWaitMs, paradisClaudeModShipsFile, paradisSupportsClaudeDraftMod } from '../../common/paradisClaudeMod.js';

suite('ParadisClaudeMod (common)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('appends the mod folder after what the user already set, or after the inherited value', () => {
		assert.deepStrictEqual({
			inherited: paradisAddClaudePluginDir({ PATH: '/bin' }, '/home/a/.para-code/claude-mod/abc', ':'),
			explicit: paradisAddClaudePluginDir({ CLAUDE_CODE_PLUGIN_DIRS: '/home/a/my-mod' }, '/home/a/.para-code/claude-mod/abc', ':'),
			already: paradisAddClaudePluginDir({ CLAUDE_CODE_PLUGIN_DIRS: '/x:/home/a/.para-code/claude-mod/abc' }, '/home/a/.para-code/claude-mod/abc', ':'),
			none: paradisAddClaudePluginDir(undefined, '/m', ':'),
		}, {
			inherited: { PATH: '/bin', CLAUDE_CODE_PLUGIN_DIRS: '${env:CLAUDE_CODE_PLUGIN_DIRS}:/home/a/.para-code/claude-mod/abc' },
			explicit: { CLAUDE_CODE_PLUGIN_DIRS: '/home/a/my-mod:/home/a/.para-code/claude-mod/abc' },
			already: { CLAUDE_CODE_PLUGIN_DIRS: '/x:/home/a/.para-code/claude-mod/abc' },
			none: { CLAUDE_CODE_PLUGIN_DIRS: '${env:CLAUDE_CODE_PLUGIN_DIRS}:/m' },
		});
	});

	test('ships the manifest and hooks of the mod and of the prompt box mod in draft/, nothing else', () => {
		const paths = ['.claude-plugin/plugin.json', 'hooks/register.ts', 'hooks/hooks.json', 'draft/.claude-plugin/plugin.json', 'draft/hooks/draft.ts', 'draft/hooks/hooks.json',
			'tests/para-code.test.ts', 'draft/tests/x.ts', 'tsconfig.json', 'draft/tsconfig.json', 'hooks/../tsconfig.json', 'draft/types/index.d.ts'];
		assert.deepStrictEqual(paths.filter(paradisClaudeModShipsFile), ['.claude-plugin/plugin.json', 'hooks/register.ts', 'hooks/hooks.json', 'draft/.claude-plugin/plugin.json', 'draft/hooks/draft.ts', 'draft/hooks/hooks.json']);
	});

	test('loads the prompt box mod only on Claude Code 2.1.300 and later, and reads the box state', () => {
		assert.deepStrictEqual({
			versions: ['2.1.299 (Claude Code)', '2.1.300 (Claude Code)', '2.2.0', '3.0.0', 'garbage', undefined].map(paradisSupportsClaudeDraftMod),
			states: [undefined, { text: '', truncated: false }, { text: 'abc', truncated: false }, { text: 'abc', truncated: true }].map(paradisClaudeDraftState),
		}, {
			versions: [false, true, true, true, false, false],
			states: ['unknown', 'empty', 'text', 'cut'],
		});
	});

	test('reads the approval wait in minutes, clamped to 0..60, 10 by default', () => {
		assert.deepStrictEqual([undefined, 'x', 0, 2.5, 600, -3].map(paradisClaudeModApprovalWaitMs), [600_000, 600_000, 0, 150_000, 3_600_000, 0]);
	});

	test('treats disableSideloadFlags in managed settings as forbidding the mod (and errs on the safe side)', () => {
		assert.deepStrictEqual({
			absent: paradisClaudeManagedSettingsBlockMods('{"permissions":{}}', 'json'),
			on: paradisClaudeManagedSettingsBlockMods('{"disableSideloadFlags":true}', 'json'),
			off: paradisClaudeManagedSettingsBlockMods('{"disableSideloadFlags":false}', 'json'),
			broken: paradisClaudeManagedSettingsBlockMods('{"disableSideloadFlags":tru', 'json'),
			plist: paradisClaudeManagedSettingsBlockMods('bplist00\u0000disableSideloadFlags\u0009', 'plist'),
			plistWithout: paradisClaudeManagedSettingsBlockMods('bplist00\u0000allowManagedHooksOnly', 'plist'),
		}, { absent: false, on: true, off: false, broken: true, plist: true, plistWithout: false });
	});
});
