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
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_REPO_OUTSIDE_KEY, paradisNormalizeRemoteUrl, paradisReadOriginUrl, paradisRepoNameFromRemote } from '../../common/paradisRepoIdentity.js';
import { ParadisRepoIdentityResolver } from '../../node/paradisRepoIdentityResolver.js';

suite('ParadisRepoIdentity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 書き方の違う同じ remote は同じ鍵になる
	test('normalizes the ways a remote URL is written', () => {
		assert.deepStrictEqual([
			'git@github.com:Owner/Repo.git',
			'https://github.com/owner/repo',
			'https://user@GitHub.com/owner/repo.git/',
			'ssh://git@github.com:22/owner/repo.git',
			// 認証情報を埋め込んだ URL も同じ鍵になり、鍵に認証情報が残らない
			'https://x-access-token:ghp_secret@github.com/owner/repo.git',
			'/srv/git/repo.git',
			'',
		].map(paradisNormalizeRemoteUrl), [
			'github.com/owner/repo',
			'github.com/owner/repo',
			'github.com/owner/repo',
			'github.com/owner/repo',
			'github.com/owner/repo',
			'/srv/git/repo',
			undefined,
		]);
	});

	test('reads the origin URL from a git config and the name from a remote URL', () => {
		const config = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://example.com/up/other.git\n[remote "origin"]\n\turl = git@github.com:Owner/Para-Code.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
		assert.deepStrictEqual({
			origin: paradisReadOriginUrl(config),
			none: paradisReadOriginUrl('[core]\n\tbare = false\n'),
			name: paradisRepoNameFromRemote('git@github.com:Owner/Para-Code.git'),
		}, { origin: 'git@github.com:Owner/Para-Code.git', none: undefined, name: 'Para-Code' });
	});

	// 並列のクローンとワークツリーは同じ鍵、remote の無いリポジトリは共通ディレクトリの鍵、git の外は「リポジトリ外」
	test('groups clones of the same remote and worktrees of one repository, and leaves folders outside git apart', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-repo-identity-'));
		try {
			const write = async (path: string, content: string) => {
				await fs.mkdir(join(path, '..'), { recursive: true });
				await fs.writeFile(path, content);
			};
			// 本体と、そのワークツリー
			await write(join(root, 'main', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/owner/repo.git\n');
			await write(join(root, 'main', '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
			await write(join(root, 'feature', '.git'), `gitdir: ${join(root, 'main', '.git', 'worktrees', 'feature')}\n`);
			await fs.mkdir(join(root, 'feature', 'src'), { recursive: true });
			// 別の場所への並列クローン（ssh の書き方）
			await write(join(root, 'clone', '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:Owner/Repo.git\n');
			// remote の無いリポジトリ
			await write(join(root, 'local', '.git', 'config'), '[core]\n\tbare = false\n');
			await fs.mkdir(join(root, 'outside'), { recursive: true });

			const resolver = new ParadisRepoIdentityResolver();
			const identities = await Promise.all(['main', join('feature', 'src'), 'clone', 'local', 'outside'].map(path => resolver.resolve(join(root, path))));
			// 一時フォルダの上に .git があると「リポジトリ外」の確かめにならないので、そのときは外の分だけ比べない
			const tmpInsideGit = (await resolver.resolve(tmpdir())).key !== PARADIS_REPO_OUTSIDE_KEY;
			assert.deepStrictEqual(identities.slice(0, tmpInsideGit ? 4 : 5), [
				{ key: 'remote:github.com/owner/repo', name: 'repo' },
				{ key: 'remote:github.com/owner/repo', name: 'repo' },
				{ key: 'remote:github.com/owner/repo', name: 'Repo' },
				{ key: `git:${join(root, 'local', '.git')}`, name: 'local' },
				{ key: PARADIS_REPO_OUTSIDE_KEY, name: '' },
			].slice(0, tmpInsideGit ? 4 : 5));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
