/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisNativeWorkspacesWindowActivity } from '../../electron-browser/paradisWorkspacesNativeWindowActivity.js';

const MAIN_WINDOW = 1;
const AUXILIARY_WINDOW = 2;
const OTHER_PARA_CODE_WINDOW = 3;

suite('ParadisNativeWorkspacesWindowActivity', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// Q471 A: ウィンドウが 1 枚でも、ほかのアプリへ移ったら止まる（main からブラーだけが届き、フォーカスはどこにも来ない）
	test('moving to another app stops, and returning to the window resumes', () => {
		const harness = store.add(new NativeActivityHarness());
		const states: boolean[] = [];

		harness.focus.fire(MAIN_WINDOW);
		states.push(harness.activity.isActive);
		harness.blur.fire(MAIN_WINDOW);
		states.push(harness.activity.isActive);
		harness.focus.fire(MAIN_WINDOW);
		states.push(harness.activity.isActive);

		assert.deepStrictEqual({ states, changes: harness.changes }, { states: [true, false, true], changes: 2 });
	});

	// 内蔵ブラウザは同じ BrowserWindow の中なので、ネイティブのフォーカスは動かない（document.hasFocus() は false になる）
	test('focus moving inside the window (embedded browser) or to its auxiliary window keeps it active', () => {
		const harness = store.add(new NativeActivityHarness());
		harness.focus.fire(MAIN_WINDOW);

		harness.blur.fire(MAIN_WINDOW);
		harness.focus.fire(AUXILIARY_WINDOW);
		const inAuxiliary = harness.activity.isActive;
		harness.blur.fire(AUXILIARY_WINDOW);
		harness.focus.fire(OTHER_PARA_CODE_WINDOW);

		assert.deepStrictEqual({ inAuxiliary, inOtherParaCodeWindow: harness.activity.isActive }, { inAuxiliary: true, inOtherParaCodeWindow: false });
	});

	test('before any focus event it counts as active, and minimizing stops it', () => {
		const harness = store.add(new NativeActivityHarness());
		const beforeEvents = harness.activity.isActive;

		harness.setHidden(true);

		assert.deepStrictEqual({ beforeEvents, minimized: harness.activity.isActive }, { beforeEvents: true, minimized: false });
	});
});

class NativeActivityHarness implements IDisposable {
	private readonly disposables = new DisposableStore();
	readonly focus = this.disposables.add(new Emitter<number>());
	readonly blur = this.disposables.add(new Emitter<number>());
	private readonly visibilityChanges = this.disposables.add(new Emitter<void>());
	private hidden = false;
	readonly activity: ParadisNativeWorkspacesWindowActivity;
	changes = 0;

	constructor() {
		const harness = this;
		this.activity = this.disposables.add(new ParadisNativeWorkspacesWindowActivity(
			this.focus.event,
			this.blur.event,
			() => [MAIN_WINDOW, AUXILIARY_WINDOW],
			{
				get hidden() { return harness.hidden; },
				onDidChange: this.visibilityChanges.event,
			},
		));
		this.disposables.add(this.activity.onDidChange(() => this.changes++));
	}

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		this.visibilityChanges.fire();
	}

	dispose(): void {
		this.disposables.dispose();
	}
}
