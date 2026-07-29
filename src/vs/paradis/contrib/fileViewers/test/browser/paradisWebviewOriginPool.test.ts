/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ParadisWebviewOriginPool } from '../../browser/paradisWebviewOriginPool.js';

suite('ParadisWebviewOriginPool', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// ここで見ているのはスロットの貸し借りだけ。origin の**永続化**は upstream の
	// `WebviewOriginStore` 側の責務で、その `Memento` は root key をキーにした static Map を
	// 持つため、テストごとに storage service を差し替えても2件目以降は最初のものを共有する。
	// 各アサーションが同一プール内の相対比較になっているのはそのため。
	function createPool(): ParadisWebviewOriginPool {
		return new ParadisWebviewOriginPool(disposables.add(new TestStorageService()));
	}

	// これが本題。ビューアを開いて閉じてを繰り返しても origin が増えないこと
	// （origin 1つ＝service worker の登録1つで、登録は消えずにプロファイルへ溜まる）。
	test('reuses the same origin when a viewer is opened again after closing', () => {
		const pool = createPool();
		const first = pool.acquire('markdown');
		first.dispose();
		const second = pool.acquire('markdown');
		second.dispose();
		assert.strictEqual(second.origin, first.origin);
	});

	// 同時に生きている webview は必ず別 origin。ビューア側はシグナルが自分宛かを origin で
	// 照合しているので、ここが重なると白紙検知のウォッチドッグが取り違える。
	test('hands out different origins while both are still open', () => {
		const pool = createPool();
		const store = new DisposableStore();
		const origins = [store.add(pool.acquire('markdown')), store.add(pool.acquire('markdown')), store.add(pool.acquire('markdown'))]
			.map(lease => lease.origin);
		assert.strictEqual(new Set(origins).size, 3);
		store.dispose();
		// 3つとも返したので、次の3つは同じ顔ぶれに戻る（＝登録数は同時に開いた最大数で頭打ち）。
		const reopened = [pool.acquire('markdown'), pool.acquire('markdown'), pool.acquire('markdown')].map(lease => lease.origin);
		assert.deepStrictEqual(new Set(reopened), new Set(origins));
	});

	// 空いた番号から埋め直す。常に増えるだけの採番だと、閉じても登録が減らないのと同じになる。
	test('fills the lowest free slot rather than always taking a fresh one', () => {
		const pool = createPool();
		const first = pool.acquire('markdown');
		const second = pool.acquire('markdown');
		first.dispose();
		const third = pool.acquire('markdown');
		assert.strictEqual(third.origin, first.origin);
		assert.notStrictEqual(third.origin, second.origin);
	});

	test('keeps each viewer type on its own origins', () => {
		const pool = createPool();
		assert.notStrictEqual(pool.acquire('markdown').origin, pool.acquire('html').origin);
	});

	// 二重 dispose でスロットを二度返すと、あとから同じ番号を借りた別のビューアの分まで
	// 解放してしまい、生きている2つが同じ origin を持つ状態が作れてしまう。
	test('ignores a repeated dispose so a live lease is never handed out twice', () => {
		const pool = createPool();
		const first = pool.acquire('markdown');
		first.dispose();
		const second = pool.acquire('markdown');
		first.dispose();
		assert.notStrictEqual(pool.acquire('markdown').origin, second.origin);
	});
});
