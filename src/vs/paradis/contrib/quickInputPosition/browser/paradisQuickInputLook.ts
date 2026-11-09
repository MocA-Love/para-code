/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 中央のパレットの見た目（UI キットの段 5、Q600。モック mock/ui/kit/palette.html）。見た目は media/paradisQuickInputLook.css、
// 行の高さ 28 は quickInputList.ts の PARA-PATCH 1 点。ここは下端のキーのヒントの 1 行だけを足す。
//
// 包んでいる本家のファイル: src/vs/platform/quickinput/browser/quickInputController.ts（quick input の器。DOM・キー・
// 読み上げは変えない）。ヒントは器の末尾に足す飾りで、読み上げからは隠す（キーの説明は本家の aria のまま）。
// 器は本家が 1 つ作って使い回すので、最初に開いたときに 1 回だけ足す。ウィンドウを移ると器も移る（reparentUI）ので、
// 開くたびに今の器に付いているかを見る。

import './media/paradisQuickInputLook.css';
import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

/** 下端のヒントの要素のクラス。 */
export const PARADIS_QUICK_INPUT_HINT_CLASS = 'paradis-quick-input-hint';

/** 器（`.quick-input-widget`）を、入れ物の直下から探す（本家は入れ物の直下に器を置く）。 */
export function paradisFindQuickInputWidget(container: HTMLElement): HTMLElement | undefined {
	for (const child of container.children) {
		if (dom.isHTMLElement(child) && child.classList.contains('quick-input-widget')) {
			return child;
		}
		// 本家は入れ物の中の 1 段下（quick input の入れ物）に器を置くことがある
		for (const grandchild of child.children) {
			if (dom.isHTMLElement(grandchild) && grandchild.classList.contains('quick-input-widget')) {
				return grandchild;
			}
		}
	}
	return undefined;
}

/** 器の末尾にキーのヒントの 1 行を足す（既にあれば何もしない）。 */
export function paradisEnsureQuickInputHint(widget: HTMLElement): HTMLElement {
	const last = widget.lastElementChild;
	if (dom.isHTMLElement(last) && last.classList.contains(PARADIS_QUICK_INPUT_HINT_CLASS)) {
		return last;
	}
	const hint = dom.append(widget, dom.$(`.${PARADIS_QUICK_INPUT_HINT_CLASS}`));
	hint.setAttribute('aria-hidden', 'true');
	for (const text of [
		// allow-any-unicode-next-line
		localize('paradis.quickInput.hintMove', "↑↓ 移動"),
		// allow-any-unicode-next-line
		localize('paradis.quickInput.hintRun', "Enter 実行"),
		// allow-any-unicode-next-line
		localize('paradis.quickInput.hintClose', "Esc 閉じる"),
	]) {
		dom.append(hint, dom.$('span')).textContent = text;
	}
	return hint;
}

export class ParadisQuickInputLook extends Disposable {

	static readonly ID = 'workbench.contrib.paradisQuickInputLook';

	constructor(
		@IQuickInputService quickInputService: IQuickInputService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super();
		this._register(quickInputService.onShow(() => {
			const widget = paradisFindQuickInputWidget(layoutService.activeContainer);
			if (widget) {
				paradisEnsureQuickInputHint(widget);
			}
		}));
	}
}
