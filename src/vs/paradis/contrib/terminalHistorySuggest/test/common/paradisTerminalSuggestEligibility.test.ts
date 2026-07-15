/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PromptInputState } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { paradisIsTerminalPromptSuggestEligible } from '../../common/paradisTerminalSuggestEligibility.js';

suite('ParadisTerminalSuggestEligibility', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rejects a non-empty prompt snapshot after command execution starts', () => {
		assert.strictEqual(paradisIsTerminalPromptSuggestEligible({
			state: PromptInputState.Execute,
			value: 'codex',
			ghostTextIndex: -1,
		}, undefined), false);
	});

	test('rejects prompt suggestions while a foreground command is executing', () => {
		assert.strictEqual(paradisIsTerminalPromptSuggestEligible({
			state: PromptInputState.Input,
			value: 'codex',
			ghostTextIndex: -1,
		}, 'codex'), false);
	});

	test('accepts only real non-empty input at an active shell prompt', () => {
		assert.strictEqual(paradisIsTerminalPromptSuggestEligible({
			state: PromptInputState.Input,
			value: 'git status',
			ghostTextIndex: -1,
		}, undefined), true);
		assert.strictEqual(paradisIsTerminalPromptSuggestEligible({
			state: PromptInputState.Input,
			value: 'git status',
			ghostTextIndex: 0,
		}, undefined), false, 'ghost text alone must not enable the DownArrow binding');
		assert.strictEqual(paradisIsTerminalPromptSuggestEligible({
			state: PromptInputState.Input,
			value: 'git status',
			ghostTextIndex: 3,
		}, undefined), true, 'real input before ghost text remains eligible');
		assert.strictEqual(paradisIsTerminalPromptSuggestEligible({
			state: PromptInputState.Unknown,
			value: 'git status',
			ghostTextIndex: -1,
		}, undefined), false);
	});
});
