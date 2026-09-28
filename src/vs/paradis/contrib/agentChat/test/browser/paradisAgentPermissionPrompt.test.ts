/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisPermissionPromptHash, paradisPermissionPromptParts } from '../../browser/paradisAgentTuiInput.js';
import { paradisParseApprovalOptions } from '../../../mobileRelay/common/paradisAgentApprovalOptions.js';

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

	test('returns undefined when no permission prompt is on screen', () => {
		assert.strictEqual(paradisPermissionPromptParts('1. First step\n2. Second step\n'), undefined);
	});
});
