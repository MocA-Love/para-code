/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

/**
 * ネイティブのウィンドウ（BrowserWindow）のフォーカスを追う。承認ダイアログを出すときに、
 * Para Code のウィンドウがどれも前面に無い（＝利用者が気付けない）ことを確かめるために使う。
 *
 * `IHostService.hasFocus`（`document.hasFocus()`）は使わない: 内蔵ブラウザは同じウィンドウの中の別の
 * WebContentsView なので、そこを操作している間はウィンドウが前面にあっても false になる
 * （paradisUnfocusedDimming.contribution.ts と同じ理由）。前面にあるウィンドウへ Notify を送ると、
 * Dock のバッジの点（macOS）やタスクバーの点滅（Windows/Linux）がそのウィンドウの次の focus まで残る。
 *
 * main が知らせるフォーカス/ブラーはアプリの全ウィンドウのもの。フォーカスのあるウィンドウは同時に
 * 1つだけなので、その ID だけを持つ。`getActiveWindowId()` は最後に使ったウィンドウへ落ちるので
 * 初期値には使わず、最初のイベントが届くまでは「分からない」とする。
 */
export class ParadisNativeWindowFocus extends Disposable {

	private focusedWindowId: number | undefined;
	private known = false;

	constructor(onDidFocusWindow: Event<number>, onDidBlurWindow: Event<number>) {
		super();
		this._register(onDidFocusWindow(windowId => {
			this.known = true;
			this.focusedWindowId = windowId;
		}));
		this._register(onDidBlurWindow(windowId => {
			// 別のウィンドウへ移るときは、フォーカスとブラーがどちらの順で届いても同じ結果にする
			if (!this.known || this.focusedWindowId === windowId) {
				this.known = true;
				this.focusedWindowId = undefined;
			}
		}));
	}

	/**
	 * 渡したウィンドウのどれにもネイティブのフォーカスが無いと分かっているときだけ true。
	 * まだイベントが1つも届いていない（分からない）ときは false（知らせない方に倒す）。
	 */
	isAwayFrom(windowIds: Iterable<number>): boolean {
		if (!this.known) {
			return false;
		}
		if (this.focusedWindowId === undefined) {
			return true;
		}
		for (const windowId of windowIds) {
			if (windowId === this.focusedWindowId) {
				return false;
			}
		}
		return true;
	}
}
