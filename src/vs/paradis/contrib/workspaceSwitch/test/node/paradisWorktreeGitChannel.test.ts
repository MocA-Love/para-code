/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

import assert from 'assert';
import * as cp from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisWorktreeGitService } from '../../node/paradisWorktreeGitChannel.js';

interface IExecFileCall {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv | undefined;
}

function createExecFile(calls: IExecFileCall[]): typeof cp.execFile {
	return ((command: string, args: readonly string[], options: cp.ExecFileOptions, callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void) => {
		calls.push({ command, args: [...args], env: options.env });
		queueMicrotask(() => callback(null, '', ''));
		return {} as cp.ChildProcess;
	}) as typeof cp.execFile;
}

suite('ParadisWorktreeGitService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs git worktree commands with the resolved shell PATH', async () => {
		const calls: IExecFileCall[] = [];
		const service = new ParadisWorktreeGitService(
			new NullLogService(),
			undefined,
			undefined,
			createExecFile(calls),
			async () => ({ PATH: '/opt/homebrew/bin:/usr/bin', PARADIS_TEST_ENV: 'shell' }),
		);

		await service.addWorktree({
			repoPath: '/repo',
			worktreePath: '/repo-worktrees/feature-lfs',
			newBranch: 'feature-lfs',
			baseRef: 'main',
		});

		assert.deepStrictEqual(calls.map(call => call.command), ['git', 'git']);
		assert.deepStrictEqual(calls.map(call => call.args), [
			['-C', '/repo', 'worktree', 'prune'],
			['-C', '/repo', 'worktree', 'add', '--no-track', '-b', 'feature-lfs', '/repo-worktrees/feature-lfs', 'main'],
		]);
		assert.strictEqual(calls[0].env?.PATH, '/opt/homebrew/bin:/usr/bin');
		assert.strictEqual(calls[1].env?.PATH, '/opt/homebrew/bin:/usr/bin');
		assert.strictEqual(calls[1].env?.PARADIS_TEST_ENV, 'shell');
	});

	test('falls back to the inherited process env when shell resolution fails', async () => {
		const calls: IExecFileCall[] = [];
		const service = new ParadisWorktreeGitService(
			new NullLogService(),
			undefined,
			undefined,
			createExecFile(calls),
			async () => { throw new Error('shell resolution timed out'); },
		);

		await service.addWorktree({
			repoPath: '/repo',
			worktreePath: '/repo-worktrees/feature-lfs',
			newBranch: 'feature-lfs',
			baseRef: 'main',
		});

		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0].env?.PATH, process.env.PATH);
		assert.strictEqual(calls[1].env?.PATH, process.env.PATH);
	});

	test('resolves the shell environment only once and reuses it across execs', async () => {
		const calls: IExecFileCall[] = [];
		let resolverCalls = 0;
		const service = new ParadisWorktreeGitService(
			new NullLogService(),
			undefined,
			undefined,
			createExecFile(calls),
			async () => {
				resolverCalls++;
				return { PATH: '/opt/homebrew/bin:/usr/bin' };
			},
		);

		// prune + add で execFile は2回呼ばれるが、シェル環境の解決は1回だけであるべき
		await service.addWorktree({
			repoPath: '/repo',
			worktreePath: '/repo-worktrees/feature-lfs',
			newBranch: 'feature-lfs',
			baseRef: 'main',
		});
		await service.listBranches('/repo');

		assert.strictEqual(resolverCalls, 1);
		assert.ok(calls.length > 2);
		for (const call of calls) {
			assert.strictEqual(call.env?.PATH, '/opt/homebrew/bin:/usr/bin');
		}
	});
});
