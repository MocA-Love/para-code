/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisInteractiveAgentCommand } from '../../common/paradisAgentCliCommand.js';

suite('ParadisAgentCliCommand', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes current interactive Codex invocations', () => {
		assert.deepStrictEqual([
			paradisInteractiveAgentCommand('codex'),
			paradisInteractiveAgentCommand('CODEX_HOME=/tmp/codex /usr/local/bin/codex --search "調査して"'),
			paradisInteractiveAgentCommand('codex resume --last'),
			paradisInteractiveAgentCommand('codex fork 019f-thread'),
		], [
			{ agent: 'codex', mode: 'new' },
			{ agent: 'codex', mode: 'new' },
			{ agent: 'codex', mode: 'resume' },
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
});
