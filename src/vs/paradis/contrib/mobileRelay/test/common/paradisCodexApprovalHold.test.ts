/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisHeldApprovalNotifyAction } from '../../common/paradisCodexApprovalHold.js';

suite('paradisCodexApprovalHold', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('drops a held approval notification only when the approval settled and nothing else is waiting for an answer', () => {
		assert.deepStrictEqual({
			shown: paradisHeldApprovalNotifyAction({ cardShown: true, stillHeld: false, settledWhileHeld: false }),
			// 承認が重なり、先のものは審査が決めたが、後のもの（人の判断が要る）がまだ待たされている → 待ち直す
			laterOneStillHeld: paradisHeldApprovalNotifyAction({ cardShown: false, stillHeld: true, settledWhileHeld: true }),
			// 先のものが決着し、後のもののカードが出ている → 出す
			laterOneShown: paradisHeldApprovalNotifyAction({ cardShown: true, stillHeld: false, settledWhileHeld: true }),
			settled: paradisHeldApprovalNotifyAction({ cardShown: false, stillHeld: false, settledWhileHeld: true }),
			// カードを作らなかった承認（質問の待ちがある、中身が無い など）は、今までどおり通知する
			neverCarded: paradisHeldApprovalNotifyAction({ cardShown: false, stillHeld: false, settledWhileHeld: false }),
		}, { shown: 'send', laterOneStillHeld: 'wait', laterOneShown: 'send', settled: 'drop', neverCarded: 'send' });
	});
});
