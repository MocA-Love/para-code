/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCachedShellEnv } from '../../../../../platform/shell/node/paradisCachedShellEnv.js';
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
		let resolverCalls = 0;
		const service = new ParadisWorktreeGitService(
			new NullLogService(),
			undefined,
			undefined,
			createExecFile(calls),
			async () => {
				resolverCalls++;
				throw new Error('shell resolution timed out');
			},
		);

		await service.addWorktree({
			repoPath: '/repo',
			worktreePath: '/repo-worktrees/feature-lfs',
			newBranch: 'feature-lfs',
			baseRef: 'main',
		});

		assert.deepStrictEqual({ resolverCalls, paths: calls.map(call => call.env?.PATH) }, {
			resolverCalls: 1,
			paths: [process.env.PATH, process.env.PATH],
		});
	});

	test('retries shell resolution after the failure cooldown', async () => {
		let now = 0;
		let resolverCalls = 0;
		const cachedEnv = new ParadisCachedShellEnv(
			new NullLogService(),
			'ParadisWorktreeGitTest',
			async () => {
				resolverCalls++;
				if (resolverCalls === 1) {
					throw new Error('shell resolution timed out');
				}
				return { PATH: '/resolved/bin' };
			},
			() => now,
		);

		const first = await cachedEnv.getEnv();
		const cachedFallback = await cachedEnv.getEnv();
		now = 5_000;
		const retried = await cachedEnv.getEnv();

		assert.deepStrictEqual({ resolverCalls, first: first.PATH, cached: cachedFallback.PATH, retried: retried.PATH }, {
			resolverCalls: 2,
			first: process.env.PATH,
			cached: process.env.PATH,
			retried: '/resolved/bin',
		});
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

	function createLifecycleService(handler: (command: string, args: readonly string[], options: cp.ExecFileOptions, callback: (error: (cp.ExecFileException & { code?: number }) | null, stdout: string, stderr: string) => void) => void): ParadisWorktreeGitService {
		return new ParadisWorktreeGitService(
			new NullLogService(),
			undefined,
			undefined,
			handler as unknown as typeof cp.execFile,
			async () => ({}),
		);
	}

	test('runs lifecycle script in worktree with project root environment and a hang-protection timeout', async () => {
		const calls: Array<{ command: string; args: readonly string[]; cwd?: string; root?: string; timeout?: number }> = [];
		const service = createLifecycleService((command, args, options, callback) => {
			calls.push({ command, args, cwd: options.cwd as string, root: (options.env as NodeJS.ProcessEnv | undefined)?.PARACODE_PROJECT_ROOT_PATH, timeout: options.timeout });
			callback(null, '', '');
		});
		await service.runLifecycleScript({
			kind: 'setup', repoPath: '/repo', worktreePath: '/repo-worktrees/task', script: 'bun install'
		});
		assert.deepStrictEqual(calls, [{
			command: process.env.SHELL || '/bin/sh',
			args: ['-lc', 'bun install'],
			cwd: '/repo-worktrees/task',
			root: '/repo',
			timeout: 10 * 60_000
		}]);
	});

	test('rejects a non-zero lifecycle script exit', async () => {
		const service = createLifecycleService((_command, _args, _options, callback) => {
			callback(Object.assign(new Error('exit 7'), { code: 7 }), '', 'failed setup');
		});
		await assert.rejects(
			service.runLifecycleScript({ kind: 'setup', repoPath: '/repo', worktreePath: '/worktree', script: 'false' }),
			/setup スクリプトが失敗しました.*failed setup/
		);
	});

	test('reports a timed-out lifecycle script as timeout instead of a generic failure', async () => {
		const service = createLifecycleService((_command, _args, _options, callback) => {
			// Node は timeout 到達時に子プロセスを kill し、killed=true・code=null のエラーを返す
			callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' as NodeJS.Signals }), '', '');
		});
		await assert.rejects(
			service.runLifecycleScript({ kind: 'teardown', repoPath: '/repo', worktreePath: '/worktree', script: 'sleep infinity' }),
			/teardown スクリプトが 10 分以内に終了しなかった/
		);
	});
});
