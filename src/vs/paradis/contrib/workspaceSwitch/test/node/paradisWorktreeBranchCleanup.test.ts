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

	test('removing a worktree deletes its merged branch, keeps an unmerged one, and leaves shared branches alone', async () => {
		const merged = addWorktree('merged', ['-b', 'feature/merged']);
		const unmerged = addWorktree('unmerged', ['-b', 'feature/unmerged']);
		await fs.writeFile(join(unmerged, 'a.txt'), 'a');
		git(unmerged, 'add', 'a.txt');
		git(unmerged, 'commit', '-q', '-m', 'work');
		const unmergedSha = git(unmerged, 'rev-parse', 'HEAD').trim();
		const detached = addWorktree('detached', ['--detach']);
		// 追跡先のあるブランチ（共有のブランチ）は、マージ済みでも消さない
		git(repo, 'branch', 'shared');
		git(repo, 'config', 'branch.shared.remote', 'origin');
		const tracking = addWorktree('tracking', [], 'shared');
		// 頼まなければ消さない
		const notAsked = addWorktree('not-asked', ['-b', 'feature/not-asked']);

		const results = [];
		for (const worktreePath of [merged, unmerged, detached, tracking]) {
			results.push(await service.removeWorktree({ repoPath: repo, worktreePath, force: false, deleteBranch: true }));
		}
		results.push(await service.removeWorktree({ repoPath: repo, worktreePath: notAsked, force: false }));

		assert.deepStrictEqual({ results, branches: branches() }, {
			results: [{ deletedBranch: 'feature/merged' }, { keptBranch: { name: 'feature/unmerged', sha: unmergedSha } }, {}, {}, {}],
			branches: ['feature/not-asked', 'feature/unmerged', 'main', 'shared'],
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
		await makeOutput(join(repo, 'node_modules'), old);
		await makeOutput(join(stale, 'node_modules'), old);
		await makeOutput(join(stale, 'out'), old);
		// 無視されていない dist は消さない
		await makeOutput(join(stale, 'dist'), old);
		await makeOutput(join(current, 'node_modules'), old);
		await makeOutput(join(fresh, 'node_modules'), Date.now() / 1000);
		// リンクは辿らない
		await fs.symlink(join(repo, 'node_modules'), join(fresh, 'out'));
		await fs.utimes(join(stale, 'out'), old, old);

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
