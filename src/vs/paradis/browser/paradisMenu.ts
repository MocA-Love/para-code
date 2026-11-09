/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 3（Q600）のメニュー。行 28・アイコン付き・消すなどの項目は赤い文字だけ。
//
// 包んでいる本家のファイル（upstream を取り込むときは、ここの差分の「キー・フォーカス・読み上げ」を読む）:
//  - src/vs/platform/contextview/browser/contextMenuHandler.ts（位置・外のクリック・Esc・閉じた後のフォーカスの戻り。
//    shadow DOM は domForShadowRoot を渡したときだけなので、ここでは渡さない＝fork の CSS が届く）
//  - src/vs/base/browser/ui/menu/menu.ts（矢印キー・Enter・読み上げの menuitem。行の高さは CSS の 24 を paradisMenu.css で
//    上書きする。アイコンは fork の PARA-PATCH（`paradis-menu-icon` の付いた項目だけクラスを描く）を使う）
// 色は本家のメニューの色（menu.background など）を inline で書く。キットの paradis.popup・fillSelected は同じキーから
// 作っているので、色は合わせ直さない。`window.menuStyle: native` の人は OS のメニューのまま（アイコンも出ない）。

import './media/paradisMenu.css';
import { StandardMouseEvent } from '../../base/browser/mouseEvent.js';
import { IAction } from '../../base/common/actions.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';

/**
 * menu.ts の PARA-PATCH が見る印（contrib/menuIcons の PARADIS_MENU_ICON_CLASS と同じ値。単体テストで一致を確かめる）。
 * この印の付いた項目だけ、項目のクラス（アイコン）が描かれる。
 */
export const PARADIS_MENU_ITEM_ICON_CLASS = 'paradis-menu-icon';
/** 消す・止めるなど戻せない項目（contrib/menuIcons の PARADIS_MENU_DANGER_CLASS と同じ値）。赤い文字で出る。 */
export const PARADIS_MENU_ITEM_DANGER_CLASS = 'paradis-menu-danger';
/** キットのメニューの入れ物（ContextView）に付くクラス。 */
export const PARADIS_MENU_CLASS = 'paradis-menu';

export interface IParadisMenuItemOptions {
	readonly icon?: ThemeIcon;
	/** 消す・止めるなど戻せない操作。 */
	readonly danger?: boolean;
}

/** メニューの項目にアイコンと危険の印を付ける（`toAction` で作った項目の class を書き換える）。 */
export function paradisMenuItem<T extends IAction>(action: T, options: IParadisMenuItemOptions): T {
	const classes = [PARADIS_MENU_ITEM_ICON_CLASS];
	if (options.icon) {
		classes.push(...ThemeIcon.asClassNameArray(options.icon));
	}
	if (options.danger) {
		classes.push(PARADIS_MENU_ITEM_DANGER_CLASS);
	}
	if (action.class) {
		classes.push(action.class);
	}
	action.class = classes.join(' ');
	return action;
}

export interface IParadisMenuOptions {
	/** 要素の下（または押した位置）に出す。 */
	readonly anchor: HTMLElement | StandardMouseEvent | { readonly x: number; readonly y: number };
	readonly actions: readonly IAction[];
	/** 閉じたとき（選んだときも、外を押したときも）。 */
	readonly onHide?: (didCancel: boolean) => void;
}

/** キットのメニューを開く。中身は本家のコンテキストメニュー（キー・読み上げ・位置は本家のまま）。 */
export function showParadisMenu(contextMenuService: IContextMenuService, options: IParadisMenuOptions): void {
	contextMenuService.showContextMenu({
		getAnchor: () => options.anchor,
		getActions: () => options.actions,
		getMenuClassName: () => PARADIS_MENU_CLASS,
		onHide: options.onHide,
	});
}
