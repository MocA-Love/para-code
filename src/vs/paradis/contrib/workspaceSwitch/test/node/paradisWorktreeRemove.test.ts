/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisWorktreeGitService } from '../../node/paradisWorktreeGitChannel.js';

suite('ParadisWorktreeGitService removeWorktree', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** git の代わり。`respond` が引数ごとの結果を決め、呼ばれた引数と時間切れの指定を記録する。 */
	function removeService(respond: (args: readonly string[]) => { error?: cp.ExecFileException; stdout?: string }, calls: Array<{ args: string[]; timeout: number | undefined }>): ParadisWorktreeGitService {
		const execFile = ((_command: string, args: readonly string[], options: cp.ExecFileOptions, callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void) => {
			calls.push({ args: [...args], timeout: options.timeout });
			const result = respond(args);
			queueMicrotask(() => callback(result.error ?? null, result.stdout ?? '', ''));
			return {} as cp.ChildProcess;
		}) as typeof cp.execFile;
		return new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, execFile, async () => ({}));
	}

	test('gives git worktree remove minutes instead of 30 seconds and says so when it runs out', async () => {
		const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
		const service = removeService(args => args.includes('remove') ? { error: Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGKILL' as NodeJS.Signals }) } : {}, calls);
		await assert.rejects(service.removeWorktree({ repoPath: '/repo', worktreePath: '/repo-worktrees/missing', force: false }), /10/);
		assert.deepStrictEqual(calls.map(call => [call.args.slice(2).join(' '), call.timeout]), [
			['worktree prune', 30_000],
			['worktree remove /repo-worktrees/missing', 600_000],
		]);
	});

	test('deletes a leftover folder that git no longer knows only when forced', async () => {
		const root = join(tmpdir(), `paradis-remove-${generateUuid()}`);
		const leftover = join(root, 'wt');
		await fs.mkdir(join(leftover, 'node_modules', 'pkg'), { recursive: true });
		await fs.writeFile(join(leftover, 'node_modules', 'pkg', 'index.js'), '');
		try {
			const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
			const notAWorktree = Object.assign(new Error('fatal: not a working tree'), { code: 128 });
			const service = removeService(args => args.includes('remove') ? { error: notAWorktree } : args.includes('list') ? { stdout: `worktree ${root}/repo\0HEAD abc\0branch refs/heads/main\0\0` } : {}, calls);
			await assert.rejects(service.removeWorktree({ repoPath: join(root, 'repo'), worktreePath: leftover, force: false }), /not a working tree/);
			const keptWithoutForce = await fs.stat(leftover).then(() => true, () => false);
			await service.removeWorktree({ repoPath: join(root, 'repo'), worktreePath: leftover, force: true });
			const keptWithForce = await fs.stat(leftover).then(() => true, () => false);
			assert.deepStrictEqual({ keptWithoutForce, keptWithForce, ranRemoveWhenForced: calls.filter(call => call.args.includes('remove')).length }, { keptWithoutForce: true, keptWithForce: false, ranRemoveWhenForced: 1 });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('leaves a folder with a .git entry to git even when forced', async () => {
		const root = join(tmpdir(), `paradis-remove-${generateUuid()}`);
		const worktree = join(root, 'wt');
		await fs.mkdir(worktree, { recursive: true });
		await fs.writeFile(join(worktree, '.git'), 'gitdir: /elsewhere\n');
		try {
			const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
			const service = removeService(() => ({}), calls);
			await service.removeWorktree({ repoPath: join(root, 'repo'), worktreePath: worktree, force: true });
			assert.deepStrictEqual({
				kept: await fs.stat(worktree).then(() => true, () => false),
				commands: calls.map(call => call.args.slice(2).join(' ')),
			}, { kept: true, commands: ['worktree prune', `worktree remove --force ${worktree}`] });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
