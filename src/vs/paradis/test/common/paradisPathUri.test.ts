/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisResolveExternalPath, paradisWorktreePathFromGitdir } from '../../common/paradisPathUri.js';

suite('ParadisPathUri', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves external paths into the namespace of the base resource', () => {
		const local = URI.file('/repo');
		const localWindows = URI.file('C:/repo');
		const wsl = URI.parse('file://wsl.localhost/Ubuntu/home/u/repo');
		const wslLegacy = URI.parse('file://wsl%24/Ubuntu/home/u/repo');
		const remote = URI.parse('vscode-remote://ssh-remote%2Bhost/home/u/repo');

		const resolve = (base: URI, path: string) => paradisResolveExternalPath(base, path)?.toString() ?? '<undefined>';

		assert.deepStrictEqual([
			// 素のローカルは URI.file と完全に同じ結果でなければならない（永続化キーの互換性）
			resolve(local, '/repo-worktrees/a'),
			resolve(localWindows, 'C:/repo-wt/a'),
			resolve(localWindows, 'C:\\repo-wt\\a'),
			resolve(local, '//server/share/wt'),
			// UNC で開いた WSL リポジトリ: distro 名を補ってから解決する（本件の回帰）
			resolve(wsl, '/home/u/repo-wt/a'),
			resolve(wslLegacy, '/home/u/repo-wt/a'),
			// /mnt/c はドライブに写さず、リポジトリと同じ名前空間に留める
			resolve(wsl, '/mnt/c/dev/wt'),
			// 既に UNC 形で書かれていれば二重に prefix しない (区切りが `\` でも同じ)
			resolve(wsl, '//wsl.localhost/Ubuntu/home/u/wt'),
			resolve(wsl, '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt'),
			resolve(wsl, 'D:/dev/wt'),
			// UNC はホスト名を自分で持つので、リモートの名前空間からも抜ける
			resolve(remote, '//host/share/x'),
			// リモートは scheme と authority を保つ
			resolve(remote, '/home/u/wt'),
			resolve(remote, 'C:/dev/wt'),
			// 相対パスは base からの解決（ここだけが従来の URI.file と結果が変わる領域）
			resolve(local, '../wt'),
			resolve(wsl, '../wt'),
			resolve(local, 'wt'),
			resolve(local, 'C:'),
			// `\foo` は Windows ではドライブのルート基準の絶対パス。base 配下へ繋いではいけない
			resolve(local, '\\foo'),
			resolve(wsl, '\\foo'),
			// 解決できない入力
			resolve(local, '   '),
			resolve(URI.parse('file://share/'), '/home/u/wt'),
		], [
			URI.file('/repo-worktrees/a').toString(),
			URI.file('C:/repo-wt/a').toString(),
			URI.file('C:\\repo-wt\\a').toString(),
			URI.file('//server/share/wt').toString(),
			'file://wsl.localhost/Ubuntu/home/u/repo-wt/a',
			'file://wsl%24/Ubuntu/home/u/repo-wt/a',
			'file://wsl.localhost/Ubuntu/mnt/c/dev/wt',
			'file://wsl.localhost/Ubuntu/home/u/wt',
			'file://wsl.localhost/Ubuntu/home/u/wt',
			// ドライブレターは URI 側で小文字に正規化される
			'file:///d%3A/dev/wt',
			'file://host/share/x',
			'vscode-remote://ssh-remote%2Bhost/home/u/wt',
			'vscode-remote://ssh-remote%2Bhost/c%3A/dev/wt',
			// 相対パスは joinPath が `..` を畳んで解決する
			'file:///wt',
			'file://wsl.localhost/Ubuntu/home/u/wt',
			'file:///repo/wt',
			'file:///repo/C%3A',
			URI.file('\\foo').toString(),
			'file://wsl.localhost/Ubuntu/foo',
			'<undefined>',
			'<undefined>',
		]);
	});

	test('resolves a relative gitdir against the directory holding it', () => {
		// git 2.48 以降の worktree.useRelativePaths は `.git/worktrees/<name>/gitdir` に
		// gitdir ファイル自身からの相対パスを書く。リポジトリを基準にすると階層がずれる。
		const gitdirDir = URI.file('/dev/repo/.git/worktrees/feature');
		const worktreePath = paradisWorktreePathFromGitdir('../../../../feature/.git');

		assert.deepStrictEqual([
			worktreePath,
			paradisResolveExternalPath(gitdirDir, worktreePath!)?.toString(),
		], [
			'../../../../feature',
			'file:///dev/feature',
		]);
	});

	test('strips only the trailing .git from a gitdir pointer', () => {
		assert.deepStrictEqual([
			paradisWorktreePathFromGitdir('/repo-wt/a/.git'),
			// `.github` を含むパスが切り詰められないこと（upstream の最左マッチ由来のバグ）
			paradisWorktreePathFromGitdir('/home/u/.github/wt/.git'),
			// ドットがエスケープされていないと `/agit` にも当たってしまう
			paradisWorktreePathFromGitdir('/home/u/agit/wt/.git'),
			paradisWorktreePathFromGitdir('C:\\repo-wt\\a\\.git'),
			paradisWorktreePathFromGitdir('  /repo-wt/a/.git\r\n'),
			// 破損して複数行になっていても1行目だけを見る（正規表現のバックトラック回避）
			paradisWorktreePathFromGitdir('/repo-wt/a/.git\n/other/.git\n'),
			paradisWorktreePathFromGitdir('/repo-wt/a'),
			paradisWorktreePathFromGitdir(''),
			paradisWorktreePathFromGitdir(`/${'a'.repeat(5000)}/.git`),
		], [
			'/repo-wt/a',
			'/home/u/.github/wt',
			'/home/u/agit/wt',
			'C:\\repo-wt\\a',
			'/repo-wt/a',
			'/repo-wt/a',
			undefined,
			undefined,
			undefined,
		]);
	});
});
