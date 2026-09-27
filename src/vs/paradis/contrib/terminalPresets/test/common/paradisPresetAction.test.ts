/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GeneralShellType, PosixShellType } from '../../../../../platform/terminal/common/terminal.js';
import { ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import {
	isValidPresetDefinition,
	paradisBuildInsertCommandsText,
	paradisAgentPromptAvailability,
	paradisBuildPresetInsertText,
	paradisThrowIfAgentAwaitingAnswer,
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
			insert: isValidPresetDefinition({ name: 'Log', action: 'insert', prompt: 'git log' }),
			// 挿入の本文を commands に置いた定義は無効（古い版が Enter 付きで実行する形を作らない）
			insertWithCommands: isValidPresetDefinition({ name: 'Log', action: 'insert', commands: ['git log'] }),
			// 新しい版の種別を古い解釈（Enter 付きで実行）へ倒さない
			unknown: isValidPresetDefinition({ name: 'X', action: 'launch-agent', commands: ['rm -rf ~'] }),
			legacy: isValidPresetDefinition({ name: 'Build', commands: ['npm run build'] }),
		}, { agentPrompt: true, emptyPrompt: false, insert: true, insertWithCommands: false, unknown: false, legacy: true });
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
		assert.notStrictEqual(paradisPresetFingerprint(legacy), paradisPresetFingerprint({ ...legacy, action: 'insert', prompt: 'npm run build' }));
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

	test('insert presets always become a single line', () => {
		assert.deepStrictEqual([
			paradisBuildInsertCommandsText('git fetch\n\n  git log --oneline\n', PosixShellType.Bash),
			paradisBuildInsertCommandsText('a\nb', GeneralShellType.PowerShell),
			paradisBuildInsertCommandsText('  \n', PosixShellType.Bash),
		], ['git fetch && git log --oneline', 'a; if ($?) { b }', undefined]);
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

	test('stops right before sending only when the agent is waiting for an answer', () => {
		// 1: hook の実績あり・質問中 / 2: hook の実績なし・許可待ち（transcript 由来）/ 3: hook の実績あり・作業中 / 4: 状態なし
		const hookAgents = new Set([1, 3]);
		const statuses = new Map<number, ParadisAgentStatus>([[1, 'question'], [2, 'permission'], [3, 'working']]);
		const store = {
			isAgentInstance: (instanceId: number) => hookAgents.has(instanceId),
			getInstanceStatus: (instanceId: number) => statuses.get(instanceId),
		};
		const stops = (instanceId: number, requireAgentInstance: boolean) => {
			try {
				paradisThrowIfAgentAwaitingAnswer(store, instanceId, requireAgentInstance, 'awaiting');
				return false;
			} catch (error) {
				return (error as Error).message === 'awaiting';
			}
		};
		assert.deepStrictEqual({
			// プリセットの「挿入だけ」: hook の実績があるペインだけを見る
			insertPreset: [1, 2, 3, 4].map(instanceId => stops(instanceId, true)),
			// Design Mode: 届いた状態はすべて使う
			designMode: [1, 2, 3, 4].map(instanceId => stops(instanceId, false)),
		}, {
			insertPreset: [true, false, false, false],
			designMode: [true, true, false, false],
		});
	});
});
