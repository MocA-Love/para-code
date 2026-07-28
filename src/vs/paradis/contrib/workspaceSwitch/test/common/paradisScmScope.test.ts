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
import { paradisIsScmRootInScope } from '../../common/paradisScmScope.js';

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
