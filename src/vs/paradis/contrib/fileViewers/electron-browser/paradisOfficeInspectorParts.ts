/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel・Word とその比較の「変更点」のパネルと解析の札を UI キットの部品で描くための共通の部品。
// 見た目は media/paradisOfficeInspector.css にまとめ、TS には inline の style を書かない。
//  - パネルの面: `PARADIS_OFFICE_PANEL_SURFACE_CLASS`（ポップアップの面と、中の見出し・チップの列・行・検索欄の見た目）。
//    帯の下に浮かべる置き場所は別の `PARADIS_OFFICE_CHANGE_PANEL_CLASS`（「変更点」のパネルだけが両方を付ける）
//  - 解析の札: キットのチップ（paradisBadges.css の `paradis-chip`）。長い札は省略記号で切り、title に全文
//  - パネルの中のボタン: 種類の絞り込みはチップ、一覧の行は 28 の行、それ以外はキットの副の小さいボタン

import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { getBaseLayerHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate2.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { paradisButtonClasses } from '../../../browser/paradisButton.js';
import '../../../browser/paradisBadges.js';
import './media/paradisOfficeInspector.css';

/**
 * パネルの見た目の class。ポップアップの面（popup・lineSubtle・角丸 8・影）と、中の見出し（{@link appendParadisOfficePanelHead}）・
 * チップの列・行・検索欄の見た目を持つ。置き場所は持たない（入力規則のパネルなど、置き場所の違う面でも使える）。
 */
export const PARADIS_OFFICE_PANEL_SURFACE_CLASS = 'paradis-office-panel-surface';

/**
 * 「変更点」のパネルの置き場所の class。帯の下（`--paradis-viewer-toolbar-height` ＋ 8）の右に、幅 360 で浮かべる。
 * 出し入れは呼ぶ側が `style.display` で行う。見た目の {@link PARADIS_OFFICE_PANEL_SURFACE_CLASS} と一緒に付ける。
 */
export const PARADIS_OFFICE_CHANGE_PANEL_CLASS = 'paradis-office-change-panel';

/**
 * パネルの見出しの行（題と、`onClose` があれば閉じるボタン）。閉じるボタンを返す（呼ぶ側が押したときの処理をつなぐ）。
 */
export function appendParadisOfficePanelHead(parent: HTMLElement, title: string, closable: boolean): HTMLButtonElement | undefined {
	const head = dom.append(parent, dom.$('.paradis-office-panel-head'));
	dom.append(head, dom.$('strong')).textContent = title;
	if (!closable) {
		return undefined;
	}
	const close = dom.append(head, dom.$('button')) as HTMLButtonElement;
	close.type = 'button';
	close.classList.add(...paradisButtonClasses('icon', true));
	const label = localize('paradis.office.closePanel', "閉じる");
	close.title = label;
	close.setAttribute('aria-label', label);
	dom.append(close, dom.$(ThemeIcon.asCSSSelector(Codicon.close)));
	return close;
}

/** 札・行の要対応（警告の色）の印。 */
export function markParadisOfficeWarning(element: HTMLElement): void {
	element.classList.add('paradis-chip-warning');
}

/** 解析の札をキットのチップにする。文字はチップの中の 1 行に収め、収まらない分は省略記号にして title に全文を出す。 */
export function styleParadisOfficeChip(item: HTMLElement, text: string): void {
	item.classList.add('paradis-chip');
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
			button.classList.add('paradis-chip', 'paradis-focus-ring');
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

/**
 * 一覧の行は 1 行に切って見せるので、全文をホバー（本家のホバーの仕組み）で出す。`store` は行を描き直すときに捨てる物。
 */
export function setParadisOfficeRowHover(row: HTMLElement, text: string, store: DisposableStore): void {
	store.add(getBaseLayerHoverDelegate().setupManagedHover(getDefaultHoverDelegate('mouse'), row, text));
}
