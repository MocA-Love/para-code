/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ファイルビューア（Markdown・HTML・CSV・PDF・Excel・Word とそれぞれの差分）の上に置く共通のバー。
// 高さ 28・エディタの地・下に 1px の線。ボタンは本家の ActionBar と同じ 22px のアイコン、表示の切り替えは
// 本家の検索欄の Aa と同じ Toggle（inputOption）の見た目にする。並びは左に状態（件数・凡例・切り替え）、
// 右に「表示の切り替え → 拡大率 → 前後の移動 → 外部で開く」を区切り線で分けて置く。

import * as dom from '../../../../base/browser/dom.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import './media/paradisViewerToolbar.css';

/** 共通のバーの要素。`start` は左寄せ、`end` は右寄せの置き場。 */
export interface IParadisViewerToolbar {
	readonly element: HTMLElement;
	readonly start: HTMLElement;
	readonly end: HTMLElement;
}

/**
 * 共通のバーを `parent` の末尾に作る。`className` は各ビューアが自分の要素を見分けるために足すクラス
 * （例: `paradis-spreadsheet-header`）。
 */
export function createParadisViewerToolbar(parent: HTMLElement, className: string, ariaLabel?: string): IParadisViewerToolbar {
	const element = dom.append(parent, dom.$(`.paradis-viewer-toolbar.${className}`));
	parent.classList.add('paradis-viewer-toolbar-host');
	element.setAttribute('role', 'toolbar');
	if (ariaLabel) {
		element.setAttribute('aria-label', ariaLabel);
	}
	const start = dom.append(element, dom.$('.paradis-viewer-toolbar-start'));
	const end = dom.append(element, dom.$('.paradis-viewer-toolbar-end'));
	return { element, start, end };
}

/** バーの中の組（間を詰めて並べる）。 */
export function appendParadisViewerToolbarGroup(parent: HTMLElement, className?: string): HTMLElement {
	return dom.append(parent, dom.$(className ? `.paradis-viewer-toolbar-group.${className}` : '.paradis-viewer-toolbar-group'));
}

/** 組と組の間の区切り線。 */
export function appendParadisViewerToolbarSeparator(parent: HTMLElement): HTMLElement {
	const separator = dom.append(parent, dom.$('.paradis-viewer-toolbar-separator'));
	separator.setAttribute('role', 'separator');
	return separator;
}

/** アイコンだけのボタン（本家の ActionBar の項目と同じ 22px）。 */
export function appendParadisViewerToolbarIconButton(parent: HTMLElement, icon: ThemeIcon, title: string): HTMLButtonElement {
	const button = dom.append(parent, dom.$('button.paradis-viewer-toolbar-button')) as HTMLButtonElement;
	button.type = 'button';
	button.title = title;
	button.setAttribute('aria-label', title);
	dom.append(button, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`));
	return button;
}

/** 拡大率を出し、押すと 100% に戻すボタン。 */
export function appendParadisViewerToolbarPercent(parent: HTMLElement, title: string): HTMLButtonElement {
	const button = dom.append(parent, dom.$('button.paradis-viewer-toolbar-percent')) as HTMLButtonElement;
	button.type = 'button';
	button.title = title;
	return button;
}

/**
 * 表示の切り替え（押すとオン・オフが替わる、または複数のうち 1 つを選ぶ）。見た目は本家の Toggle。
 * オンの状態は {@link setParadisViewerToolbarOptionChecked} で付け外す。
 */
export function appendParadisViewerToolbarOption(parent: HTMLElement, label: string, icon?: ThemeIcon): HTMLButtonElement {
	const button = dom.append(parent, dom.$('button.paradis-viewer-toolbar-option')) as HTMLButtonElement;
	button.type = 'button';
	button.setAttribute('aria-pressed', 'false');
	if (icon) {
		dom.append(button, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`));
	}
	dom.append(button, dom.$('span.paradis-viewer-toolbar-option-label')).textContent = label;
	return button;
}

/**
 * 表示の切り替えのオン・オフを付け外す。1 つを選ぶ組の項目（`role="radio"`）は `aria-checked` を、
 * パネルを開け閉めするボタン（`aria-expanded` を持つもの）は `aria-expanded` を、それ以外は `aria-pressed` を合わせる。
 */
export function setParadisViewerToolbarOptionChecked(button: HTMLElement, checked: boolean): void {
	button.classList.toggle('checked', checked);
	const attribute = button.getAttribute('role') === 'radio' ? 'aria-checked' : button.hasAttribute('aria-expanded') ? 'aria-expanded' : 'aria-pressed';
	button.setAttribute(attribute, String(checked));
}

/** 1 つだけを選ぶ組（「プレビュー | ソース」など）。`role="radiogroup"` を付ける。 */
export function appendParadisViewerToolbarChoiceGroup(parent: HTMLElement, className: string, ariaLabel: string): HTMLElement {
	const group = appendParadisViewerToolbarGroup(parent, className);
	group.setAttribute('role', 'radiogroup');
	group.setAttribute('aria-label', ariaLabel);
	return group;
}

/** {@link appendParadisViewerToolbarChoiceGroup} の中の 1 項目（`role="radio"`）。 */
export function appendParadisViewerToolbarChoice(parent: HTMLElement, label: string): HTMLButtonElement {
	const button = appendParadisViewerToolbarOption(parent, label);
	button.removeAttribute('aria-pressed');
	button.setAttribute('role', 'radio');
	button.setAttribute('aria-checked', 'false');
	return button;
}

/**
 * バーの高さ（px）をビューアの根に知らせる。検索の小窓などバーの下に置く物が、高さが変わるバー
 * （Word の解析の結果が折り返すとき）にも合わせられるようにする。
 */
export function setParadisViewerToolbarHeight(root: HTMLElement, height: number): void {
	root.style.setProperty('--paradis-viewer-toolbar-height', `${height}px`);
}

/** パネルを開け閉めする切り替え（「変更点」など）。状態は `aria-expanded` で持つ。 */
export function appendParadisViewerToolbarPanelToggle(parent: HTMLElement, label: string, icon?: ThemeIcon): HTMLButtonElement {
	const button = appendParadisViewerToolbarOption(parent, label, icon);
	button.removeAttribute('aria-pressed');
	button.setAttribute('aria-expanded', 'false');
	return button;
}
