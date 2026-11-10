/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel・Word とその比較の「変更点」のパネルと解析の札を UI キットの部品で描くための共通の部品。
// 見た目は media/paradisOfficeInspector.css にまとめ、TS には inline の style を書かない。
//  - パネルの面: `PARADIS_OFFICE_CHANGE_PANEL_CLASS`（ポップアップの面。帯の高さの変数の下に浮かべる）
//  - 解析の札: キットのチップ（paradisBadges.css の `paradis-chip`）。長い札は省略記号で切り、title に全文
//  - パネルの中のボタン: 種類の絞り込みはチップ、一覧の行は 28 の行、それ以外はキットの副の小さいボタン

import * as dom from '../../../../base/browser/dom.js';
import { paradisButtonClasses } from '../../../browser/paradisButton.js';
import '../../../browser/paradisBadges.js';
import './media/paradisOfficeInspector.css';

/**
 * 「変更点」のパネルの入れ物に付ける class。ポップアップの面（popup・lineSubtle・角丸 8・影）で、上端は帯の高さ
 * （`--paradis-viewer-toolbar-height`）に合わせる。出し入れは呼ぶ側が `style.display` で行う。
 */
export const PARADIS_OFFICE_CHANGE_PANEL_CLASS = 'paradis-office-change-panel';

/** 札・行の要対応（警告の色）の印。 */
export function markParadisOfficeWarning(element: HTMLElement): void {
	element.classList.add('paradis-chip-warning');
}

/** 解析の札をキットのチップにする。文字はチップの中の 1 行に収め、収まらない分は省略記号にして title に全文を出す。 */
export function styleParadisOfficeChip(item: HTMLElement, text: string): void {
	item.classList.add('paradis-chip', 'paradis-chip-neutral');
	dom.clearNode(item);
	dom.append(item, dom.$('span.paradis-chip-label')).textContent = text;
	item.title = text;
}

/** パネルの中のボタンの種類。 */
export type ParadisOfficeInspectorButtonKind = 'secondary' | 'chip' | 'row';

/** パネルの中のボタン。`chip` は押すと切り替わる絞り込み（`aria-pressed`）、`row` は一覧の 1 行（`aria-current` で選択中）。 */
export function appendParadisOfficeInspectorButton(parent: HTMLElement, label: string, kind: ParadisOfficeInspectorButtonKind = 'secondary'): HTMLButtonElement {
	const button = dom.append(parent, dom.$('button')) as HTMLButtonElement;
	button.type = 'button';
	switch (kind) {
		case 'chip':
			button.classList.add('paradis-chip', 'paradis-chip-neutral', 'paradis-focus-ring');
			break;
		case 'row':
			button.classList.add('paradis-office-inspector-row', 'paradis-focus-ring-inset');
			break;
		default:
			button.classList.add(...paradisButtonClasses('secondary', true));
	}
	button.textContent = label;
	return button;
}
