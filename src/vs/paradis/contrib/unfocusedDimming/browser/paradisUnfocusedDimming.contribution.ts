/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ウィンドウが非アクティブの間は、フォーカスの無いビューの減光を止める。
//
// Para Code はフォーカスの無いエディタ/ターミナルを薄くする upstream の減光を既定でオンにしている
// （defaultExtensions/browser/paradisDefaultSettings.contribution.ts）。upstream の減光は
// `:not(:focus-within)` で対象を選ぶが、Chromium はウィンドウがフォーカスを失うと、フォーカスを
// 持っていた要素にも `:focus-within` を当てなくなる（`document.activeElement` は残る。Para Code の
// Electron で 2 つのウィンドウを使って実測済み）。そのままだと別のアプリへ切り替えただけで、
// ウィンドウの中身が全部薄くなる。
//
// ウィンドウごとに `document.hasFocus()` を見て `<html>` にクラスを付け、CSS 側で減光を打ち消す。
// 補助ウィンドウ（エディタを別ウィンドウへ出したもの）もそれぞれ別に扱う。IHostService の
// フォーカスはウィンドウ群全体の値なので、メインだけ非アクティブな状態を拾えない。
//
// iframe（Webview）へフォーカスが移ったときは `document.hasFocus()` が true のままなので、
// ここでは何もせず upstream の動きのまま。

import './media/paradisUnfocusedDimming.css';
import { addDisposableListener, EventType, getWindows, onDidRegisterWindow, onDidUnregisterWindow } from '../../../../base/browser/dom.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

/** ウィンドウが非アクティブの間 `<html>` に付けるクラス。CSS 側と同じ名前。 */
export const PARADIS_WINDOW_INACTIVE_CLASS = 'paradis-window-inactive';

/** {@link paradisTrackWindowInactive} が使うウィンドウの部分。`Window` はそのまま渡せる。 */
export interface IParadisFocusTrackedWindow extends EventTarget {
	readonly document: {
		readonly documentElement: HTMLElement;
		hasFocus(): boolean;
	};
}

/** ウィンドウのフォーカスに合わせてクラスを付け外しする。戻り値を dispose すると外して止める。 */
export function paradisTrackWindowInactive(targetWindow: IParadisFocusTrackedWindow): DisposableStore {
	const store = new DisposableStore();
	const root = targetWindow.document.documentElement;
	const update = () => root.classList.toggle(PARADIS_WINDOW_INACTIVE_CLASS, !targetWindow.document.hasFocus());
	update();
	store.add(addDisposableListener(targetWindow, EventType.FOCUS, update));
	store.add(addDisposableListener(targetWindow, EventType.BLUR, update));
	store.add(toDisposable(() => root.classList.remove(PARADIS_WINDOW_INACTIVE_CLASS)));
	return store;
}

class ParadisUnfocusedDimmingWindowFocusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'paradis.unfocusedDimming.windowFocus';

	private readonly perWindow = this._register(new DisposableMap<number, DisposableStore>());

	constructor() {
		super();
		for (const { window } of getWindows()) {
			this.track(window);
		}
		this._register(onDidRegisterWindow(({ window }) => this.track(window)));
		this._register(onDidUnregisterWindow(window => this.perWindow.deleteAndDispose(window.vscodeWindowId)));
	}

	private track(targetWindow: CodeWindow): void {
		if (!this.perWindow.has(targetWindow.vscodeWindowId)) {
			this.perWindow.set(targetWindow.vscodeWindowId, paradisTrackWindowInactive(targetWindow));
		}
	}
}

registerWorkbenchContribution2(ParadisUnfocusedDimmingWindowFocusContribution.ID, ParadisUnfocusedDimmingWindowFocusContribution, WorkbenchPhase.AfterRestored);
