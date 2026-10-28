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
import { ParadisWorkspacesWindowActivity } from '../../browser/paradisWorkspacesWindowActivity.js';

// Web 向けの判定。デスクトップの判定は test/electron-browser/paradisWorkspacesNativeWindowActivity.test.ts
suite('ParadisWorkspacesWindowActivity (web)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('losing focus or hiding the document makes the window inactive, focusing it again makes it active', () => {
		const harness = store.add(new ActivityHarness());
		const states: boolean[] = [harness.activity.isActive];

		harness.setFocus(false);
		states.push(harness.activity.isActive);
		harness.setFocus(true);
		states.push(harness.activity.isActive);
		harness.setHidden(true);
		states.push(harness.activity.isActive);

		assert.deepStrictEqual({ states, changes: harness.changes }, { states: [true, false, true, false], changes: 3 });
	});
});

class ActivityHarness implements IDisposable {
	private readonly disposables = new DisposableStore();
	private readonly focusChanges = this.disposables.add(new Emitter<boolean>());
	private readonly visibilityChanges = this.disposables.add(new Emitter<void>());
	private hasFocus = true;
	private hidden = false;
	readonly activity: ParadisWorkspacesWindowActivity;
	changes = 0;

	constructor() {
		const harness = this;
		this.activity = this.disposables.add(new ParadisWorkspacesWindowActivity(
			{
				get hasFocus() { return harness.hasFocus; },
				onDidChangeFocus: this.focusChanges.event,
			},
			{
				get hidden() { return harness.hidden; },
				onDidChange: this.visibilityChanges.event,
			},
		));
		this.disposables.add(this.activity.onDidChange(() => this.changes++));
	}

	setFocus(hasFocus: boolean): void {
		this.hasFocus = hasFocus;
		this.focusChanges.fire(hasFocus);
	}

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		this.visibilityChanges.fire();
	}

	dispose(): void {
		this.disposables.dispose();
	}
}
