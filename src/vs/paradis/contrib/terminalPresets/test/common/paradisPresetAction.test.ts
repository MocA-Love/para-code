/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	isValidPresetDefinition,
	paradisAgentPromptAvailability,
	paradisBuildPresetInsertText,
	paradisGetPresetTasks,
	paradisPresetAction,
	paradisPresetCommandSignature,
	paradisPresetFingerprint,
} from '../../common/paradisTerminalPresets.js';

suite('ParadisPresetAction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts agent prompts without commands and rejects unknown actions', () => {
		assert.deepStrictEqual({
			agentPrompt: isValidPresetDefinition({ name: 'Review', action: 'agent-prompt', prompt: 'review this' }),
			emptyPrompt: isValidPresetDefinition({ name: 'Review', action: 'agent-prompt', prompt: '  ' }),
			insert: isValidPresetDefinition({ name: 'Log', action: 'insert', commands: ['git log'] }),
			// 新しい版の種別を古い解釈（Enter 付きで実行）へ倒さない
			unknown: isValidPresetDefinition({ name: 'X', action: 'launch-agent', commands: ['rm -rf ~'] }),
			legacy: isValidPresetDefinition({ name: 'Build', commands: ['npm run build'] }),
		}, { agentPrompt: true, emptyPrompt: false, insert: true, unknown: false, legacy: true });
	});

	test('agent prompts never become shell tasks', () => {
		const definition = { name: 'Review', action: 'agent-prompt' as const, prompt: 'review this\n', commands: ['echo should-not-run'] };
		assert.deepStrictEqual({
			action: paradisPresetAction(definition),
			tasks: paradisGetPresetTasks(definition).tasks,
			signature: paradisPresetCommandSignature(definition),
		}, { action: 'agent-prompt', tasks: [], signature: 'review this' });
	});

	test('keeps the fingerprint of run presets unchanged', () => {
		// 指紋は「このマシンだけ隠したプリセット」の保存キーにも使うので、従来の定義で変えない
		const legacy = { name: 'Build', commands: ['npm run build'] };
		assert.strictEqual(paradisPresetFingerprint(legacy), paradisPresetFingerprint({ ...legacy, action: 'run' }));
		assert.notStrictEqual(paradisPresetFingerprint(legacy), paradisPresetFingerprint({ ...legacy, action: 'insert' }));
	});

	test('builds insert text that cannot submit on its own', () => {
		assert.deepStrictEqual({
			pasted: paradisBuildPresetInsertText('line 1\r\nline 2\n\n', true),
			flattened: paradisBuildPresetInsertText('line 1\n\tline 2\n', false),
			escapeStripped: paradisBuildPresetInsertText('a\x1b[201~b\x07', true),
			empty: paradisBuildPresetInsertText(' \n\t', true),
		}, {
			pasted: 'line 1\nline 2',
			flattened: 'line 1 line 2',
			escapeStripped: 'a[201~b',
			empty: undefined,
		});
	});

	test('only inserts into an agent that is not waiting for an answer', () => {
		assert.deepStrictEqual([
			paradisAgentPromptAvailability(false, false, undefined),
			paradisAgentPromptAvailability(true, false, undefined),
			paradisAgentPromptAvailability(true, true, 'question'),
			paradisAgentPromptAvailability(true, true, 'permission'),
			paradisAgentPromptAvailability(true, true, 'working'),
			paradisAgentPromptAvailability(true, true, undefined),
		], ['noTerminal', 'notAgent', 'awaitingAnswer', 'awaitingAnswer', 'ready', 'ready']);
	});
});
