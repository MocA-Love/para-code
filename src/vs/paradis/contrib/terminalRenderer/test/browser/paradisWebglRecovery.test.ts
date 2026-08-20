/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_WEBGL_MAX_RETRIES, PARADIS_WEBGL_RETRY_COOLDOWN, ParadisWebglRecovery, ParadisWebglSupport } from '../../browser/paradisWebglRecovery.js';

suite('ParadisWebglRecovery', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only gives up on the whole window while webgl has never worked', () => {
		const support = new ParadisWebglSupport();
		const beforeAnySuccess = support.shouldDisableGlobally();
		support.noteSucceeded();
		assert.deepStrictEqual(
			{ beforeAnySuccess, afterASuccess: support.shouldDisableGlobally() },
			{ beforeAnySuccess: true, afterASuccess: false },
		);
	});

	test('retries a lost context on focus, spaced out and capped', () => {
		let clock = 1000;
		const recovery = new ParadisWebglRecovery(() => clock);
		const seen: boolean[] = [];

		// 外れていないうちは、いくらフォーカスされても取りに行かない。
		seen.push(recovery.shouldRetryNow());

		recovery.noteLost();
		// 外れた直後の1回目は待たない (見ている端末を待たせる理由が無い)。
		seen.push(recovery.shouldRetryNow());
		// 続けてフォーカスが行き来しても、間隔を空けるまでは断る。
		clock += PARADIS_WEBGL_RETRY_COOLDOWN - 1;
		seen.push(recovery.shouldRetryNow());

		// 間隔が空いた分だけ試し、上限で止まる。
		for (let i = 1; i < PARADIS_WEBGL_MAX_RETRIES + 2; i++) {
			clock += PARADIS_WEBGL_RETRY_COOLDOWN;
			seen.push(recovery.shouldRetryNow());
		}

		assert.deepStrictEqual(seen, [
			false, // 外れていない
			true,  // 外れた直後
			false, // クールダウン中
			true, true, // 上限までの残り (合計3回)
			false, false, // 上限に達したあと
		]);
	});

	test('forgets the lost state once the renderer comes back', () => {
		let clock = 1000;
		const recovery = new ParadisWebglRecovery(() => clock);
		recovery.noteLost();
		for (let i = 0; i < PARADIS_WEBGL_MAX_RETRIES; i++) {
			recovery.shouldRetryNow();
			clock += PARADIS_WEBGL_RETRY_COOLDOWN;
		}
		const exhausted = recovery.shouldRetryNow();

		recovery.noteEnabled();
		recovery.noteLost();
		assert.deepStrictEqual(
			{ exhausted, afterComingBack: recovery.shouldRetryNow() },
			{ exhausted: false, afterComingBack: true },
		);
	});
});
