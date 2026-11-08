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
import { isWindows } from '../../../../../base/common/platform.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisWorktreeGitService } from '../../node/paradisWorktreeGitChannel.js';

(isWindows ? suite.skip : suite)('ParadisWorktreeGitService branch and generated output cleanup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let repo: string;
	let service: ParadisWorktreeGitService;

	const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
	const branches = () => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').trim().split('\n').sort();
	/** `options` は作業ツリーのパスの前、`branch` は後ろに付ける（既にあるブランチを開くとき）。 */
	const addWorktree = (name: string, options: string[], branch?: string) => {
		const path = join(root, 'wt', name);
		git(repo, 'worktree', 'add', '-q', ...options, path, ...(branch !== undefined ? [branch] : []));
		return path;
	};

	setup(async () => {
		root = join(tmpdir(), `paradis-branch-${generateUuid()}`);
		repo = join(root, 'repo');
		await fs.mkdir(repo, { recursive: true });
		git(repo, 'init', '-q', '-b', 'main');
		await fs.writeFile(join(repo, '.gitignore'), 'node_modules/\nout/\n');
		await fs.writeFile(join(repo, 'package.json'), '{}');
		git(repo, 'add', '.');
		git(repo, 'commit', '-q', '-m', 'init');
		service = new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, cp.execFile, async () => ({ ...process.env }));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('removing a worktree deletes its merged branch, keeps an unmerged one, and leaves other branches alone', async () => {
		const merged = addWorktree('merged', ['-b', 'feature/merged']);
		const unmerged = addWorktree('unmerged', ['-b', 'feature/unmerged']);
		await fs.writeFile(join(unmerged, 'a.txt'), 'a');
		git(unmerged, 'add', 'a.txt');
		git(unmerged, 'commit', '-q', '-m', 'work');
		const unmergedSha = git(unmerged, 'rev-parse', 'HEAD').trim();
		const detached = addWorktree('detached', ['--detach']);
		// 確認で見せた後に中でブランチを切り替えたら、見せていないブランチは消さない
		const switched = addWorktree('switched', ['-b', 'feature/shown']);
		git(switched, 'switch', '-q', '-c', 'feature/other');
		// 頼まなければ消さない
		const notAsked = addWorktree('not-asked', ['-b', 'feature/not-asked']);

		const results = [];
		for (const [worktreePath, branch] of [[merged, 'feature/merged'], [unmerged, 'feature/unmerged'], [detached, 'HEAD'], [switched, 'feature/shown']]) {
			results.push(await service.removeWorktree({ repoPath: repo, worktreePath, force: false, deleteBranch: branch }));
		}
		results.push(await service.removeWorktree({ repoPath: repo, worktreePath: notAsked, force: false }));

		assert.deepStrictEqual({ results, branches: branches() }, {
			results: [{ deletedBranch: 'feature/merged' }, { keptBranch: { name: 'feature/unmerged', sha: unmergedSha } }, {}, {}, {}],
			branches: ['feature/not-asked', 'feature/other', 'feature/shown', 'feature/unmerged', 'main'],
		});
	});

	test('deletes a branch merged on the remote even when the main checkout is elsewhere, but keeps a pushed unmerged one', async () => {
		const remote = join(root, 'remote.git');
		git(root, 'init', '-q', '--bare', '-b', 'main', remote);
		git(repo, 'remote', 'add', 'origin', remote);
		git(repo, 'push', '-q', '-u', 'origin', 'main');
		git(repo, 'remote', 'set-head', 'origin', 'main');
		const commitIn = async (worktree: string, file: string) => {
			await fs.writeFile(join(worktree, file), file);
			git(worktree, 'add', file);
			git(worktree, 'commit', '-q', '-m', file);
		};
		// 追跡先を付けて push しただけでマージしていないもの（gh pr create の後の形。git の -d なら追跡先と一致するので消してしまう）と、
		// 付けずに push してリモートの main に入ったもの（Para の --no-track のまま）
		const tracked = addWorktree('tracked', ['-b', 'feature/tracked']);
		await commitIn(tracked, 'b.txt');
		git(tracked, 'push', '-q', '-u', 'origin', 'feature/tracked');
		const untracked = addWorktree('untracked', ['-b', 'feature/untracked']);
		await commitIn(untracked, 'c.txt');
		git(untracked, 'push', '-q', 'origin', 'feature/untracked');
		// リモートで main にマージされ、手元は fetch しただけ（元のリポジトリは別のブランチにいて、main も古い）
		git(remote, 'update-ref', 'refs/heads/main', 'refs/heads/feature/untracked');
		git(repo, 'fetch', '-q', 'origin');
		git(repo, 'switch', '-q', '-c', 'elsewhere');
		const trackedSha = git(tracked, 'rev-parse', 'HEAD').trim();
		const results = [
			await service.removeWorktree({ repoPath: repo, worktreePath: tracked, force: false, deleteBranch: 'feature/tracked' }),
			await service.removeWorktree({ repoPath: repo, worktreePath: untracked, force: false, deleteBranch: 'feature/untracked' }),
		];
		assert.deepStrictEqual({ results, branches: branches() }, {
			results: [{ keptBranch: { name: 'feature/tracked', sha: trackedSha } }, { deletedBranch: 'feature/untracked' }],
			branches: ['elsewhere', 'feature/tracked', 'main'],
		});
	});

	test('force deletes only chosen local branches that no worktree has open', async () => {
		git(repo, 'branch', 'kept');
		git(repo, 'branch', 'open-elsewhere');
		addWorktree('open', [], 'open-elsewhere');
		const result = await service.forceDeleteBranches({ repoPath: repo, branches: ['kept', 'open-elsewhere', 'main', 'missing', '-D'] });
		assert.deepStrictEqual({ result, branches: branches() }, {
			result: { deleted: ['kept'], failed: ['open-elsewhere', 'main', 'missing', '-D'] },
			branches: ['main', 'open-elsewhere'],
		});
	});

	test('finds and removes only old, ignored, untracked outputs outside the main checkout and the excluded worktree', async () => {
		const old = Date.now() / 1000 - 40 * 86_400;
		const makeOutput = async (path: string, age: number) => {
			await fs.mkdir(join(path, 'pkg'), { recursive: true });
			await fs.writeFile(join(path, 'pkg', 'index.js'), '');
			await fs.utimes(path, age, age);
		};
		const stale = addWorktree('stale', ['-b', 'stale']);
		const current = addWorktree('current', ['-b', 'current']);
		const fresh = addWorktree('fresh', ['-b', 'fresh']);
		const active = addWorktree('active', ['-b', 'active']);
		await makeOutput(join(repo, 'node_modules'), old);
		await makeOutput(join(stale, 'node_modules'), old);
		await makeOutput(join(stale, 'out'), old);
		// 無視されていない dist は消さない
		await makeOutput(join(stale, 'dist'), old);
		await makeOutput(join(current, 'node_modules'), old);
		await makeOutput(join(fresh, 'node_modules'), Date.now() / 1000);
		// node_modules のフォルダの日付は古くても、今日使っている作業ツリーは候補にしない
		await makeOutput(join(active, 'node_modules'), old);
		// リンクは辿らない
		await fs.symlink(join(repo, 'node_modules'), join(fresh, 'out'));
		await fs.utimes(join(stale, 'out'), old, old);
		// 使っていない作業ツリーかは、作業ツリーごとの git の index の古さで見る（current・fresh は今日使った扱い）
		await fs.utimes(join(repo, '.git', 'worktrees', 'stale', 'index'), old, old);
		await fs.utimes(join(repo, '.git', 'worktrees', 'current', 'index'), old, old);

		const candidates = await service.findGeneratedOutputs({ repoPath: repo, excludePaths: [current] });
		const found = candidates.map(candidate => `${candidate.worktree.endsWith('stale') ? 'stale' : candidate.worktree}/${candidate.rel}`).sort();
		// 探した後に中身が増えた（変わった）ものは消さない
		await fs.writeFile(join(stale, 'out', 'new.js'), '');
		const result = await service.removeGeneratedOutputs({ repoPath: repo, excludePaths: [current], candidates });
		const exists = (path: string) => fs.access(path).then(() => true, () => false);

		assert.deepStrictEqual({
			found,
			counts: { removed: result.removed.length, changed: result.changed.length, failed: result.failed.length },
			left: { staleModules: await exists(join(stale, 'node_modules')), staleOut: await exists(join(stale, 'out')), repoModules: await exists(join(repo, 'node_modules')), currentModules: await exists(join(current, 'node_modules')), dist: await exists(join(stale, 'dist')) },
		}, {
			found: ['stale/node_modules', 'stale/out'],
			counts: { removed: 1, changed: 1, failed: 0 },
			left: { staleModules: false, staleOut: true, repoModules: true, currentModules: true, dist: true },
		});
	});
});
