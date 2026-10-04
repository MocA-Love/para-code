/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisInteractiveAgentCommand, paradisResolveRunningAgentCommand } from '../../common/paradisAgentCliCommand.js';

suite('ParadisAgentCliCommand', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes current interactive Codex invocations', () => {
		assert.deepStrictEqual([
			paradisInteractiveAgentCommand('codex'),
			paradisInteractiveAgentCommand('CODEX_HOME=/tmp/codex /usr/local/bin/codex --search "調査して"'),
			paradisInteractiveAgentCommand('codex resume --last'),
			paradisInteractiveAgentCommand('codex resume 019f-thread'),
			paradisInteractiveAgentCommand('codex fork 019f-thread'),
			paradisInteractiveAgentCommand('codex fork --last'),
		], [
			{ agent: 'codex', mode: 'new' },
			{ agent: 'codex', mode: 'new' },
			{ agent: 'codex', mode: 'resume' },
			{ agent: 'codex', mode: 'resume', sessionId: '019f-thread' },
			// fork の id は元の会話で、このペインの会話ではない（sessionId にしない）
			{ agent: 'codex', mode: 'fork', forkedFromId: '019f-thread' },
			{ agent: 'codex', mode: 'fork' },
		]);
	});

	test('rejects current non-interactive Codex invocations', () => {
		for (const command of ['codex --help', 'codex --version', 'codex exec test', 'codex review', 'codex app-server', 'codex mcp-server', 'codex completion zsh']) {
			assert.strictEqual(paradisInteractiveAgentCommand(command), undefined, command);
		}
	});

	test('recognizes only interactive Claude invocations', () => {
		assert.deepStrictEqual([
			paradisInteractiveAgentCommand('claude'),
			paradisInteractiveAgentCommand('claude --resume session-id'),
			paradisInteractiveAgentCommand('claude --continue'),
			paradisInteractiveAgentCommand('claude -c'),
			paradisInteractiveAgentCommand('claude --from-pr 123'),
			paradisInteractiveAgentCommand('claude --from-pr=https://github.com/example/repo/pull/123'),
			paradisInteractiveAgentCommand('claude --teleport'),
			paradisInteractiveAgentCommand('claude --continue --fork-session'),
			paradisInteractiveAgentCommand('claude --resume session-id --fork-session'),
			paradisInteractiveAgentCommand('claude -c --fork-session'),
			paradisInteractiveAgentCommand('claude -r session-id --fork-session'),
			paradisInteractiveAgentCommand('claude --fork-session'),
			paradisInteractiveAgentCommand('claude --model opus "調査して"'),
		], [
			{ agent: 'claude', mode: 'new' },
			{ agent: 'claude', mode: 'resume' },
			{ agent: 'claude', mode: 'resume' },
			{ agent: 'claude', mode: 'resume' },
			{ agent: 'claude', mode: 'resume' },
			{ agent: 'claude', mode: 'resume' },
			{ agent: 'claude', mode: 'resume' },
			{ agent: 'claude', mode: 'fork' },
			{ agent: 'claude', mode: 'fork' },
			{ agent: 'claude', mode: 'fork' },
			{ agent: 'claude', mode: 'fork' },
			{ agent: 'claude', mode: 'new' },
			{ agent: 'claude', mode: 'new' },
		]);
		for (const command of ['claude --help', 'claude -v', 'claude --version', 'claude --print test', 'claude --continue --print test', 'claude --background', 'claude agents', 'claude doctor', 'claude doctor --fork-session']) {
			assert.strictEqual(paradisInteractiveAgentCommand(command), undefined, command);
		}
	});

	test('takes the session id out of claude attach and leaves the background session commands alone', () => {
		assert.deepStrictEqual([
			paradisInteractiveAgentCommand('claude attach 52a3701d'),
			paradisInteractiveAgentCommand('claude attach 52a3701d-a5b0-4252-99f9-e155af08db4d'),
			paradisInteractiveAgentCommand('/Users/example/.local/bin/claude attach "52a3701d"'),
			paradisInteractiveAgentCommand('claude attach'),
		], [
			{ agent: 'claude', mode: 'attach', sessionId: '52a3701d' },
			{ agent: 'claude', mode: 'attach', sessionId: '52a3701d-a5b0-4252-99f9-e155af08db4d' },
			{ agent: 'claude', mode: 'attach', sessionId: '52a3701d' },
			{ agent: 'claude', mode: 'attach' },
		]);
		for (const command of ['claude logs 52a3701d', 'claude stop 52a3701d', 'claude kill 52a3701d', 'claude rm 52a3701d', 'claude respawn --all', 'claude purge /tmp/x', 'claude attach --help']) {
			assert.strictEqual(paradisInteractiveAgentCommand(command), undefined, command);
		}
	});

	test('reconciles a running Agent only after both CommandDetection and the retained pane token are available, regardless of arrival order', () => {
		const commandFirst = paradisResolveRunningAgentCommand('codex resume 019f-thread', undefined);
		const tokenFirst = paradisResolveRunningAgentCommand(undefined, 'retained-pane-token');
		assert.strictEqual(commandFirst, undefined);
		assert.strictEqual(tokenFirst, undefined);

		assert.deepStrictEqual(
			paradisResolveRunningAgentCommand('codex resume 019f-thread', 'retained-pane-token'),
			{
				paneToken: 'retained-pane-token',
				commandLine: 'codex resume 019f-thread',
				command: { agent: 'codex', mode: 'resume', sessionId: '019f-thread' },
			},
		);
	});

	test('allows a failed notification to re-resolve only while the exact same Agent command is still running', () => {
		const failedAttempt = paradisResolveRunningAgentCommand('claude --continue', 'pane-token');
		assert.notStrictEqual(failedAttempt, undefined);
		assert.deepStrictEqual(
			paradisResolveRunningAgentCommand('claude --continue', 'pane-token'),
			failedAttempt,
			'the same command remains retryable',
		);
		assert.notDeepStrictEqual(
			paradisResolveRunningAgentCommand('codex', 'pane-token'),
			failedAttempt,
			'a replacement command is a new notification, not a retry of the failed one',
		);
		assert.strictEqual(paradisResolveRunningAgentCommand(undefined, 'pane-token'), undefined);
	});
});
