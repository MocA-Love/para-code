/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisFocusTrackedWindow, PARADIS_WINDOW_INACTIVE_CLASS, paradisTrackWindowInactive } from '../../browser/paradisUnfocusedDimming.contribution.js';

class FakeWindow extends EventTarget implements IParadisFocusTrackedWindow {
	focused = true;
	readonly document = {
		documentElement: mainWindow.document.createElement('html'),
		hasFocus: () => this.focused,
	};
	setFocused(focused: boolean): void {
		this.focused = focused;
		this.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
	}
	get inactive(): boolean {
		return this.document.documentElement.classList.contains(PARADIS_WINDOW_INACTIVE_CLASS);
	}
}

suite('ParadisUnfocusedDimming', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('ウィンドウがフォーカスを失っている間だけクラスを付け、止めたら外す', () => {
		const fake = new FakeWindow();
		fake.focused = false;
		const tracker = store.add(paradisTrackWindowInactive(fake));
		const initial = fake.inactive;
		fake.setFocused(true);
		const afterFocus = fake.inactive;
		fake.setFocused(false);
		const afterBlur = fake.inactive;
		tracker.dispose();
		const afterDispose = fake.inactive;
		fake.setFocused(true);
		fake.setFocused(false);
		const afterDisposeBlur = fake.inactive;

		assert.deepStrictEqual({ initial, afterFocus, afterBlur, afterDispose, afterDisposeBlur }, {
			initial: true,
			afterFocus: false,
			afterBlur: true,
			afterDispose: false,
			afterDisposeBlur: false,
		});
	});
});
