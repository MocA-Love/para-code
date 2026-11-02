/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisRemoveWorktreePrepareMessage, ParadisWorktreeRemovalGuard } from '../../common/paradisWorktreeRemoval.js';

suite('paradisWorktreeRemoval', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a second removal of the same worktree is refused while the first runs', () => {
		const guard = new ParadisWorktreeRemovalGuard();
		const first = guard.tryBegin('worktree:a');
		const second = guard.tryBegin('worktree:a');
		const other = guard.tryBegin('worktree:b');
		first?.();
		const afterFirst = guard.tryBegin('worktree:a');
		assert.deepStrictEqual({ first: !!first, second: !!second, other: !!other, afterFirst: !!afterFirst }, { first: true, second: false, other: true, afterFirst: true });
	});

	test('a stopped preparation is explained unless the user cancelled it', () => {
		assert.deepStrictEqual({
			prepared: paradisRemoveWorktreePrepareMessage('prepared', 'feature'),
			cancelled: paradisRemoveWorktreePrepareMessage('cancelled', 'feature'),
			failed: paradisRemoveWorktreePrepareMessage('failed', 'feature'),
		}, {
			prepared: undefined,
			cancelled: undefined,
			failed: 'ワークツリー「feature」の削除を中止しました。このスペースの未保存のエディタを保存できなかったか、閉じられませんでした。保存するか変更を破棄してから、もう一度削除してください。',
		});
	});
});
