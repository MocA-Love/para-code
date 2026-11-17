/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisHoldTerminalLayout, paradisIsTerminalLayoutHeld, paradisReleaseTerminalLayout } from '../../browser/paradisTerminalLayoutHold.js';

suite('ParadisTerminalLayoutHold', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function terminal(isVisible: boolean, disableLayout = false): ITerminalInstance {
		return upcastPartial<ITerminalInstance>({ isVisible, isDisposed: false, disableLayout });
	}

	function snapshot(...terminals: ITerminalInstance[]): string[] {
		return terminals.map(t => `${t.disableLayout ? 'disabled' : 'enabled'}/${paradisIsTerminalLayoutHeld(t) ? 'held' : 'free'}`);
	}

	test('keeps the layout of a terminal taken out while leaving held until it is opened again', () => {
		// 左右に分けたスペース: 左を外すと右が全幅になり、続けて右も外す。途中で開き直されても戻さない。
		const left = terminal(true);
		const right = terminal(true);
		const hold = paradisHoldTerminalLayout([left, right]);
		const releasedDuringLeave = paradisReleaseTerminalLayout(right);
		const relayout = hold.end([]);
		const afterLeave = snapshot(left, right);
		const reopened = [paradisReleaseTerminalLayout(right), paradisReleaseTerminalLayout(left)];
		assert.deepStrictEqual(
			{ releasedDuringLeave, relayout, afterLeave, reopened, back: snapshot(left, right) },
			{ releasedDuringLeave: false, relayout: false, afterLeave: ['disabled/held', 'disabled/held'], reopened: [true, true], back: ['enabled/free', 'enabled/free'] },
		);
	});

	test('releases the terminals still in an editor when leaving ends and asks for a relayout if one is visible', () => {
		// 切り替えが途中で失敗した、または外さなかったターミナル。止めていた間の layout を受けていない。
		const kept = terminal(true);
		const keptBehind = terminal(false);
		const taken = terminal(false);
		const hold = paradisHoldTerminalLayout([kept, keptBehind, taken]);
		const relayout = hold.end([kept, keptBehind]);
		const after = snapshot(kept, keptBehind, taken);
		paradisReleaseTerminalLayout(taken);
		assert.deepStrictEqual({ relayout, after }, { relayout: true, after: ['enabled/free', 'enabled/free', 'disabled/held'] });
	});

	test('does not ask for a relayout when every terminal still in an editor is hidden', () => {
		const keptBehind = terminal(false);
		const hold = paradisHoldTerminalLayout([keptBehind]);
		assert.deepStrictEqual({ relayout: hold.end([keptBehind]), after: snapshot(keptBehind) }, { relayout: false, after: ['enabled/free'] });
	});

	test('leaves a terminal whose layout someone else disabled alone', () => {
		const panel = terminal(true, true);
		const hold = paradisHoldTerminalLayout([panel]);
		const relayout = hold.end([panel]);
		assert.deepStrictEqual({ relayout, after: snapshot(panel) }, { relayout: false, after: ['disabled/free'] });
	});

	test('keeps holding until the outer leave ends when two leaves overlap', () => {
		const outer = terminal(false);
		const first = paradisHoldTerminalLayout([outer]);
		const second = paradisHoldTerminalLayout([]);
		second.end([outer]);
		const afterInner = snapshot(outer);
		first.end([outer]);
		assert.deepStrictEqual({ afterInner, afterOuter: snapshot(outer) }, { afterInner: ['disabled/held'], afterOuter: ['enabled/free'] });
	});
});
