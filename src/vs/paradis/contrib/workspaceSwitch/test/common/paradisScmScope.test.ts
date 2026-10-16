/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { extUri, extUriIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsScmRootInScope, paradisScmDisplayedParentId } from '../../common/paradisScmScope.js';

suite('ParadisScmScope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const root = (path: string) => URI.file(path);

	test('scopes repositories to the open workspace folders', () => {
		const folders = [root('/repos/para-code')];

		assert.deepStrictEqual([
			// 現在のスペースそのもの
			paradisIsScmRootInScope(root('/repos/para-code'), folders, extUri),
			// スペース配下の worktree / サブリポジトリ
			paradisIsScmRootInScope(root('/repos/para-code/.worktrees/feature'), folders, extUri),
			// 切り替え前のスペース (これが一覧に残っていた)
			paradisIsScmRootInScope(root('/repos/other-space'), folders, extUri),
			// 祖先ディレクトリのリポジトリ (スペースを内包するのでスコープ内)
			paradisIsScmRootInScope(root('/repos'), folders, extUri),
			// 名前が前方一致するだけの別リポジトリ
			paradisIsScmRootInScope(root('/repos/para-code-2'), folders, extUri),
		], [true, true, false, true, false]);
	});

	// メインのリポジトリの中に入れ子で置いたワークツリー A。メインのスペースに A を、A のスペースに
	// メインを出さない（どちらも別のスペース）。入れ子のサブモジュール・独立したリポジトリは今までどおり
	// 外側のスペースに出る。git 拡張の待避の判定 (paradisRepositoryBelongsToFolder) と同じ規則。
	test('keeps a nested worktree and its outer repository in their own spaces only', () => {
		const main = root('/repos/main');
		const worktree = root('/repos/main/.worktrees/a');
		const submodule = root('/repos/main/vendor/sub');
		const nested = root('/repos/main/tools/other');
		const all = [main, worktree, submodule, nested];
		const kinds = new Map([[main, 'repository'], [worktree, 'worktree'], [submodule, 'submodule'], [nested, 'repository']]);
		const inScope = (folder: URI) => all.filter(repository => paradisIsScmRootInScope(repository, [folder], extUri, kinds.get(repository), all)).map(repository => repository.path);

		assert.deepStrictEqual({
			mainSpace: inScope(main),
			worktreeSpace: inScope(worktree),
			// ワークツリーの中のサブフォルダだけを開いたスペースも、そのワークツリーだけ。
			worktreeSubfolder: inScope(root('/repos/main/.worktrees/a/src')),
			// メインの中のサブフォルダだけを開いたスペースは、今までどおりメインに属する。
			mainSubfolder: inScope(root('/repos/main/src')),
			// ワークツリーのリポジトリがまだ登録されていなければ、外側のメインはスコープ内のまま
			// （git 拡張がメインを待避してワークツリーを開くと、登録されて外れる）。
			beforeWorktreeIsKnown: paradisIsScmRootInScope(main, [worktree], extUri, 'repository', [main]),
		}, {
			mainSpace: ['/repos/main', '/repos/main/vendor/sub', '/repos/main/tools/other'],
			worktreeSpace: ['/repos/main/.worktrees/a'],
			worktreeSubfolder: ['/repos/main/.worktrees/a'],
			mainSubfolder: ['/repos/main'],
			beforeWorktreeIsKnown: true,
		});
	});

	test('keeps a worktree in a space whose folder is not a repository', () => {
		// ワークツリーを並べて置くフォルダをスペースにしたときは、中のワークツリーをそのまま出す。
		const worktree = root('/repos/worktrees/b');
		assert.strictEqual(paradisIsScmRootInScope(worktree, [root('/repos/worktrees')], extUri, 'worktree', [root('/repos/main'), worktree]), true);
	});

	test('lists a child repository at the top level when its parent is not in the list', () => {
		const main: { provider: { id: string; parentId?: string } } = { provider: { id: 'main' } };
		const worktree = { provider: { id: 'worktree', parentId: 'main' } };
		assert.deepStrictEqual({
			withParent: paradisScmDisplayedParentId(worktree, [main, worktree]),
			// ワークツリーのスペースでは外側のメインが絞り込みで外れる。親の下にしか並ばないと子ごと消える。
			parentScopedOut: paradisScmDisplayedParentId(worktree, [worktree]),
			topLevel: paradisScmDisplayedParentId(main, [main, worktree]),
		}, { withParent: 'main', parentScopedOut: undefined, topLevel: undefined });
	});

	test('keeps a repository whose subfolder is the workspace folder', () => {
		// リポジトリ内のサブフォルダだけを開いている場合、そのリポジトリはスコープ内
		assert.strictEqual(paradisIsScmRootInScope(root('/repos/para-code'), [root('/repos/para-code/src')], extUri), true);
	});

	test('does not filter when there is nothing to scope to', () => {
		assert.deepStrictEqual([
			// 空ウィンドウ (フォルダ未オープン)
			paradisIsScmRootInScope(root('/repos/para-code'), [], extUri),
			// ファイルシステム上の場所を持たないプロバイダ
			paradisIsScmRootInScope(undefined, [root('/repos/para-code')], extUri),
		], [true, true]);
	});

	test('scopes across multiple workspace folders', () => {
		const folders = [root('/repos/para-code'), root('/repos/mobile')];

		assert.deepStrictEqual([
			paradisIsScmRootInScope(root('/repos/para-code'), folders, extUri),
			paradisIsScmRootInScope(root('/repos/mobile'), folders, extUri),
			paradisIsScmRootInScope(root('/repos/other-space'), folders, extUri),
		], [true, true, false]);
	});

	test('honors the case sensitivity of the given extUri', () => {
		const folders = [root('/repos/Para-Code')];

		assert.deepStrictEqual([
			paradisIsScmRootInScope(root('/repos/para-code'), folders, extUri),
			paradisIsScmRootInScope(root('/repos/para-code'), folders, extUriIgnorePathCase),
		], [false, true]);
	});
});
