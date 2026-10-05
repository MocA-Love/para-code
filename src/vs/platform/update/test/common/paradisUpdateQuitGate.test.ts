/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { paradisPassUpdateQuitGate, paradisSetUpdateQuitGate } from '../../common/paradisUpdateQuitGate.js';

suite('ParadisUpdateQuitGate', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('passes without a gate, follows the gate\'s answer, and keeps updating if the gate fails', async () => {
		const withoutGate = await paradisPassUpdateQuitGate();
		const later = store.add(paradisSetUpdateQuitGate({ confirmBeforeQuitAndInstall: async () => false }));
		const answeredLater = await paradisPassUpdateQuitGate();
		later.dispose();
		const failing = store.add(paradisSetUpdateQuitGate({ confirmBeforeQuitAndInstall: async () => { throw new Error('boom'); } }));
		const failed = await paradisPassUpdateQuitGate();
		failing.dispose();
		assert.deepStrictEqual([withoutGate, answeredLater, failed], [true, false, true]);
	});

	test('a second press while the question is open does not start a second restart', async () => {
		const answer = new DeferredPromise<boolean>();
		let asked = 0;
		const gate = store.add(paradisSetUpdateQuitGate({ confirmBeforeQuitAndInstall: () => { asked++; return answer.p; } }));
		const first = paradisPassUpdateQuitGate();
		const second = paradisPassUpdateQuitGate();
		answer.complete(true);
		const results = [await first, await second, asked];
		gate.dispose();
		assert.deepStrictEqual(results, [true, false, 1]);
	});
});
