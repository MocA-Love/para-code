/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisApprovalDenyMessage, paradisApprovalSuggestionScope, paradisBuildAgentApprovalRequest, paradisParseAgentApprovalRequest, paradisSanitizeApprovalInstruction } from '../../common/paradisAgentApprovalRequest.js';

suite('paradisAgentApprovalRequest (agent.approval.detail.v1)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('splits the tool input by tool: Bash keeps the description and the whole command, others their own fields', () => {
		assert.deepStrictEqual([
			paradisBuildAgentApprovalRequest('Bash', { command: 'cd ~/projects/demo && sh -c "rm -rf ./junk"', description: 'Clean junk' }, { id: 'a-1', name: 'general-purpose', role: 'subagent' }),
			paradisBuildAgentApprovalRequest('Edit', { file_path: '/Users/example/a.ts', old_string: 'const RETRY = 3;', new_string: 'const RETRY = 5;', replace_all: true }),
			paradisBuildAgentApprovalRequest('Write', { file_path: '/Users/example/notes.md', content: '# Title\nbody\n' }),
			paradisBuildAgentApprovalRequest('WebFetch', { url: 'https://docs.example.com/limits', prompt: 'Summarize the limits' }),
			paradisBuildAgentApprovalRequest('mcp__acme-db__run_query', { sql: 'DELETE FROM jobs', dry_run: false, command: 'not a shell' }),
			paradisBuildAgentApprovalRequest('Glob', { pattern: '**/*.ts' }),
			paradisBuildAgentApprovalRequest(undefined, { command: 'ls' }),
		], [
			{ tool: 'Bash', kind: 'bash', command: 'cd ~/projects/demo && sh -c "rm -rf ./junk"', description: 'Clean junk', agent: { id: 'a-1', name: 'general-purpose', role: 'subagent' } },
			{ tool: 'Edit', kind: 'edit', path: '/Users/example/a.ts', oldText: 'const RETRY = 3;', newText: 'const RETRY = 5;', replaceAll: true },
			{ tool: 'Write', kind: 'write', path: '/Users/example/notes.md', content: '# Title\nbody\n', contentLines: 2 },
			{ tool: 'WebFetch', kind: 'fetch', url: 'https://docs.example.com/limits', prompt: 'Summarize the limits' },
			{ tool: 'mcp__acme-db__run_query', kind: 'mcp', mcpServer: 'acme-db', mcpTool: 'run_query', args: [{ key: 'sql', value: 'DELETE FROM jobs' }, { key: 'dry_run', value: 'false' }, { key: 'command', value: 'not a shell' }] },
			{ tool: 'Glob', kind: 'other', args: [{ key: 'pattern', value: '**/*.ts' }] },
			undefined,
		]);
	});

	test('marks a command cut at the hook limit (10,000 characters) as cut', () => {
		assert.deepStrictEqual([
			paradisBuildAgentApprovalRequest('Bash', { command: 'x'.repeat(10_000) })?.truncated,
			paradisBuildAgentApprovalRequest('Bash', { command: 'x'.repeat(9_999) })?.truncated,
		], [true, undefined]);
	});

	test('sends only the head of large edits and contents, and marks what it cut', () => {
		const big = 'x'.repeat(2_500);
		const edit = paradisBuildAgentApprovalRequest('MultiEdit', { file_path: '/a.ts', edits: [{ old_string: big, new_string: 'y' }, { old_string: 'b', new_string: 'c' }] });
		const write = paradisBuildAgentApprovalRequest('Write', { file_path: '/a.ts', content: `${big}\nend` });
		assert.deepStrictEqual({
			edit: [edit?.kind, edit?.oldText?.length, edit?.newText, edit?.truncated],
			write: [write?.content?.length, write?.contentLines, write?.truncated],
		}, { edit: ['edit', 2_000, 'y', true], write: [2_000, 2, true] });
	});

	test('reads back what the PC built and drops fields over the limits or of the wrong shape', () => {
		const built = paradisBuildAgentApprovalRequest('Bash', { command: 'npm test', description: 'Run tests' }, { name: 'Explore' });
		assert.deepStrictEqual({
			roundTrip: paradisParseAgentApprovalRequest(JSON.parse(JSON.stringify(built))),
			badKind: paradisParseAgentApprovalRequest({ tool: 'Bash', kind: 'shell' }),
			noTool: paradisParseAgentApprovalRequest({ kind: 'bash' }),
			longCommand: paradisParseAgentApprovalRequest({ tool: 'Bash', kind: 'bash', command: 'x'.repeat(10_001), contentLines: -1, args: [{ key: 1, value: 'v' }], agent: { role: 'teammate' } }),
		}, {
			roundTrip: { tool: 'Bash', kind: 'bash', command: 'npm test', description: 'Run tests', agent: { name: 'Explore' } },
			badKind: undefined,
			noTool: undefined,
			longCommand: { tool: 'Bash', kind: 'bash' },
		});
	});

	test('tells how the "don\'t ask again" rules last, and writes the refusal the terminal writes for an instruction', () => {
		assert.deepStrictEqual({
			session: paradisApprovalSuggestionScope([{ type: 'addRules', rules: [], destination: 'session' }]),
			settings: paradisApprovalSuggestionScope([{ type: 'addRules', rules: [], destination: 'localSettings' }]),
			mode: paradisApprovalSuggestionScope([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addRules', destination: 'localSettings' }]),
			// 残り方の分からないもの（知らない値・無し）は残る側に倒す
			unknown: [paradisApprovalSuggestionScope([{ type: 'addRules', destination: 'somewhereNew' }]), paradisApprovalSuggestionScope([{ type: 'addDirectories', directories: ['/a'] }]), paradisApprovalSuggestionScope([{ destination: 'session' }, { destination: 'cliArg' }])],
			none: [paradisApprovalSuggestionScope([]), paradisApprovalSuggestionScope(undefined)],
			deny: paradisApprovalDenyMessage('  echo kept にして  '),
			// 制御文字は改行とタブだけ残す
			sanitized: paradisSanitizeApprovalInstruction('a\u0007b\u001b[31mc\r\n\td\u007f'),
			// 表示の向きを変える文字・行と段落の区切りも除く
			bidi: paradisSanitizeApprovalInstruction('\u202eabc\u202c x\u2066y\u2069\u2028z\u2029'),
		}, {
			session: 'session',
			settings: 'settings',
			mode: 'mode',
			unknown: ['settings', 'settings', 'settings'],
			none: [undefined, undefined],
			sanitized: 'ab[31mc\n\td',
			bidi: 'abc xyz',
			deny: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\necho kept にして',
		});
	});
});
