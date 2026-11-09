/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as dom from '../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { PARADIS_MODAL_BACKDROP_CLASS } from '../../../browser/paradisModal.js';
import './media/paradisQuickInputScrim.css';

/** 幕の要素のクラス。段は `--paradis-z-scrim` (quick input のすぐ下。paradisModal.ts の表)。 */
export const PARADIS_QUICK_INPUT_SCRIM_CLASS = 'paradis-quick-input-scrim';

/**
 * 中央寄りに出る quick input (コマンドパレット・名前の変更など) の下に、作業領域を暗くする幕を敷く (Q593)。
 *
 * - 幕を押すと quick input を閉じるだけで、下のボタンには届かない (押した位置のボタンも一緒に押されていた今までと違う)。
 *   押した瞬間に閉じるが、幕は指を離すまで残して、離したときの click も幕で受ける
 * - fork のモーダルと同じ印 ({@link PARADIS_MODAL_BACKDROP_CLASS}) を付けるので、内蔵ブラウザのネイティブのビューは
 *   開いているあいだ静止画に替わり、幕で一緒に暗くなる (overlayManager.ts)。タイトルバーの小窓は閉じる
 * - 部品の横に出すもの (anchor・overlay) と、他所を押しても閉じない手順の入力 (ignoreFocusOut) には敷かない。
 *   前者は何を選んでいるのかが見えなくなり、後者は幕を押しても閉じないまま画面を塞ぐため
 */
export class ParadisQuickInputScrim extends Disposable {

	static readonly ID = 'workbench.contrib.paradisQuickInputScrim';

	private readonly scrim = this._register(new MutableDisposable<DisposableStore>());
	private element: HTMLElement | undefined;
	/** 幕の上で押されたまま、まだ離されていない。閉じた後も離すまで幕を残す。 */
	private pressed = false;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();
		this._register(this.quickInputService.onShow(() => this.update()));
		this._register(this.quickInputService.onHide(() => {
			if (!this.pressed) {
				this.remove();
			}
		}));
	}

	private update(): void {
		const input = this.quickInputService.currentQuickInput;
		if (!input || input.anchor !== undefined || input.ignoreFocusOut) {
			this.remove();
			return;
		}
		const container = this.layoutService.activeContainer;
		if (this.element?.parentElement === container) {
			return; // 開いたまま中身だけが替わった (コマンドパレットからファイルに移動へ、など)
		}
		this.remove();

		const store = new DisposableStore();
		const element = dom.append(container, dom.$(`.${PARADIS_QUICK_INPUT_SCRIM_CLASS}.${PARADIS_MODAL_BACKDROP_CLASS}`));
		element.setAttribute('aria-hidden', 'true');
		this.element = element;
		store.add(toDisposable(() => {
			element.remove();
			if (this.element === element) {
				this.element = undefined;
			}
		}));
		store.add(dom.addDisposableListener(element, dom.EventType.MOUSE_DOWN, e => {
			// 既定の動きを止めてフォーカスを quick input に残し、閉じるのはここで 1 回だけ
			dom.EventHelper.stop(e, true);
			this.pressed = true;
			const targetWindow = dom.getWindow(element);
			store.add(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_UP, () => {
				// click (幕で受けて捨てる) が配られた後で外す
				disposableTimeout(() => {
					this.pressed = false;
					if (!this.quickInputService.currentQuickInput) {
						this.remove();
					}
				}, 0, store);
			}, true));
			void this.quickInputService.cancel();
		}));
		for (const type of [dom.EventType.CLICK, dom.EventType.DBLCLICK, dom.EventType.CONTEXT_MENU, dom.EventType.MOUSE_UP]) {
			store.add(dom.addDisposableListener(element, type, e => dom.EventHelper.stop(e, true)));
		}
		this.scrim.value = store;
	}

	private remove(): void {
		this.pressed = false;
		this.scrim.clear();
	}
}
