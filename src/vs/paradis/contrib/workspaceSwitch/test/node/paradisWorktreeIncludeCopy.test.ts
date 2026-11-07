/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import * as cp from 'child_process';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisWorktreeGitService } from '../../node/paradisWorktreeGitChannel.js';
import { IParadisWorktreeIncludeHost, paradisMaterializeWorktreeIncludes, paradisReadWorktreeIncludeDeclarations, paradisUnlinkWorktreeSharedDirectories } from '../../node/paradisWorktreeIncludeCopy.js';

(isWindows ? suite.skip : suite)('Paradis worktree include copy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let repo: string;
	let worktree: string;
	let outside: string;

	/** git の代わり。`ignored` に挙げたパスだけを無視されているものとして返す。 */
	function host(ignored: readonly string[], overrides?: Partial<IParadisWorktreeIncludeHost>): IParadisWorktreeIncludeHost {
		return {
			checkIgnored: async (_repo, paths) => new Set(paths.filter(path => ignored.includes(path))),
			canLink: true,
			directoryLinkType: 'dir',
			...overrides,
		};
	}

	setup(async () => {
		root = join(tmpdir(), `paradis-include-${generateUuid()}`);
		repo = join(root, 'repo');
		worktree = join(root, 'repo-worktrees', 'feature');
		outside = join(root, 'outside');
		await fs.mkdir(join(repo, 'config'), { recursive: true });
		await fs.mkdir(join(repo, '.cache', 'models'), { recursive: true });
		await fs.mkdir(worktree, { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(join(repo, '.env'), 'TOKEN=1');
		await fs.writeFile(join(repo, 'config', 'secrets.json'), '{}');
		await fs.writeFile(join(repo, 'README.md'), 'tracked');
		await fs.writeFile(join(repo, '.cache', 'models', 'm.bin'), 'model');
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('copies ignored files, links ignored folders, and reports what it skipped', async () => {
		await fs.writeFile(join(worktree, '.env.local'), 'already here');
		await fs.writeFile(join(repo, '.env.local'), 'from repo');
		const result = await paradisMaterializeWorktreeIncludes(repo, worktree, {
			include: ['.env', 'config/secrets.json', 'README.md', 'missing.txt', '.env.local'],
			sharedDirectories: ['.cache/models', '.env'],
		}, host(['.env', 'config/secrets.json', '.cache/models', '.env.local']));

		assert.deepStrictEqual({
			result,
			env: await fs.readFile(join(worktree, '.env'), 'utf8'),
			secrets: await fs.readFile(join(worktree, 'config', 'secrets.json'), 'utf8'),
			kept: await fs.readFile(join(worktree, '.env.local'), 'utf8'),
			link: await fs.readlink(join(worktree, '.cache', 'models')),
		}, {
			// 写した .env は既にあるのでリンクにはしない（黙って飛ばす）。追跡しているものは持ち込まない
			result: { copied: ['.env', 'config/secrets.json'], linked: ['.cache/models'], skipped: [{ path: 'README.md', reason: 'notIgnored' }] },
			env: 'TOKEN=1',
			secrets: '{}',
			kept: 'already here',
			link: join(repo, '.cache', 'models'),
		});
	});

	test('refuses links to files, oversized copies and writes through a symlinked folder', async () => {
		// 新しいワークツリーの中の `config` が外を指すリンクだと、写した物が外へ書かれる
		await fs.symlink(outside, join(worktree, 'config'));
		await fs.mkdir(join(repo, 'big'));
		await fs.writeFile(join(repo, 'big', 'a'), 'x'.repeat(64));
		const result = await paradisMaterializeWorktreeIncludes(repo, worktree, {
			include: ['config/secrets.json', 'big'],
			sharedDirectories: ['.env.example'],
		}, host(['config/secrets.json', 'big', '.env.example'], { maxCopyBytes: 16 }));
		await fs.writeFile(join(repo, '.env.example'), '');
		const linkResult = await paradisMaterializeWorktreeIncludes(repo, worktree, { include: [], sharedDirectories: ['.env.example'] }, host(['.env.example'], { canLink: true }));
		const wslResult = await paradisMaterializeWorktreeIncludes(repo, worktree, { include: [], sharedDirectories: ['.cache/models'] }, host(['.cache/models'], { canLink: false }));

		assert.deepStrictEqual({ result, linkResult, wslResult, outside: await fs.readdir(outside) }, {
			result: { copied: [], linked: [], skipped: [{ path: 'config/secrets.json', reason: 'outside' }, { path: 'big', reason: 'tooLarge' }] },
			linkResult: { copied: [], linked: [], skipped: [{ path: '.env.example', reason: 'notDirectory' }] },
			wslResult: { copied: [], linked: [], skipped: [{ path: '.cache/models', reason: 'unsupported' }] },
			outside: [],
		});
	});

	test('reads both declarations and unlinks only symlinks before removal', async () => {
		await fs.writeFile(join(repo, '.paracode.json'), '{ "worktree": { "include": [".env"], "sharedDirectories": [".cache/models", ".env", "node_modules"] } }');
		await fs.writeFile(join(repo, '.worktreeinclude'), '# local\nconfig/secrets.json\n.env\n');
		const declarations = await paradisReadWorktreeIncludeDeclarations(repo);
		await paradisMaterializeWorktreeIncludes(repo, worktree, declarations, host(['.env', 'config/secrets.json', '.cache/models']));
		await fs.mkdir(join(worktree, 'node_modules'));
		await paradisUnlinkWorktreeSharedDirectories(worktree, declarations.sharedDirectories);

		assert.deepStrictEqual({
			declarations,
			worktree: (await fs.readdir(worktree)).sort(),
			modelsKept: await fs.readFile(join(repo, '.cache', 'models', 'm.bin'), 'utf8'),
		}, {
			declarations: { include: ['.env', 'config/secrets.json'], sharedDirectories: ['.cache/models', 'node_modules'] },
			// リンクは外し、同じ名前の普通のフォルダ（node_modules）は残す。リンク先の中身は消さない
			worktree: ['.cache', '.env', 'config', 'node_modules'],
			modelsKept: 'model',
		});
	});

	test('the git service copies only into a linked worktree of the same repository, with git deciding what is ignored', async () => {
		const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
		await fs.rm(worktree, { recursive: true, force: true });
		await fs.writeFile(join(repo, '.gitignore'), '.env\n.cache/\n');
		await fs.writeFile(join(repo, '.paracode.json'), '{ "worktree": { "include": [".env", "README.md"], "sharedDirectories": [".cache/models"] } }');
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'add', '.gitignore', '.paracode.json', 'README.md');
		git(repo, 'commit', '-q', '-m', 'init');
		git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
		const service = new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, cp.execFile, async () => ({ ...process.env }));

		const result = await service.copyWorktreeIncludes({ repoPath: repo, worktreePath: worktree });
		const refusals = await Promise.all([repo, outside].map(path => service.copyWorktreeIncludes({ repoPath: repo, worktreePath: path }).then(() => 'copied', () => 'refused')));
		// リンクを外してから消すので、--force 無しの削除が通る
		await service.removeWorktree({ repoPath: repo, worktreePath: worktree, force: false });

		assert.deepStrictEqual({ result, refusals, removed: await fs.access(worktree).then(() => false, () => true), modelsKept: await fs.readFile(join(repo, '.cache', 'models', 'm.bin'), 'utf8') }, {
			result: { copied: ['.env'], linked: ['.cache/models'], skipped: [{ path: 'README.md', reason: 'notIgnored' }] },
			refusals: ['refused', 'refused'],
			removed: true,
			modelsKept: 'model',
		});
	});
});
