/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 統合のモーダルの左のナビの項目。どの領域も同じ見た目になるよう、領域はこの関数でナビを描く。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

const $ = dom.$;

/** ナビの見出し（項目のまとまりの名前）。 */
export function paradisHubNavCaption(nav: HTMLElement, text: string): HTMLElement {
	const caption = dom.append(nav, $('.phub-nav-caption'));
	caption.textContent = text;
	return caption;
}

export interface IParadisHubNavItemOptions {
	readonly icon?: ThemeIcon;
	/** 別の領域へ移る項目（右に矢印を出す）。 */
	readonly external?: boolean;
}

export interface IParadisHubNavItem {
	readonly element: HTMLElement;
	/** 項目の右の小さな札（検索の当たりの数・状態など）。 */
	readonly chip: HTMLElement;
	setActive(active: boolean): void;
}

/** ナビの項目。押したときの動きは呼び出し側が `element` に付ける。 */
export function paradisHubNavItem(nav: HTMLElement, label: string, options: IParadisHubNavItemOptions = {}): IParadisHubNavItem {
	const element = dom.append(nav, $('.phub-nav-item'));
	element.setAttribute('role', 'button');
	element.tabIndex = 0;
	if (options.icon) {
		element.appendChild($(`span.phub-nav-icon${ThemeIcon.asCSSSelector(options.icon)}`));
	}
	dom.append(element, $('span.phub-nav-label')).textContent = label;
	const chip = dom.append(element, $('span.phub-nav-chip'));
	if (options.external) {
		element.appendChild($(`span.phub-nav-external${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
	}
	return {
		element,
		chip,
		setActive: active => {
			element.classList.toggle('active', active);
			element.setAttribute('aria-current', active ? 'true' : 'false');
		},
	};
}
