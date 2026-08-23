/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAllowsHostDrop } from '../../common/paradisRemoteHosts.js';

suite('paradisAllowsHostDrop', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const LOCAL = '';
	const HOST = 'ssh-remote+gpu01';

	test('only accepts a drop when every dragged row lives on a different machine than the target', () => {
		deepStrictEqual([
			// マシンをまたぐ転送 = このビューの本来の用途
			paradisAllowsHostDrop([HOST], LOCAL),
			paradisAllowsHostDrop([LOCAL], HOST),
			paradisAllowsHostDrop([HOST, HOST], LOCAL),
			// 同じマシン内は受けない (エクスプローラーの仕事)
			paradisAllowsHostDrop([LOCAL], LOCAL),
			paradisAllowsHostDrop([HOST], HOST),
			// 両ホストにまたがる複数選択。同じマシンのぶんが混ざっているので受けない
			// (ここを every(同じ) で判定すると、この組合せだけ受理が通ってしまう)
			paradisAllowsHostDrop([LOCAL, HOST], LOCAL),
			paradisAllowsHostDrop([LOCAL, HOST], HOST),
			// 掴めた行が無いドロップ (ホスト見出し行だけを掴んだ場合など)
			paradisAllowsHostDrop([], LOCAL),
		], [true, true, true, false, false, false, false, false]);
	});
});
