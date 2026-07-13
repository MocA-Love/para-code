/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GeneralShellType, PosixShellType, WindowsShellType } from '../../../../../platform/terminal/common/terminal.js';
import { paradisBuildAgentCommand, paradisBuildWorktreeNames, paradisDeduplicateBranchName, paradisDeduplicateWorktreeDirName, paradisParseGhPrStatus, paradisShouldCreateDefaultTerminal } from '../../common/paradisWorktreeCreate.js';

suite('paradisWorktreeCreate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the space name only as the display name', () => {
		assert.deepStrictEqual(
			// allow-any-unicode-next-line
			paradisBuildWorktreeNames('音声入力による解析', 'feat/yakucho-ocr'),
			// allow-any-unicode-next-line
			{ displayName: '音声入力による解析', dirName: 'feat-yakucho-ocr' },
		);
	});

	test('falls back to the branch-derived directory name when the space name is empty', () => {
		assert.deepStrictEqual(
			paradisBuildWorktreeNames('  ', 'feat/yakucho-ocr'),
			{ displayName: 'feat-yakucho-ocr', dirName: 'feat-yakucho-ocr' },
		);
	});

	test('deduplicates directory names that collide after branch sanitization', () => {
		assert.strictEqual(
			paradisDeduplicateWorktreeDirName('feat-foo', ['main', 'feat/foo']),
			'feat-foo-2',
		);
		assert.strictEqual(
			paradisDeduplicateWorktreeDirName('feat-foo', ['feat/foo', 'feat/foo-2']),
			'feat-foo-3',
		);
		assert.strictEqual(
			paradisDeduplicateWorktreeDirName('custom-dir', ['main'], ['custom-dir']),
			'custom-dir-2',
		);
	});

	test('uses the deduplicated directory name as the fallback display name', () => {
		assert.deepStrictEqual(
			paradisBuildWorktreeNames('', 'feat-foo', ['feat/foo']),
			{ displayName: 'feat-foo-2', dirName: 'feat-foo-2' },
		);
	});

	test('deduplicates branch and directory names on case-insensitive file systems', () => {
		assert.deepStrictEqual({
			branch: paradisDeduplicateBranchName('feature', ['Feature'], true),
			directory: paradisDeduplicateWorktreeDirName('feature', [], ['Feature'], true),
		}, {
			branch: 'feature-2',
			directory: 'feature-2',
		});
	});

	test('creates a default terminal when no agent command will run', () => {
		assert.strictEqual(paradisShouldCreateDefaultTerminal('none', 'build this'), true);
		assert.strictEqual(paradisShouldCreateDefaultTerminal('codex', '   '), true);
	});

	test('does not create an extra default terminal when an agent command will run', () => {
		assert.strictEqual(paradisShouldCreateDefaultTerminal('codex', 'build this'), false);
	});

	test('quotes agent prompts for POSIX and PowerShell terminals', () => {
		const template = { id: 'codex', label: 'Codex', command: 'codex {prompt}' };
		assert.strictEqual(paradisBuildAgentCommand(template, 'fix it\'s broken', PosixShellType.Bash), String.raw`codex 'fix it'\''s broken'`);
		assert.strictEqual(paradisBuildAgentCommand(template, 'fix it\'s broken', GeneralShellType.PowerShell), String.raw`codex 'fix it''s broken'`);
	});

	test('encodes arbitrary cmd.exe prompts without interpolating metacharacters', () => {
		const command = paradisBuildAgentCommand(
			{ id: 'codex', label: 'Codex', command: 'codex {prompt}' },
			'fix & echo %PATH% "now"',
			WindowsShellType.CommandPrompt,
		);
		assert.match(command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
		assert.ok(!command.includes('%PATH%'));
		assert.ok(!command.includes('& echo'));
	});

	test('parses gh pr view output into a PR status', () => {
		const stdout = JSON.stringify({ number: 42, title: 'feat: mobile relay', url: 'https://github.com/o/r/pull/42', state: 'OPEN', isDraft: false, headRefName: 'feature/mobile-relay' });
		assert.deepStrictEqual(
			paradisParseGhPrStatus(stdout, 'feature/mobile-relay'),
			{ number: 42, title: 'feat: mobile relay', url: 'https://github.com/o/r/pull/42', state: 'open' },
		);
	});

	test('maps draft / merged / closed states', () => {
		const build = (state: string, isDraft: boolean) => JSON.stringify({ number: 1, title: 't', url: 'https://github.com/o/r/pull/1', state, isDraft, headRefName: 'b' });
		assert.deepStrictEqual(
			[
				paradisParseGhPrStatus(build('OPEN', true), 'b')?.state,
				paradisParseGhPrStatus(build('MERGED', false), 'b')?.state,
				paradisParseGhPrStatus(build('CLOSED', false), 'b')?.state,
			],
			['draft', 'merged', 'closed'],
		);
	});

	test('rejects PRs whose head branch does not match the current branch, allowing fork prefixes', () => {
		const stdout = JSON.stringify({ number: 7, title: 't', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, headRefName: 'feature' });
		assert.deepStrictEqual(
			[
				paradisParseGhPrStatus(stdout, 'other-branch'),
				paradisParseGhPrStatus(stdout, 'fork-owner/feature')?.number,
			],
			[undefined, 7],
		);
	});

	test('returns undefined for non-JSON or malformed payloads', () => {
		assert.deepStrictEqual(
			[
				paradisParseGhPrStatus('no pull requests found', 'b'),
				paradisParseGhPrStatus('null', 'b'),
				paradisParseGhPrStatus(JSON.stringify({ number: 'x', url: 'https://x', state: 'OPEN', headRefName: 'b' }), 'b'),
				paradisParseGhPrStatus(JSON.stringify({ number: 1, url: 'https://x', state: 'UNKNOWN', headRefName: 'b' }), 'b'),
				paradisParseGhPrStatus(JSON.stringify({ number: 1, url: 'file:///etc/passwd', state: 'OPEN', headRefName: 'b' }), 'b'),
			],
			[undefined, undefined, undefined, undefined, undefined],
		);
	});
});
