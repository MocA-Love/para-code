/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisExistingBranchState, paradisExistingBranchSyncAllowed, paradisParseBranchRefs, paradisParseWorktreeBranchUse, paradisPlanExistingBranch, paradisWorktreeBranchArgs } from '../../common/paradisWorktreeExistingBranch.js';

suite('paradisWorktreeExistingBranch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const inUse = { branch: 'b', path: '/repo', main: true };
	const state = (patch: Partial<IParadisExistingBranchState>): IParadisExistingBranchState => ({ ahead: 0, behind: 0, ...patch });

	test('plans how to open the chosen branch', () => {
		assert.deepStrictEqual([
			paradisPlanExistingBranch('local', state({ localSha: 'l' })),
			paradisPlanExistingBranch('local', state({ localSha: 'l', remoteSha: 'r', behind: 3 })),
			paradisPlanExistingBranch('origin', state({ remoteSha: 'r' })),
			paradisPlanExistingBranch('origin', state({ localSha: 'r', remoteSha: 'r' })),
			paradisPlanExistingBranch('origin', state({ localSha: 'l', remoteSha: 'r', ahead: 2 })),
			paradisPlanExistingBranch('origin', state({ localSha: 'l', remoteSha: 'r', behind: 3 })),
			paradisPlanExistingBranch('origin', state({ localSha: 'l', remoteSha: 'r', ahead: 2, behind: 1 })),
			paradisPlanExistingBranch('origin', state({ localSha: 'l', remoteSha: 'r', inUse })),
			paradisPlanExistingBranch('origin', state({ localSha: 'l' })),
			paradisPlanExistingBranch('local', state({ remoteSha: 'r' })),
		], [
			{ kind: 'open', ahead: 0 },
			{ kind: 'open', ahead: 0 },
			{ kind: 'track' },
			{ kind: 'open', ahead: 0 },
			{ kind: 'open', ahead: 2 },
			{ kind: 'behind', behind: 3 },
			{ kind: 'diverged', ahead: 2, behind: 1 },
			{ kind: 'inUse', inUse },
			{ kind: 'missing' },
			{ kind: 'missing' },
		]);
	});

	test('accepts a sync only for the state it is meant for', () => {
		const behind = { kind: 'behind', behind: 1 } as const;
		const diverged = { kind: 'diverged', ahead: 1, behind: 1 } as const;
		assert.deepStrictEqual([
			paradisExistingBranchSyncAllowed(behind, 'fastForward'),
			paradisExistingBranchSyncAllowed(behind, 'reset'),
			paradisExistingBranchSyncAllowed(diverged, 'reset'),
			paradisExistingBranchSyncAllowed(diverged, 'fastForward'),
			paradisExistingBranchSyncAllowed({ kind: 'track' }, 'fastForward'),
			paradisExistingBranchSyncAllowed({ kind: 'track' }, undefined),
		], [true, false, true, false, false, true]);
	});

	test('builds the worktree add and switch arguments shared with the task board', () => {
		assert.deepStrictEqual([
			paradisWorktreeBranchArgs('existing', 'b', '/w', undefined),
			paradisWorktreeBranchArgs('track', 'b', '/w', undefined),
			paradisWorktreeBranchArgs('new', 'b', '/w', 'main'),
			paradisWorktreeBranchArgs('track', 'b', undefined, undefined),
		], [
			['/w', 'b'],
			['--track', '-b', 'b', '/w', 'refs/remotes/origin/b'],
			['--no-track', '-b', 'b', '/w', 'main'],
			['--track', '-c', 'b', 'refs/remotes/origin/b'],
		]);
	});

	test('parses refs and worktree records', () => {
		const refs = paradisParseBranchRefs([
			'refs/heads/main\x001700000000',
			'refs/heads/new\x001700000100',
			'refs/remotes/origin/HEAD\x001700000000',
			'refs/remotes/origin/feature/x\x001700000050',
			'',
		].join('\n'));
		const use = paradisParseWorktreeBranchUse([
			'worktree /repo\0HEAD a\0branch refs/heads/main\0',
			'worktree /wt/x\0HEAD b\0branch refs/heads/x\0',
			'worktree /wt/gone\0HEAD c\0branch refs/heads/gone\0prunable gitdir file points to non-existent location\0',
			'worktree /wt/d\0HEAD d\0detached\0',
			'',
		].join('\0'));
		assert.deepStrictEqual({ refs, use }, {
			refs: {
				local: [{ name: 'new', committedAt: 1700000100000 }, { name: 'main', committedAt: 1700000000000 }],
				remote: [{ name: 'feature/x', committedAt: 1700000050000 }],
			},
			use: [{ branch: 'main', path: '/repo', main: true }, { branch: 'x', path: '/wt/x', main: false }],
		});
	});
});
