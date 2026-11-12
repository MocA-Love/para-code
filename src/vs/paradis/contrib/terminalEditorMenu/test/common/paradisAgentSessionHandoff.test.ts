/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentResumeCommandLine } from '../../../sessionResume/common/paradisSessionResume.js';
import { paradisAgentKindOfCommand, paradisBoundHandoffCapture, paradisBuildAgentHandoffPrompt, paradisReadableTranscriptPath } from '../../common/paradisAgentSessionHandoff.js';

suite('Paradis agent session handoff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('passes the transcript path only when the receiving agent can read it', () => {
		const path = '/Users/example/.claude/projects/app/0f8c2e1a.jsonl';
		const readable = (sessionRemote: boolean, windowRemote: boolean, targetPosix: boolean, transcriptPath: string | null = path) =>
			paradisReadableTranscriptPath({ transcriptPath: transcriptPath ?? undefined, sessionRemote, windowRemote, targetPosix });
		assert.deepStrictEqual({
			localToLocal: readable(false, false, true),
			remoteToRemote: readable(true, true, true),
			localSessionInSshWindow: readable(false, true, true),
			remoteSessionInLocalWindow: readable(true, false, true),
			windowsPathToWsl: readable(false, false, true, 'C:\\Users\\example\\.codex\\sessions\\rollout.jsonl'),
			posixPathToWindows: readable(false, false, false),
			windowsToWindows: readable(false, false, false, 'C:\\Users\\example\\.codex\\sessions\\rollout.jsonl'),
			relative: readable(false, false, true, 'sessions/rollout.jsonl'),
			controlCharacter: readable(false, false, true, '/tmp/a\nb.jsonl'),
			missing: readable(false, false, true, null),
		}, {
			localToLocal: path,
			remoteToRemote: path,
			localSessionInSshWindow: undefined,
			remoteSessionInLocalWindow: undefined,
			windowsPathToWsl: undefined,
			posixPathToWindows: undefined,
			windowsToWindows: 'C:\\Users\\example\\.codex\\sessions\\rollout.jsonl',
			relative: undefined,
			controlCharacter: undefined,
			missing: undefined,
		});
	});

	test('prefers the transcript path over the screen and bounds the screen capture', () => {
		const withPath = paradisBuildAgentHandoffPrompt({ agent: 'claude', title: 'Fix login', sessionId: 's1', cwd: '/Users/example/app', transcriptPath: '/Users/example/s1.jsonl', capturedText: 'SECRET=abc' });
		const withCapture = paradisBuildAgentHandoffPrompt({ agent: 'codex', capturedText: 'line ``` one\nline two' });
		const capture = paradisBoundHandoffCapture(`${'x'.repeat(30)}\nkeep this\nand this`, 20);
		assert.deepStrictEqual({
			pathIncluded: withPath?.includes('/Users/example/s1.jsonl'),
			screenLeftOut: withPath?.includes('SECRET'),
			header: withPath?.split('\n').slice(3, 7),
			captureFenced: withCapture?.includes('````text\nline ``` one\nline two\n````'),
			noContext: paradisBuildAgentHandoffPrompt({ agent: 'claude' }),
			capture,
		}, {
			pathIncluded: true,
			screenLeftOut: false,
			header: ['Original agent: Claude Code', 'Session: Fix login', 'Session id: s1', 'Original working directory: /Users/example/app'],
			captureFenced: true,
			noContext: undefined,
			capture: 'keep this\nand this',
		});
	});

	test('masks secrets in the screen capture before cutting it, so a key whose BEGIN line falls off is still masked', () => {
		const keyBody = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
		const screen = `-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----\n$ export PASSWORD=hunter2\ndone`;
		const capture = paradisBoundHandoffCapture(screen, 100);
		assert.deepStrictEqual({ keyLeft: capture.includes(keyBody), passwordLeft: capture.includes('hunter2'), kept: capture.endsWith('done') }, { keyLeft: false, passwordLeft: false, kept: true });
	});

	test('reads the agent kind of configured launch commands and builds the fork commands', () => {
		assert.deepStrictEqual({
			kinds: ['claude --model opus', 'FOO=1 codex', '/usr/local/bin/codex.exe -c x', 'opencode', 'aider'].map(paradisAgentKindOfCommand),
			claudeFork: paradisAgentResumeCommandLine('claude', '0f8c2e1a-7d3b-4c5e-9a6f-1b2c3d4e5f60', 'fork'),
			codexFork: paradisAgentResumeCommandLine('codex', '0f8c2e1a-7d3b-4c5e-9a6f-1b2c3d4e5f60', 'fork'),
		}, {
			kinds: ['claude', 'codex', 'codex', 'opencode', undefined],
			claudeFork: 'claude --permission-mode manual --resume 0f8c2e1a-7d3b-4c5e-9a6f-1b2c3d4e5f60 --fork-session',
			codexFork: 'codex fork --sandbox workspace-write --ask-for-approval on-request 0f8c2e1a-7d3b-4c5e-9a6f-1b2c3d4e5f60',
		});
	});
});
