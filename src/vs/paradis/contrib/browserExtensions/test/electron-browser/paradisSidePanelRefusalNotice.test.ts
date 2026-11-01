/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { INotification, INotificationHandle, NoOpNotification, NotificationsFilter } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { ParadisSidePanelRefusalNotice } from '../../electron-browser/paradisSidePanelRefusalNotice.js';

class FakeNotice extends NoOpNotification {
	readonly closeEmitter = new Emitter<void>();
	readonly visibilityEmitter = new Emitter<boolean>();
	override readonly onDidClose = this.closeEmitter.event;
	override readonly onDidChangeVisibility = this.visibilityEmitter.event;
}

class FakeNotificationService extends TestNotificationService {
	readonly shown: FakeNotice[] = [];
	filter = NotificationsFilter.OFF;
	constructor(private readonly _store: DisposableStore) {
		super();
	}
	override notify(_notification: INotification): INotificationHandle {
		const notice = new FakeNotice();
		this._store.add(notice.closeEmitter);
		this._store.add(notice.visibilityEmitter);
		this.shown.push(notice);
		return notice;
	}
	override getFilter(): NotificationsFilter {
		return this.filter;
	}
}

suite('ParadisSidePanelRefusalNotice', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('shows one notice for its own tab while the toast is up, again after it leaves the corner, and never blocks in do-not-disturb', () => {
		const service = store.add(new DisposableStore());
		const notifications = new FakeNotificationService(service);
		const notice = store.add(new ParadisSidePanelRefusalNotice(notifications));
		const refusal = { viewId: 'view-1', name: 'ChatGPT' };
		const counts: number[] = [];
		// ほかのタブ（別のウィンドウ・別のエディタ）の断りは見せない
		notice.onRefusal({ viewId: 'view-2', name: 'ChatGPT' }, 'view-1');
		notice.onRefusal(refusal, undefined);
		counts.push(notifications.shown.length);
		// 右下に出ている間は重ねない
		notice.onRefusal(refusal, 'view-1');
		notifications.shown[0].visibilityEmitter.fire(true);
		notice.onRefusal(refusal, 'view-1');
		counts.push(notifications.shown.length);
		// 右下から消えた（通知センターには残る）: 次はまた出す
		notifications.shown[0].visibilityEmitter.fire(false);
		notice.onRefusal(refusal, 'view-1');
		counts.push(notifications.shown.length);
		// 閉じられた: また出す
		notifications.shown[1].closeEmitter.fire();
		notice.onRefusal(refusal, 'view-1');
		counts.push(notifications.shown.length);
		// エディタが別のタブに替わった: また出す
		notice.reset();
		notice.onRefusal(refusal, 'view-1');
		counts.push(notifications.shown.length);
		// 応答不可モード: 右下に出ないので止めない
		notice.reset();
		notifications.filter = NotificationsFilter.ERROR;
		notice.onRefusal(refusal, 'view-1');
		notice.onRefusal(refusal, 'view-1');
		counts.push(notifications.shown.length);
		assert.deepStrictEqual(counts, [0, 1, 2, 3, 4, 6]);
	});
});
