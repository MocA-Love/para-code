/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisCloseCleanupQuitGate, paradisShouldStopDescendantsNow, paradisShutdownQuitsApp, PARADIS_CLOSE_CLEANUP_QUIT_HOLD_MS } from '../../common/paradisTerminalCloseCleanupQuit.js';

suite('paradisTerminalCloseCleanupQuit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('終了中だけ止めない。取り消し・時間切れで今までどおり止める側へ戻る', () => {
		let now = 1_000;
		const gate = new ParadisCloseCleanupQuitGate(() => now);
		const decide = () => ({ configured: paradisShouldStopDescendantsNow(true, gate), disabled: paradisShouldStopDescendantsNow(false, gate) });

		const before = decide();
		gate.set(true);
		const quitting = decide();
		now += PARADIS_CLOSE_CLEANUP_QUIT_HOLD_MS - 1;
		const almostExpired = decide();
		now += 1;
		// 下ろしに来なかった印（別のウィンドウが終了を取り消した、アプリより長く生きる pty ホスト等）
		const expired = decide();
		gate.set(true);
		gate.set(false);
		const cancelled = decide();

		assert.deepStrictEqual({ before, quitting, almostExpired, expired, cancelled }, {
			before: { configured: true, disabled: false },
			quitting: { configured: false, disabled: false },
			almostExpired: { configured: false, disabled: false },
			expired: { configured: true, disabled: false },
			cancelled: { configured: true, disabled: false },
		});
	});

	test('QUIT と、macOS 以外で最後のウィンドウを閉じる CLOSE をアプリの終了と見なす', () => {
		const quits = (isQuit: boolean, isClose: boolean, windowCount: number | undefined, isMacintosh: boolean) => paradisShutdownQuitsApp({ isQuit, isClose, windowCount, isMacintosh });

		assert.deepStrictEqual({
			quit: quits(true, false, undefined, true),
			closeLastOnLinux: quits(false, true, 1, false),
			closeOneOfTwoOnLinux: quits(false, true, 2, false),
			closeLastOnMac: quits(false, true, 1, true),
			closeUnknownCount: quits(false, true, undefined, false),
			reload: quits(false, false, 1, false),
		}, {
			quit: true,
			closeLastOnLinux: true,
			closeOneOfTwoOnLinux: false,
			closeLastOnMac: false,
			closeUnknownCount: false,
			reload: false,
		});
	});
});
