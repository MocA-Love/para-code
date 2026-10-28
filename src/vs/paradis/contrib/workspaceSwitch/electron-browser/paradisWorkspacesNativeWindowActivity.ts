/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { getWindows } from '../../../../base/browser/dom.js';
import { DomEmitter } from '../../../../base/browser/event.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ParadisNativeWindowFocus } from '../../agentBrowser/electron-browser/paradisNativeWindowFocus.js';
import { IParadisWindowVisibility, IParadisWorkspacesWindowActivity } from '../browser/paradisWorkspacesWindowActivity.js';

/**
 * デスクトップ向けの判定。ネイティブのウィンドウ（BrowserWindow）のフォーカスで決める。
 *
 * `document.hasFocus()` は内蔵ブラウザ（同じウィンドウの中の別の WebContentsView）にフォーカスがあると false になり、
 * `hadLastFocus()`（`getActiveWindowId()`）はほかのアプリが前面でも最後に使った Para Code のウィンドウを返すので、
 * どちらも使わない（paradisNativeWindowFocus.ts の冒頭を参照）。main が知らせるフォーカス/ブラーを追い、このウィンドウと
 * その補助ウィンドウのどれにもフォーカスが無いと分かっている間、または最小化している間だけ「裏にいる」とする。
 * 最初のイベントが届くまでは分からないので、表にいる扱いにする（取り直しを止めない方に倒す）。
 */
export class ParadisNativeWorkspacesWindowActivity extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly focus: ParadisNativeWindowFocus;
	private active: boolean;

	constructor(
		onDidFocusWindow: Event<number>,
		onDidBlurWindow: Event<number>,
		private readonly windowIds: () => Iterable<number>,
		private readonly visibility: IParadisWindowVisibility,
	) {
		super();
		// ParadisNativeWindowFocus の購読より後に判定し直すため、こちらの購読は後に張る
		this.focus = this._register(new ParadisNativeWindowFocus(onDidFocusWindow, onDidBlurWindow));
		this.active = this.compute();
		this._register(onDidFocusWindow(() => this.update()));
		this._register(onDidBlurWindow(() => this.update()));
		this._register(visibility.onDidChange(() => this.update()));
	}

	get isActive(): boolean {
		return this.active;
	}

	private compute(): boolean {
		return !this.visibility.hidden && !this.focus.isAwayFrom(this.windowIds());
	}

	private update(): void {
		const active = this.compute();
		if (this.active !== active) {
			this.active = active;
			this._onDidChange.fire();
		}
	}
}

class ParadisNativeWorkspacesWindowActivityService extends ParadisNativeWorkspacesWindowActivity implements IParadisWorkspacesWindowActivity {
	declare readonly _serviceBrand: undefined;

	constructor(@INativeHostService nativeHostService: INativeHostService) {
		const visibilityChange = new DomEmitter(mainWindow.document, 'visibilitychange');
		super(
			nativeHostService.onDidFocusMainOrAuxiliaryWindow,
			nativeHostService.onDidBlurMainOrAuxiliaryWindow,
			() => Array.from(getWindows(), ({ window }) => window.vscodeWindowId),
			{
				get hidden() { return mainWindow.document.hidden; },
				onDidChange: visibilityChange.event,
			},
		);
		this._register(visibilityChange);
	}
}

// このファイルは browser 層の Web 向けの登録（paradisWorkspacesWindowActivity.ts）を import しているので、
// 必ずそちらより後に登録され、こちらが使われる（同じ ID の登録は後のものが勝つ）
registerSingleton(IParadisWorkspacesWindowActivity, ParadisNativeWorkspacesWindowActivityService, InstantiationType.Delayed);
