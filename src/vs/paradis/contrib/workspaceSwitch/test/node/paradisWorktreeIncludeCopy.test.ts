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
import { IParadisWorktreeIncludeHost, paradisMaterializeWorktreeIncludes, paradisReadWorktreeIncludeDeclarations, paradisRestoreWorktreeLinks, paradisUnlinkRecordedWorktreeLinks } from '../../node/paradisWorktreeIncludeCopy.js';

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
			linkRecordPath: join(root, 'links.json'),
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

	test('reads both declarations, and before removal unlinks only the links it recorded', async () => {
		await fs.writeFile(join(repo, '.paracode.json'), '{ "worktree": { "include": [".env"], "sharedDirectories": [".cache/models", ".env", "node_modules"] } }');
		await fs.writeFile(join(repo, '.worktreeinclude'), '# local\nconfig/secrets.json\n.env\n');
		const declarations = await paradisReadWorktreeIncludeDeclarations(repo);
		await paradisMaterializeWorktreeIncludes(repo, worktree, declarations, host(['.env', 'config/secrets.json', '.cache/models']));
		// 記録に無いリンク（利用者が自分で作ったもの）と、同じ名前の普通のフォルダには触らない
		await fs.mkdir(join(worktree, 'node_modules'));
		await fs.symlink(outside, join(worktree, 'mine'));
		const unlinked = await paradisUnlinkRecordedWorktreeLinks(worktree, join(root, 'links.json'));
		const afterUnlink = (await fs.readdir(worktree)).sort();
		// 削除が断られたら作り直す
		await paradisRestoreWorktreeLinks(worktree, unlinked);
		// 作業ツリーが消えた後は作り直さない（消えたフォルダを mkdir で作らない）
		const gone = join(root, 'repo-worktrees', 'gone');
		await paradisRestoreWorktreeLinks(gone, unlinked);
		const goneRecreated = await fs.access(gone).then(() => true, () => false);

		assert.deepStrictEqual({
			declarations,
			unlinked: unlinked.map(record => record.path),
			afterUnlink,
			restored: await fs.readlink(join(worktree, '.cache', 'models')),
			goneRecreated,
			modelsKept: await fs.readFile(join(repo, '.cache', 'models', 'm.bin'), 'utf8'),
		}, {
			declarations: { include: ['.env', 'config/secrets.json'], sharedDirectories: ['.cache/models', 'node_modules'] },
			unlinked: ['.cache/models'],
			afterUnlink: ['.cache', '.env', 'config', 'mine', 'node_modules'],
			restored: join(repo, '.cache', 'models'),
			goneRecreated: false,
			modelsKept: 'model',
		});
	});

	test('does not link without a place to record the link, and refuses a source that points outside', async () => {
		await fs.writeFile(join(outside, 'shared.env'), 'x');
		await fs.symlink(join(outside, 'shared.env'), join(repo, '.env.shared'));
		const result = await paradisMaterializeWorktreeIncludes(repo, worktree, { include: ['.env.shared'], sharedDirectories: ['.cache/models'] }, host(['.env.shared', '.cache/models'], { linkRecordPath: undefined }));
		assert.deepStrictEqual(result, { copied: [], linked: [], skipped: [{ path: '.env.shared', reason: 'outside' }, { path: '.cache/models', reason: 'unsupported' }] });
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
		// 宣言からリンクを外しても、作ったときの記録から外してから消すので、--force 無しの削除が通る
		await fs.writeFile(join(repo, '.paracode.json'), '{}');
		// 未追跡のファイルがあると git が断る。そのときは外したリンクを作り直す
		await fs.writeFile(join(worktree, 'untracked.txt'), '');
		const refusedRemoval = await service.removeWorktree({ repoPath: repo, worktreePath: worktree, force: false }).then(() => 'removed', () => 'refused');
		const linkAfterRefusal = await fs.readlink(join(worktree, '.cache', 'models'));
		await fs.unlink(join(worktree, 'untracked.txt'));
		await service.removeWorktree({ repoPath: repo, worktreePath: worktree, force: false });

		assert.deepStrictEqual({ result, refusals, refusedRemoval, linkAfterRefusal, removed: await fs.access(worktree).then(() => false, () => true), modelsKept: await fs.readFile(join(repo, '.cache', 'models', 'm.bin'), 'utf8') }, {
			result: { copied: ['.env'], linked: ['.cache/models'], skipped: [{ path: 'README.md', reason: 'notIgnored' }] },
			refusals: ['refused', 'refused'],
			refusedRemoval: 'refused',
			linkAfterRefusal: join(repo, '.cache', 'models'),
			removed: true,
			modelsKept: 'model',
		});
	});
});
