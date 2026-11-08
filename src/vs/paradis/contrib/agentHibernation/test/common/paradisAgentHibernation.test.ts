/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHibernationComposerBuffer, IParadisHibernationPaneFacts, paradisAgentHibernationIdleMs, paradisClaudeComposerState, paradisCommandLineBypassesPermissions, paradisHibernationVerdict, paradisIsShellCommandLine, paradisIsUserTypedInput, paradisNextPendingDraft, paradisParseHibernationResult } from '../../common/paradisAgentHibernation.js';

suite('paradisAgentHibernation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const MINUTE = 60_000;
	const NOW = 1_000 * MINUTE;
	const IDLE = 30 * MINUTE;
	const finished: IParadisHibernationPaneFacts = {
		editorArea: true, remote: false, taskBoard: false, hibernated: false, busy: false,
		status: 'review', quiet: false, awaitingUser: false, replayedPrompt: false,
		session: { agent: 'claude', sessionId: 'session-1' },
		completedAt: NOW - 31 * MINUTE,
		visible: false, lastVisibleAt: undefined, lastInputAt: undefined, pendingDraft: false, composer: 'empty',
		remoteViewing: false, lastRemoteViewAt: undefined, retryAfter: undefined,
	};

	test('hibernates only a finished, unattended agent in the editor area of a local window', () => {
		const cases: Record<string, Partial<IParadisHibernationPaneFacts>> = {
			'finished 31 minutes ago': {},
			'seen after finishing (idle)': { status: undefined },
			'finished 10 minutes ago': { completedAt: NOW - 10 * MINUTE },
			'looked at 5 minutes ago': { lastVisibleAt: NOW - 5 * MINUTE },
			'typed 5 minutes ago': { lastInputAt: NOW - 5 * MINUTE },
			'the phone looked 5 minutes ago': { lastRemoteViewAt: NOW - 5 * MINUTE },
			'panel terminal': { editorArea: false },
			'SSH': { remote: true },
			'task board': { taskBoard: true },
			'already hibernated': { hibernated: true },
			'being stopped': { busy: true },
			'working': { status: 'working' },
			'asking for a permission': { status: 'permission' },
			'asking a question': { status: 'question' },
			'quiet completion': { quiet: true },
			'permission was denied': { awaitingUser: true },
			'replayed prompt': { replayedPrompt: true },
			'no conversation': { session: undefined },
			'completion not seen in this window': { completedAt: undefined },
			'on screen': { visible: true },
			'open on the phone': { remoteViewing: true },
			'unsent draft': { pendingDraft: true },
			'text in the input box': { composer: 'text' },
			'input box not readable': { composer: 'unknown' },
			'refused recently': { retryAfter: NOW + MINUTE },
			'refused long ago': { retryAfter: NOW - MINUTE },
		};
		const verdicts = Object.fromEntries(Object.entries(cases).map(([name, change]) => {
			const verdict = paradisHibernationVerdict({ ...finished, ...change }, NOW, IDLE);
			return [name, verdict.kind === 'skip' ? verdict.reason : verdict.kind === 'wait' ? `wait ${(verdict.dueAt - NOW) / MINUTE}m` : 'hibernate'];
		}));
		assert.deepStrictEqual(verdicts, {
			'finished 31 minutes ago': 'hibernate',
			'seen after finishing (idle)': 'hibernate',
			'finished 10 minutes ago': 'wait 20m',
			'looked at 5 minutes ago': 'wait 25m',
			'typed 5 minutes ago': 'wait 25m',
			'the phone looked 5 minutes ago': 'wait 25m',
			'panel terminal': 'not-editor-area',
			'SSH': 'remote',
			'task board': 'task-board',
			'already hibernated': 'hibernated',
			'being stopped': 'busy',
			'working': 'working',
			'asking for a permission': 'permission',
			'asking a question': 'question',
			'quiet completion': 'quiet',
			'permission was denied': 'awaiting-user',
			'replayed prompt': 'replayed-prompt',
			'no conversation': 'no-session',
			'completion not seen in this window': 'completion-unknown',
			'on screen': 'visible',
			'open on the phone': 'remote-viewing',
			'unsent draft': 'draft',
			'text in the input box': 'composer-text',
			'input box not readable': 'composer-unknown',
			'refused recently': 'retry-later',
			'refused long ago': 'hibernate',
		});
	});

	// 画面の Claude Code の入力欄。案内の文（薄い）は空、打った文・貼り付けた文（薄くない）は書きかけ、見つからなければ分からない
	test('reads whether the Claude Code input box under the rule holds text', () => {
		const screen = (rows: readonly (readonly [string, boolean?])[]): IParadisHibernationComposerBuffer => ({
			length: rows.length,
			getLine: y => {
				const row = rows[y];
				if (row === undefined) {
					return undefined;
				}
				const [text, dim] = row;
				const chars = [...text];
				return {
					length: chars.length,
					translateToString: () => text.trimEnd(),
					// 印 `❯` は薄くない。dim の行は印の後ろだけ薄い（案内の文）
					getCell: x => chars[x] === undefined ? undefined : { getChars: () => chars[x], isDim: () => dim === true && chars[x] !== '❯' ? 1 : 0 },
				};
			},
		});
		const rule = '────────────────────────────────';
		assert.deepStrictEqual({
			placeholder: paradisClaudeComposerState(screen([['● Done.'], [rule], ['❯ Try "fix lint errors"', true], [rule], ['  ? for shortcuts']])),
			empty: paradisClaudeComposerState(screen([['● Done.'], [rule], ['❯ '], [rule], ['  ? for shortcuts']])),
			typed: paradisClaudeComposerState(screen([['● Done.'], [rule], ['❯ fix the login'], [rule]])),
			secondLine: paradisClaudeComposerState(screen([[rule], ['❯ '], ['  and the tests'], [rule]])),
			pasted: paradisClaudeComposerState(screen([[rule], ['❯ [Pasted text #1 +40 lines]'], [rule]])),
			permissionMenu: paradisClaudeComposerState(screen([['Do you want to proceed?'], ['❯ 1. Yes'], ['  2. No']])),
			noInputBox: paradisClaudeComposerState(screen([['$ ls'], ['README.md']])),
		}, { placeholder: 'empty', empty: 'empty', typed: 'text', secondLine: 'text', pasted: 'text', permissionMenu: 'unknown', noInputBox: 'unknown' });
	});

	test('reads the idle minutes, the typed input, the shells under the agent and the permission flags', () => {
		const draft = (inputs: readonly string[]) => inputs.reduce((previous, data) => paradisNextPendingDraft(previous, data), false);
		assert.deepStrictEqual({
			idle: [undefined, 0, 1, 30, 1440, 1441, 'x'].map(value => paradisAgentHibernationIdleMs(value) / MINUTE),
			draft: {
				typedOnly: draft(['f', 'i', 'x']),
				submitted: draft(['fix the test', '\r']),
				pastedAndSubmitted: draft(['fix\r']),
				arrowsAfterSubmit: draft(['go\r', '\x1b[A']),
				clearedWithBackspace: draft(['a', '\x7f']),
				pastedOnly: draft(['\x1b[200~fix the login form\x1b[201~']),
				pastedThenSubmitted: draft(['\x1b[200~fix it\x1b[201~', '\r']),
				pastedWithEnter: draft(['\x1b[200~fix it\x1b[201~\r']),
			},
			typed: ['a', '\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[A', '\x1b'].map(paradisIsUserTypedInput),
			shells: ['/bin/zsh -c sleep 10', '-bash', 'bash', 'node /opt/mcp/server.js', 'claude', '/usr/bin/python3 -m server', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -c x'].map(paradisIsShellCommandLine),
			bypass: ['claude --dangerously-skip-permissions', 'codex --dangerously-bypass-approvals-and-sandbox resume x', 'codex --yolo', 'claude --permission-mode bypassPermissions', 'claude --permission-mode=bypassPermissions', 'claude --permission-mode default', 'claude'].map(paradisCommandLineBypassesPermissions),
			results: [{ ok: true, bypass: true, killed: false }, { ok: false, reason: 'background-shell' }, { ok: false, reason: 'made-up' }, undefined].map(paradisParseHibernationResult),
		}, {
			idle: [30, 30, 1, 30, 1440, 30, 30],
			draft: { typedOnly: true, submitted: false, pastedAndSubmitted: false, arrowsAfterSubmit: false, clearedWithBackspace: true, pastedOnly: true, pastedThenSubmitted: false, pastedWithEnter: false },
			typed: [true, false, false, false, true, true],
			shells: [true, true, true, false, false, false, true],
			bypass: [true, true, true, true, true, false, false],
			results: [{ ok: true, bypass: true, killed: false }, { ok: false, reason: 'background-shell' }, { ok: false, reason: 'not-eligible' }, { ok: false, reason: 'not-eligible' }],
		});
	});
});
