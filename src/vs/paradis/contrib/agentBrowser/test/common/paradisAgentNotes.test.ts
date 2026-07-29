/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentNoteLines, paradisParseAgentNoteToolArgs } from '../../common/paradisAgentNotes.js';
import { PARADIS_SPACE_NOTE_MAX_LENGTH } from '../../../workspaceSwitch/common/paradisSpaceNotes.js';

suite('paradisAgentNotes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes the arguments of every space note tool', () => {
		assert.deepStrictEqual([
			paradisParseAgentNoteToolArgs('list_space_notes', undefined),
			paradisParseAgentNoteToolArgs('read_space_note', { space: 'worktree:file:///repo/wt' }),
			paradisParseAgentNoteToolArgs('write_space_note', { text: '- [ ] a' }),
			paradisParseAgentNoteToolArgs('add_space_note_task', { task: ' ship it ' }),
			paradisParseAgentNoteToolArgs('check_space_note_task', { line: 2, done: true }),
			paradisParseAgentNoteToolArgs('check_space_note_task', { line: 0 }),
			paradisParseAgentNoteToolArgs('delete_space_note_task', { line: 3, space: 'repo-1' }),
		], [
			{ ok: true, request: { op: 'list' } },
			{ ok: true, request: { op: 'read', space: 'worktree:file:///repo/wt' } },
			{ ok: true, request: { op: 'write', text: '- [ ] a' } },
			{ ok: true, request: { op: 'addTask', task: ' ship it ' } },
			{ ok: true, request: { op: 'checkTask', line: 2, done: true } },
			{ ok: true, request: { op: 'checkTask', line: 0 } },
			{ ok: true, request: { op: 'deleteTask', space: 'repo-1', line: 3 } },
		]);
	});

	test('rejects malformed arguments with a readable message', () => {
		assert.deepStrictEqual([
			paradisParseAgentNoteToolArgs('unknown_tool', {}),
			paradisParseAgentNoteToolArgs('read_space_note', []),
			paradisParseAgentNoteToolArgs('read_space_note', { space: '' }),
			paradisParseAgentNoteToolArgs('write_space_note', {}),
			paradisParseAgentNoteToolArgs('write_space_note', { text: 'x'.repeat(PARADIS_SPACE_NOTE_MAX_LENGTH + 1) }),
			paradisParseAgentNoteToolArgs('add_space_note_task', { task: '   ' }),
			paradisParseAgentNoteToolArgs('check_space_note_task', { line: 1.5 }),
			paradisParseAgentNoteToolArgs('check_space_note_task', { line: -1 }),
			paradisParseAgentNoteToolArgs('check_space_note_task', { line: 0, done: 'yes' }),
			paradisParseAgentNoteToolArgs('delete_space_note_task', {}),
		].map(result => result.ok), [false, false, false, false, false, false, false, false, false, false]);
	});

	test('normalizes CRLF so the checklist parser still sees the items', () => {
		const written = paradisParseAgentNoteToolArgs('write_space_note', { text: '# Plan\r\n- [ ] first\r\n' });
		assert.deepStrictEqual(written, { ok: true, request: { op: 'write', text: '# Plan\n- [ ] first\n' } });
		assert.deepStrictEqual(
			paradisAgentNoteLines(written.ok && written.request.text !== undefined ? written.request.text : '').map(line => line.kind),
			['heading', 'task', 'blank'],
		);
		assert.deepStrictEqual(
			paradisParseAgentNoteToolArgs('add_space_note_task', { task: 'first\r\nsecond' }),
			{ ok: true, request: { op: 'addTask', task: 'first\nsecond' } },
		);
	});

	test('numbers every line so checklist items can be addressed', () => {
		assert.deepStrictEqual(paradisAgentNoteLines('# Plan\n- [ ] first\n\n- [x] second\nplain'), [
			{ line: 0, kind: 'heading', text: 'Plan' },
			{ line: 1, kind: 'task', text: 'first', done: false },
			{ line: 2, kind: 'blank', text: '' },
			{ line: 3, kind: 'task', text: 'second', done: true },
			{ line: 4, kind: 'text', text: 'plain' },
		]);
	});
});
