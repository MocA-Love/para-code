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
// 「非アクティブ」は**ネイティブのウィンドウ（BrowserWindow）単位**で判定する。`document.hasFocus()`
// では判定しない: 内蔵ブラウザは同じウィンドウの中の別の WebContentsView なので、そこをクリック
// するとワークベンチの document は blur し `hasFocus()` が false になり、同じウィンドウの中なのに
// 減光が全部消える（実機で確認済み）。main が知らせるウィンドウのフォーカス/ブラーは
// BrowserWindow のもので、中の WebContentsView の出入りでは来ない。
//
// 補助ウィンドウ（エディタを別ウィンドウへ出したもの）もそれぞれのネイティブウィンドウとして扱う。
//
// 印は各ウィンドウのワークベンチのコンテナ（`.monaco-workbench`）の `data-` 属性に付ける。`<html>` /
// `<body>` やクラスには付けない: upstream の `auxiliaryWindowService.ts` がメインの `<html>` と `<body>` の
// 属性すべてと、ワークベンチのコンテナの class を補助ウィンドウへ写し続けるので、メインにフォーカスが
// 戻って印が外れると、補助ウィンドウの印まで消える（実機で確認）。コンテナの class 以外は写されない。
// Web ビルドにはこの問題の元（別アプリへの切り替え・内蔵ブラウザ）が無いので、electron-browser に
// だけ置く（Web は upstream の動きのまま）。

import './media/paradisUnfocusedDimming.css';
import { getWindow, getWindows, onDidUnregisterWindow } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

/** ウィンドウが非アクティブの間、ワークベンチのコンテナに付ける属性。CSS 側と同じ名前。 */
export const PARADIS_WINDOW_INACTIVE_ATTRIBUTE = 'data-paradis-window-inactive';

/** 印を付ける相手。 */
export interface IParadisDimmingWindow {
	/** ネイティブのウィンドウ ID（main が知らせるフォーカスの ID と同じもの）。 */
	readonly vscodeWindowId: number;
	/** そのウィンドウのワークベンチのコンテナ（`ILayoutService.getContainer(window)`）。 */
	readonly container: HTMLElement;
}

/**
 * ネイティブのウィンドウのフォーカスに合わせて、各ウィンドウのワークベンチのコンテナに印を付け外しする。
 *
 * フォーカスのあるネイティブウィンドウは同時に1つだけなので、その ID だけを持つ。別のウィンドウへ
 * 移るときはブラーとフォーカスがどちらの順で届いても同じ結果になる。最初のフォーカスが分かるまでは
 * どのウィンドウにも付けない（起動直後に一瞬だけ減光が消えて見えるのを避ける）。
 */
export class ParadisWindowInactiveClasses extends Disposable {

	private readonly windows = new Map<number, IParadisDimmingWindow>();
	private focusedWindowId: number | undefined;
	private known = false;

	constructor(
		onDidFocusWindow: Event<number>,
		onDidBlurWindow: Event<number>,
		initialFocusedWindowId: Promise<number | undefined>,
	) {
		super();
		this._register(onDidFocusWindow(windowId => this.setFocused(windowId)));
		this._register(onDidBlurWindow(windowId => {
			if (!this.known || this.focusedWindowId === windowId) {
				this.setFocused(undefined);
			}
		}));
		initialFocusedWindowId.then(windowId => {
			// 先にイベントが届いていれば、そちらの方が新しい
			if (!this.known && !this._store.isDisposed) {
				this.setFocused(windowId);
			}
		}, () => undefined);
	}

	/** 印を付ける対象に加える。戻り値を dispose すると外して印も消す。 */
	addWindow(targetWindow: IParadisDimmingWindow): IDisposable {
		this.windows.set(targetWindow.vscodeWindowId, targetWindow);
		this.update(targetWindow);
		return toDisposable(() => {
			if (this.windows.get(targetWindow.vscodeWindowId) === targetWindow) {
				this.windows.delete(targetWindow.vscodeWindowId);
			}
			targetWindow.container.removeAttribute(PARADIS_WINDOW_INACTIVE_ATTRIBUTE);
		});
	}

	private setFocused(windowId: number | undefined): void {
		this.known = true;
		this.focusedWindowId = windowId;
		for (const targetWindow of this.windows.values()) {
			this.update(targetWindow);
		}
	}

	private update(targetWindow: IParadisDimmingWindow): void {
		const inactive = this.known && targetWindow.vscodeWindowId !== this.focusedWindowId;
		targetWindow.container.toggleAttribute(PARADIS_WINDOW_INACTIVE_ATTRIBUTE, inactive);
	}
}

class ParadisUnfocusedDimmingWindowFocusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'paradis.unfocusedDimming.windowFocus';

	constructor(
		@INativeHostService nativeHostService: INativeHostService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super();
		const classes = this._register(new ParadisWindowInactiveClasses(
			nativeHostService.onDidFocusMainOrAuxiliaryWindow,
			nativeHostService.onDidBlurMainOrAuxiliaryWindow,
			nativeHostService.getActiveWindowId(),
		));
		const track = (container: HTMLElement): IDisposable => classes.addWindow({ vscodeWindowId: getWindow(container).vscodeWindowId, container });
		// 今あるウィンドウ（復元済みの補助ウィンドウを含む）。閉じたら外す
		const existing = this._register(new DisposableMap<number>());
		for (const { window } of getWindows()) {
			existing.set(window.vscodeWindowId, track(layoutService.getContainer(window)));
		}
		this._register(onDidUnregisterWindow(window => existing.deleteAndDispose(window.vscodeWindowId)));
		// 補助ウィンドウのコンテナ。ウィンドウを閉じると disposables ごと片付く
		this._register(layoutService.onDidAddContainer(({ container, disposables }) => disposables.add(track(container))));
	}
}

registerWorkbenchContribution2(ParadisUnfocusedDimmingWindowFocusContribution.ID, ParadisUnfocusedDimmingWindowFocusContribution, WorkbenchPhase.AfterRestored);
