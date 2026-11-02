/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { MutableDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { startSpreadsheetFollowUpRequest } from '../../electron-browser/paradisSpreadsheetEditor.js';

suite('ParadisSpreadsheetFollowUpRequest', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('survives the end of setInput and is cancelled only by the next load, a cleared input or disposal', () => {
		const slot = store.add(new MutableDisposable<IDisposable>());
		// 本家の editorPanes と同じく、開き終わったら setInput の token を取り消す。
		const operation = new CancellationTokenSource();
		const first = startSpreadsheetFollowUpRequest(slot);
		operation.dispose(true);
		const afterSetInputEnded = first.isCancellationRequested;
		// 次の読み込みは前の依頼を取り消す。
		const second = startSpreadsheetFollowUpRequest(slot);
		const firstAfterNextLoad = first.isCancellationRequested;
		// 別の入力・閉じたとき（clearInput）。
		slot.clear();
		const secondAfterClear = second.isCancellationRequested;
		// エディタを捨てたとき。
		const third = startSpreadsheetFollowUpRequest(slot);
		slot.dispose();
		deepStrictEqual({ afterSetInputEnded, firstAfterNextLoad, secondAfterClear, thirdAfterDispose: third.isCancellationRequested }, {
			afterSetInputEnded: false, firstAfterNextLoad: true, secondAfterClear: true, thirdAfterDispose: true,
		});
	});
});
