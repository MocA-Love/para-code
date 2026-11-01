/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能のサイドパネルを main が断った（エージェントのタブ・共有中のタブ）ときに、その理由を見せる通知（内蔵ブラウザの
// エディタごとに 1 つ）。断りは拡張機能に返るだけで画面には何も出ないので、さっきは開いたのに今は開かない、と見えてしまう。
//  - 見せるのは、このエディタが今出しているタブの分だけ（main の知らせは全部のウィンドウに届く）
//  - 右下に出ている間は、何度押しても重ねて出さない。右下から消えたら（通知センターに残っていても）次はまた出す
//  - 応答不可モードで右下に出ないときは止めない（同じ文の通知は通知センターで 1 つにまとまる）

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { INotificationService, NotificationsFilter, Severity } from '../../../../platform/notification/common/notification.js';
import { IParadisSidePanelRefusal } from '../common/paradisBrowserExtensions.js';

export class ParadisSidePanelRefusalNotice extends Disposable {

	/** 右下に出している通知を見張るもの（出していなければ空）。 */
	private readonly _shown = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
	}

	/** main が断った。`ownViewId` はこのエディタが今出しているタブ。 */
	onRefusal(refusal: IParadisSidePanelRefusal, ownViewId: string | undefined): void {
		if (refusal.viewId !== ownViewId || this._shown.value) {
			return;
		}
		const notice = this._notificationService.notify({
			severity: Severity.Info,
			message: localize('paradis.browserExtensions.sidePanel.refusedNextToAgent', "このタブはエージェントが使っている（共有中の）タブなので、「{0}」のサイドパネルは表示しません。エージェントと共有していないタブで開いてください。", refusal.name),
		});
		if (this._notificationService.getFilter() !== NotificationsFilter.OFF) {
			// 応答不可モード: 右下に出ないので、消えたことも分からない
			return;
		}
		const store = new DisposableStore();
		store.add(notice.onDidClose(() => this.reset()));
		store.add(notice.onDidChangeVisibility(visible => {
			if (!visible) {
				this.reset();
			}
		}));
		this._shown.value = store;
	}

	/** 次の断りでまた出す（右下から消えた・エディタが別のタブに替わった）。出した通知は閉じない。 */
	reset(): void {
		this._shown.clear();
	}
}
