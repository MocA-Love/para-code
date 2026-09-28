/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisReplayedPromptShownOnScreen } from '../../browser/paradisReplayedPromptCheck.js';

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

const CODEX_QUESTION_SCREEN = [
	'Question 1/1 (1 unanswered)',
	'Which environment should I deploy to?',
	'',
	'› 1. Development (Recommended)  dev',
	'  2. Production                 prod',
	'',
	'tab to add notes | enter to submit answer | esc to interrupt',
].join('\n');

suite('paradisReplayedPromptCheck', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 流し直した承認カードは、その種類の確認が画面に今も出ているときだけ出す（W2-20）。
	test('a replayed prompt is shown only when that kind of prompt is on screen', () => {
		assert.deepStrictEqual({
			permissionOnPermission: paradisReplayedPromptShownOnScreen('permission', PERMISSION_SCREEN),
			permissionOnQuestion: paradisReplayedPromptShownOnScreen('permission', CODEX_QUESTION_SCREEN),
			questionOnQuestion: paradisReplayedPromptShownOnScreen('question', CODEX_QUESTION_SCREEN),
			answeredAlready: paradisReplayedPromptShownOnScreen('permission', '● Bash(npm test -- auth)\n  ⎿  12 passing\n\n❯ '),
			notRestoredYet: paradisReplayedPromptShownOnScreen('permission', '\n\n'),
		}, { permissionOnPermission: true, permissionOnQuestion: false, questionOnQuestion: true, answeredAlready: false, notRestoredYet: false });
	});
});
