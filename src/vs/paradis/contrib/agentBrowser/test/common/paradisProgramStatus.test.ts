/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCopyProgramStatus, paradisParseProgramStatus, paradisProgramStatusApplies, paradisProgramStatusToAgentStatus } from '../../common/paradisProgramStatus.js';

suite('Para Browser Claude Code program status (OSC 7501)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the sequences Claude Code 2.1.295 wrote in a PTY, and ignores subagent rows and other apps', () => {
		// The payloads below are the ones measured on Claude Code 2.1.295 (msg is base64).
		const inputs = {
			query: '?',
			idle: 'state=idle:app=claude-code',
			working: 'state=working:app=claude-code:msg=UmVtb3ZpbmcgdGhlIG5vbmV4aXN0ZW50IGZpbGUgaWYgcHJlc2VudA==',
			permission: 'state=blocked:app=claude-code:kind=permission:msg=YXBwcm92ZSBCYXNo',
			question: 'state=blocked:app=claude-code:kind=question:msg=YW5zd2Vy',
			done: 'state=done:app=claude-code',
			clear: 'state=clear',
			clearOneSubagent: 'state=clear:id=a0e56871',
			subagent: 'state=working:app=claude-code:id=a0e56871:title=UmVwbHk=',
			otherApp: 'state=working:app=other-cli',
			unknownState: 'state=sleeping:app=claude-code',
			noState: 'app=claude-code',
		};
		const parsed = Object.fromEntries(Object.entries(inputs).map(([name, data]) => [name, paradisParseProgramStatus(data)]));
		assert.deepStrictEqual(parsed, {
			query: 'query',
			idle: { state: 'idle' },
			working: { state: 'working' },
			permission: { state: 'blocked', kind: 'permission' },
			question: { state: 'blocked', kind: 'question' },
			done: { state: 'done' },
			clear: { state: 'clear' },
			clearOneSubagent: undefined,
			subagent: undefined,
			otherApp: undefined,
			unknownState: undefined,
			noState: undefined,
		});
	});

	test('maps the states onto the pane states the hooks use, and only for panes no hook has reached', () => {
		assert.deepStrictEqual({
			working: paradisProgramStatusToAgentStatus({ state: 'working' }),
			permission: paradisProgramStatusToAgentStatus({ state: 'blocked', kind: 'permission' }),
			question: paradisProgramStatusToAgentStatus({ state: 'blocked', kind: 'question' }),
			auth: paradisProgramStatusToAgentStatus({ state: 'blocked', kind: 'auth' }),
			dialog: paradisProgramStatusToAgentStatus({ state: 'blocked' }),
			done: paradisProgramStatusToAgentStatus({ state: 'done' }),
			error: paradisProgramStatusToAgentStatus({ state: 'error' }),
			idle: paradisProgramStatusToAgentStatus({ state: 'idle' }),
			clear: paradisProgramStatusToAgentStatus({ state: 'clear' }),
			withoutHooks: paradisProgramStatusApplies(false),
			withHooks: paradisProgramStatusApplies(true),
		}, {
			working: 'working',
			permission: 'permission',
			question: 'question',
			auth: 'permission',
			dialog: 'permission',
			done: 'review',
			error: 'review',
			idle: 'idle',
			clear: 'idle',
			withoutHooks: true,
			withHooks: false,
		});
	});

	test('accepts only a well-formed status over IPC', () => {
		assert.deepStrictEqual([
			paradisCopyProgramStatus({ state: 'blocked', kind: 'permission', extra: 1 }),
			paradisCopyProgramStatus({ state: 'done', kind: 'x'.repeat(40) }),
			paradisCopyProgramStatus({ state: 'done', kind: 'a:b' }),
			paradisCopyProgramStatus({ state: 'nope' }),
			paradisCopyProgramStatus('working'),
			paradisCopyProgramStatus(null),
		], [
			{ state: 'blocked', kind: 'permission' },
			{ state: 'done' },
			{ state: 'done' },
			undefined,
			undefined,
			undefined,
		]);
	});
});
