/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { timeout } from '../../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisWorkspacesWindowActivity } from '../../browser/paradisWorkspacesWindowActivity.js';

suite('ParadisWorkspacesWindowActivity', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('blurring to another app or minimizing makes the window inactive, focusing it again makes it active', async () => {
		const harness = store.add(new ActivityHarness());
		const states: boolean[] = [harness.activity.isActive];

		harness.setFocus(false, false);
		await harness.settle();
		states.push(harness.activity.isActive);
		harness.setFocus(true, true);
		await harness.settle();
		states.push(harness.activity.isActive);
		harness.setHidden(true);
		await harness.settle();
		states.push(harness.activity.isActive);

		assert.deepStrictEqual({ states, changes: harness.changes }, { states: [true, false, true, false], changes: 3 });
	});

	// 内蔵ブラウザは別の WebContents なので、そこにフォーカスがあると hasFocus は false になる。OS の前面がこのウィンドウなら止めない
	test('focus inside the embedded browser keeps the window active', async () => {
		const harness = store.add(new ActivityHarness());

		harness.setFocus(false, true);
		await harness.settle();

		assert.deepStrictEqual({ active: harness.activity.isActive, changes: harness.changes }, { active: true, changes: 0 });
	});

	// onDidChangeFocus は同じ値が続くと鳴らない（Event.latch）。ほかのアプリから内蔵ブラウザを直接クリックして戻っても知らせは来ない
	test('returning by clicking the embedded browser is noticed by the periodic recheck', () => runWithFakedTimers({}, async () => {
		const harness = store.add(new ActivityHarness());
		harness.setFocus(false, false);
		await harness.settle();
		const away = harness.activity.isActive;

		harness.setFocus(false, true);
		await harness.settle();
		const rightAfterReturn = harness.activity.isActive;
		await timeout(10_000);
		await harness.settle();

		assert.deepStrictEqual({ away, rightAfterReturn, afterRecheck: harness.activity.isActive }, { away: false, rightAfterReturn: false, afterRecheck: true });
	}));

	test('a window that starts with focus in the embedded browser is checked once and stays active', async () => {
		const harness = store.add(new ActivityHarness(false, true));
		const initial = harness.activity.isActive;
		await harness.settle();

		assert.deepStrictEqual({ initial, settled: harness.activity.isActive }, { initial: false, settled: true });
	});
});

class ActivityHarness implements IDisposable {
	private readonly disposables = new DisposableStore();
	private readonly focusChanges = this.disposables.add(new Emitter<boolean>());
	private readonly visibilityChanges = this.disposables.add(new Emitter<void>());
	private hidden = false;
	readonly activity: ParadisWorkspacesWindowActivity;
	changes = 0;

	constructor(private hasFocus = true, private osFocus = true) {
		const harness = this;
		this.activity = this.disposables.add(new ParadisWorkspacesWindowActivity(
			{
				get hasFocus() { return harness.hasFocus; },
				onDidChangeFocus: this.focusChanges.event,
				hadLastFocus: async () => harness.osFocus,
			},
			{
				get hidden() { return harness.hidden; },
				onDidChange: this.visibilityChanges.event,
			},
		));
		this.disposables.add(this.activity.onDidChange(() => this.changes++));
	}

	/** IHostService と同じく、hasFocus の値が変わったときだけ鳴らす。 */
	setFocus(documentFocus: boolean, osFocus: boolean): void {
		const changed = this.hasFocus !== documentFocus;
		this.hasFocus = documentFocus;
		this.osFocus = osFocus;
		if (changed) {
			this.focusChanges.fire(documentFocus);
		}
	}

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		this.visibilityChanges.fire();
	}

	async settle(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
	}

	dispose(): void {
		this.disposables.dispose();
	}
}
