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
		await assert.rejects(service.removeWorktree({ repoPath: '/repo', worktreePath: '/repo-worktrees/missing', force: false }), /ワークツリーの削除が 10 分以内に終わらなかったため打ち切りました/);
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
			// 呼び出し側が一覧にあるワークツリーだと確かめていなければ（allowLeftoverCleanup 無し）、git に任せる
			await assert.rejects(service.removeWorktree({ repoPath: join(root, 'repo'), worktreePath: leftover, force: true }), /not a working tree/);
			const keptWhenUnknown = await fs.stat(leftover).then(() => true, () => false);
			await service.removeWorktree({ repoPath: join(root, 'repo'), worktreePath: leftover, force: true, allowLeftoverCleanup: true });
			const keptWithForce = await fs.stat(leftover).then(() => true, () => false);
			assert.deepStrictEqual({ keptWithoutForce, keptWhenUnknown, keptWithForce, ranRemove: calls.filter(call => call.args.includes('remove')).length }, { keptWithoutForce: true, keptWhenUnknown: true, keptWithForce: false, ranRemove: 2 });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('a folder with a .git entry is never deleted through a leftover-folder request, and git is not asked either', async () => {
		const root = join(tmpdir(), `paradis-remove-${generateUuid()}`);
		const worktree = join(root, 'wt');
		await fs.mkdir(worktree, { recursive: true });
		await fs.writeFile(join(worktree, '.git'), 'gitdir: /elsewhere\n');
		await fs.writeFile(join(worktree, 'uncommitted.txt'), 'work');
		try {
			const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
			const service = removeService(() => ({}), calls);
			await assert.rejects(service.removeWorktree({ repoPath: join(root, 'repo'), worktreePath: worktree, force: true, allowLeftoverCleanup: true }), /削除の途中で残ったフォルダーではない/);
			await assert.rejects(service.removeWorktree({ repoPath: join(root, 'repo'), worktreePath: worktree, force: false, allowLeftoverCleanup: true }), /削除の途中で残ったフォルダーではない/);
			assert.deepStrictEqual({
				kept: await fs.stat(join(worktree, 'uncommitted.txt')).then(() => true, () => false),
				ranRemove: calls.some(call => call.args.includes('remove')),
			}, { kept: true, ranRemove: false });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('a folder reached through a symlink to a listed worktree is not treated as a leftover', async () => {
		const root = join(tmpdir(), `paradis-remove-${generateUuid()}`);
		const real = join(root, 'real-wt');
		const alias = join(root, 'alias-wt');
		await fs.mkdir(real, { recursive: true });
		await fs.writeFile(join(real, 'uncommitted.txt'), 'work');
		await fs.symlink(real, alias, 'dir');
		try {
			const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
			const service = removeService(args => args.includes('list') ? { stdout: `worktree ${real}\0HEAD abc\0branch refs/heads/x\0\0` } : {}, calls);
			await assert.rejects(service.removeWorktree({ repoPath: join(root, 'repo'), worktreePath: alias, force: true, allowLeftoverCleanup: true }), /削除の途中で残ったフォルダーではない/);
			assert.deepStrictEqual({
				kept: await fs.stat(join(real, 'uncommitted.txt')).then(() => true, () => false),
				ranRemove: calls.some(call => call.args.includes('remove')),
			}, { kept: true, ranRemove: false });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('never deletes the repository, a folder above it, or a folder inside a listed worktree', async () => {
		const root = join(tmpdir(), `paradis-remove-${generateUuid()}`);
		const repository = join(root, 'parent', 'repo');
		const listed = join(root, 'other-wt');
		await fs.mkdir(join(repository, 'src'), { recursive: true });
		await fs.mkdir(join(listed, 'node_modules'), { recursive: true });
		try {
			const notAWorktree = Object.assign(new Error('fatal: not a working tree'), { code: 128 });
			const list = `worktree ${repository}\0HEAD abc\0branch refs/heads/main\0\0worktree ${listed}\0HEAD def\0branch refs/heads/x\0\0`;
			const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
			const service = removeService(args => args.includes('remove') ? { error: notAWorktree } : args.includes('list') ? { stdout: list } : {}, calls);
			const targets = { above: join(root, 'parent'), repository, insideRepository: join(repository, 'src'), insideListed: join(listed, 'node_modules') };
			const kept: Record<string, boolean> = {};
			for (const [name, target] of Object.entries(targets)) {
				await assert.rejects(service.removeWorktree({ repoPath: repository, worktreePath: target, force: true, allowLeftoverCleanup: true }), /削除の途中で残ったフォルダーではない/);
				kept[name] = await fs.stat(target).then(() => true, () => false);
			}
			assert.deepStrictEqual({ kept, ranRemove: calls.some(call => call.args.includes('remove')) }, { kept: { above: true, repository: true, insideRepository: true, insideListed: true }, ranRemove: false });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
