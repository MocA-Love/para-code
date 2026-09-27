/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisResumeSession } from '../../common/paradisSessionResume.js';
import {
	paradisCombineIndexedSearch,
	paradisGroupResumeSessions,
	paradisParseResumeListOptions,
	paradisResumeCommandLine,
	paradisSortResumeSessions,
} from '../../common/paradisSessionResumeListOptions.js';

function session(id: string, agent: 'claude' | 'codex', title: string, cwd: string, updatedAt: number, createdAt?: number): IParadisResumeSession {
	return { catalogId: `c-${id}`, id, agent, title, preview: title, cwd, spaceStateKey: 's', spaceName: 'S', currentSpace: false, updatedAt, createdAt, archived: false };
}

suite('ParadisSessionResumeListOptions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const sessions = [
		session('a', 'claude', 'beta', '/work/repo', 30, 10),
		session('b', 'codex', 'alpha', '/work/repo/.wt/x', 20, 25),
		session('c', 'claude', 'gamma', '/work/repo/.wt/x', 10),
	];

	test('sorts by update time, creation time (falling back to update time) and title', () => {
		assert.deepStrictEqual({
			updated: paradisSortResumeSessions(sessions, 'updated').map(value => value.id),
			created: paradisSortResumeSessions(sessions, 'created').map(value => value.id),
			title: paradisSortResumeSessions(sessions, 'title').map(value => value.id),
		}, { updated: ['a', 'b', 'c'], created: ['b', 'a', 'c'], title: ['b', 'a', 'c'] });
	});

	test('groups by folder and by agent in the order of the first session', () => {
		const summarize = (grouping: 'folder' | 'agent') => paradisGroupResumeSessions(sessions, grouping).map(group => ({ title: group.title, tooltip: group.tooltip, ids: group.sessions.map(value => value.id) }));
		assert.deepStrictEqual({ folder: summarize('folder'), agent: summarize('agent') }, {
			folder: [{ title: 'repo', tooltip: '/work/repo', ids: ['a'] }, { title: 'x', tooltip: '/work/repo/.wt/x', ids: ['b', 'c'] }],
			agent: [{ title: 'Claude Code', tooltip: undefined, ids: ['a', 'c'] }, { title: 'Codex', tooltip: undefined, ids: ['b'] }],
		});
	});

	test('falls back to the defaults for broken stored options and quotes the working folder in the resume command', () => {
		assert.deepStrictEqual({
			broken: paradisParseResumeListOptions('{not json'),
			partial: paradisParseResumeListOptions(JSON.stringify({ sort: 'title', group: 'nope', hideEmpty: true })),
			posix: paradisResumeCommandLine({ agent: 'claude', id: 'abc', cwd: `/work/it's` }, false),
			windows: paradisResumeCommandLine({ agent: 'codex', id: 'def', cwd: `C:\\work\\$(calc) it's %TEMP%` }, true),
		}, {
			broken: { sort: 'updated', group: 'space', hideEmpty: false },
			partial: { sort: 'title', group: 'space', hideEmpty: true },
			posix: `cd '/work/it'\\''s' && claude --resume abc`,
			windows: `Set-Location -LiteralPath 'C:\\work\\$(calc) it''s %TEMP%'; codex resume def`,
		});
	});

	test('matches every term either in the session info or in the indexed body', () => {
		const target = session('a', 'claude', 'Login screen', '/work/para-code', 30);
		const terms = ['para-code', 'バグ修正'];
		assert.deepStrictEqual({
			mixed: paradisCombineIndexedSearch(target, terms, { terms: [1], matchCount: 3, snippet: 'バグ修正の話' }),
			metadataOnly: paradisCombineIndexedSearch(target, ['login', 'para-code'], undefined),
			missing: paradisCombineIndexedSearch(target, terms, { terms: [0], matchCount: 1, snippet: 'para-code' }),
		}, {
			mixed: { catalogId: 'c-a', matchCount: 3, snippet: 'バグ修正の話', source: 'conversation' },
			metadataOnly: { catalogId: 'c-a', matchCount: 0, snippet: '', source: 'metadata' },
			missing: undefined,
		});
	});
});
