/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PARA_BROWSER_VIEW_CAPTURE_NUDGE_DEADLINE_MS, ParaBrowserViewCaptureNudge, type IParaBrowserViewNudgeWindow } from '../../electron-main/paraBrowserViewFrameNudge.js';

function window(state: { focused: boolean; visible?: boolean; minimized?: boolean }): IParaBrowserViewNudgeWindow {
	return { isDestroyed: () => false, isFocused: () => state.focused, isVisible: () => state.visible ?? true, isMinimized: () => state.minimized ?? false };
}

suite('ParaBrowserViewCaptureNudge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('captures only for an undrawn window, one at a time, and gives up on a capture that never settles', () => {
		let now = 0;
		let captures = 0;
		const nudge = new ParaBrowserViewCaptureNudge(() => now);
		// A capture that never settles (the surface is not drawing).
		const webContents = { capturePage: () => { captures++; return new Promise<never>(() => { }); } } as never;
		const results = [
			nudge.nudge(window({ focused: true }), webContents),
			nudge.nudge(window({ focused: false }), webContents),
			nudge.nudge(window({ focused: true, minimized: true }), webContents),
		];
		// Each later attempt finds the previous capture past its deadline; the third miss in a row stops it.
		for (let attempt = 1; attempt <= 4; attempt++) {
			now = attempt * PARA_BROWSER_VIEW_CAPTURE_NUDGE_DEADLINE_MS;
			results.push(nudge.nudge(window({ focused: false }), webContents));
		}
		assert.deepStrictEqual({ results, captures }, { results: [false, true, false, true, true, false, false], captures: 3 });
	});

	test('a capture that settles resets the count of missed deadlines', async () => {
		let now = 0;
		let settleNext = false;
		const nudge = new ParaBrowserViewCaptureNudge(() => now);
		const webContents = { capturePage: () => settleNext ? Promise.resolve() : new Promise<never>(() => { }) } as never;
		const results: boolean[] = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			now = attempt * PARA_BROWSER_VIEW_CAPTURE_NUDGE_DEADLINE_MS;
			// Every other capture settles, so the misses never reach three in a row.
			settleNext = attempt % 2 === 1;
			results.push(nudge.nudge(window({ focused: false }), webContents));
			await Promise.resolve();
		}
		assert.deepStrictEqual(results, [true, true, true, true, true, true]);
	});
});
