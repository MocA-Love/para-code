/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyTrackableCodexCommand, createCodexTerminalTitle, ICodexTrackableCommand, isCodexTuiCommand, resolveWritableCodexHome } from '../../electron-browser/paradisCodexTerminalTitle.contribution.js';

suite('ParadisCodexTerminalTitle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('isCodexTuiCommand', () => {
		for (const command of [
			'codex',
			'/opt/homebrew/bin/codex',
			'codex.cmd',
			'"C:\\tools\\codex.cmd" resume',
			'codex "fix the terminal title"',
			'codex resume',
			'codex resume --last',
			'codex --model gpt-5 resume 019f4d58-4ce0-7f50-89a8-d2bbec6b2743',
			'codex --dangerously-bypass-approvals-and-sandbox',
		]) {
			test(`accepts ${command}`, () => strictEqual(isCodexTuiCommand(command), true));
		}

		for (const command of [
			'codex exec "fix it"',
			'codex app-server',
			'codex review',
			'env codex',
			'my-codex',
			'codex && echo spoofed',
			'codex | tee output',
			'codex "unterminated',
		]) {
			test(`rejects ${command}`, () => strictEqual(isCodexTuiCommand(command), false));
		}
	});

	suite('classifyTrackableCodexCommand', () => {
		function command(overrides: Partial<ICodexTrackableCommand> = {}): ICodexTrackableCommand {
			return { command: 'codex', commandLineConfidence: 'high', isTrusted: true, wasReplayed: false, cwd: '/workspace', ...overrides };
		}

		test('tracks a command line the shell vouched for', () => {
			deepStrictEqual(classifyTrackableCodexCommand(command()), { invocation: 'start', cwd: '/workspace' });
			deepStrictEqual(classifyTrackableCodexCommand(command({ command: 'codex resume' })), { invocation: 'resume', cwd: '/workspace' });
		});

		// A prompt that suppresses VS Code's shell integration (powerlevel10k unsets the flag that
		// enables it) leaves every command untrusted at 'medium', recovered from the screen buffer.
		// Refusing that left the feature dead for those users.
		test('tracks a command line recovered from the buffer', () => {
			deepStrictEqual(classifyTrackableCodexCommand(command({ commandLineConfidence: 'medium', isTrusted: false })), { invocation: 'start', cwd: '/workspace' });
		});

		// The buffer contains autosuggestion ghost text, so `codex` under a `codex resume --last`
		// suggestion is recovered whole. Honouring that resume would waive the cwd check and put
		// another directory's thread on this tab.
		test('never grants resume to a command line the shell did not vouch for', () => {
			deepStrictEqual(classifyTrackableCodexCommand(command({ command: 'codex resume --last', commandLineConfidence: 'medium', isTrusted: false })), { invocation: 'start', cwd: '/workspace' });
			// 'high' without the nonce is any OSC 633;E, so it is spoofable and gets the same treatment.
			deepStrictEqual(classifyTrackableCodexCommand(command({ command: 'codex resume --last', isTrusted: false })), { invocation: 'start', cwd: '/workspace' });
		});

		test('refuses a bare buffer guess', () => {
			strictEqual(classifyTrackableCodexCommand(command({ commandLineConfidence: 'low', isTrusted: false })), undefined);
			// An empty command line is what the buffer yields before anything is recovered.
			strictEqual(classifyTrackableCodexCommand(command({ command: '', commandLineConfidence: 'medium', isTrusted: false })), undefined);
			strictEqual(classifyTrackableCodexCommand(command({ command: '', commandLineConfidence: 'low', isTrusted: false })), undefined);
		});

		test('refuses replayed commands and non-absolute directories', () => {
			strictEqual(classifyTrackableCodexCommand(command({ wasReplayed: true })), undefined);
			strictEqual(classifyTrackableCodexCommand(command({ cwd: 'relative/path' })), undefined);
			strictEqual(classifyTrackableCodexCommand(command({ cwd: undefined })), undefined);
		});

		test('refuses commands that do not start the Codex TUI', () => {
			strictEqual(classifyTrackableCodexCommand(command({ command: 'codex exec "fix it"' })), undefined);
			strictEqual(classifyTrackableCodexCommand(command({ command: 'codex && echo spoofed' })), undefined);
		});
	});

	suite('createCodexTerminalTitle', () => {
		test('uses the first meaningful line and removes markdown decoration', () => {
			strictEqual(createCodexTerminalTitle('\n## Fix terminal title\nMore detail'), 'Fix terminal title');
		});

		test('truncates long titles', () => {
			strictEqual(createCodexTerminalTitle('1234567890123456789012345678901234567890'), '123456789012345678901234567890123456…');
		});

		test('removes terminal controls and bidirectional formatting', () => {
			strictEqual(createCodexTerminalTitle('Fix\u001b[31m title\u202e'), 'Fix title');
		});
	});

	suite('resolveWritableCodexHome', () => {
		const localHome = URI.file('/Users/example');
		const remoteAuthority = 'ssh-remote+box';
		const resolvedRemoteHome = URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path: '/home/example' });

		test('uses the raw home unchanged on a local window', () => {
			strictEqual(resolveWritableCodexHome(undefined, localHome)?.toString(), localHome.toString());
		});

		test('uses the remote home once it resolves to the connected host', () => {
			const result = resolveWritableCodexHome(remoteAuthority, resolvedRemoteHome);
			strictEqual(result?.toString(), resolvedRemoteHome.toString());
		});

		// userHome() が未解決の間に黙って手元へフォールバックした値をそのまま使うと、
		// 手元の ~/.codex/config.toml を書き換えてしまう (2026-08-19 のインシデント)。
		test('refuses to write when the remote window has not resolved its host yet', () => {
			strictEqual(resolveWritableCodexHome(remoteAuthority, localHome), undefined);
		});

		test('refuses a home that resolved to a different remote host', () => {
			const otherHost = URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+other', path: '/home/example' });
			strictEqual(resolveWritableCodexHome(remoteAuthority, otherHost), undefined);
		});
	});
});
