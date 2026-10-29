/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisShouldSendHeldApprovalNotify } from '../../common/paradisCodexApprovalHold.js';

suite('paradisCodexApprovalHold', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('drops a held approval notification only when the approval settled before its card was shown', () => {
		assert.deepStrictEqual({
			shown: paradisShouldSendHeldApprovalNotify({ cardShown: true, settledWhileHeld: false }),
			shownAfterAnEarlierOneSettled: paradisShouldSendHeldApprovalNotify({ cardShown: true, settledWhileHeld: true }),
			settled: paradisShouldSendHeldApprovalNotify({ cardShown: false, settledWhileHeld: true }),
			// カードを作らなかった承認（質問の待ちがある、中身が無い など）は、今までどおり通知する
			neverCarded: paradisShouldSendHeldApprovalNotify({ cardShown: false, settledWhileHeld: false }),
		}, { shown: true, shownAfterAnEarlierOneSettled: true, settled: false, neverCarded: true });
	});
});
