/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ファイルビューア（Markdown・HTML・CSV・PDF・Excel・Word とそれぞれの差分）の上に置く共通のバー。
// 高さ 32・エディタの地・下に 1px の線。右のボタンは UI キットのボタン（paradisButton.ts）の 24px で、アイコンだけの物は
// アイコンのボタン、拡大率と表示の切り替え（変更点・入力規則・書式の変更）は素のボタンにし、オンの切り替えは選んだ塗りにする。
// 「プレビュー | ソース」「表 | テキスト」と Markdown の本文の幅は UI キットの切り替えの組（28px）で、それが収まるように帯を 32 にしている。
// 並びは左に状態（件数・凡例・切り替え）、右に「表示の切り替え → 拡大率 → 前後の移動 → 外部で開く」を区切り線で分けて置く。

import * as dom from '../../../../base/browser/dom.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { paradisButtonClasses, ParadisButtonKind } from '../../../browser/paradisButton.js';
import './media/paradisViewerToolbar.css';

/** 帯の高さ（px）。帯の下から始める物（PDF の webview・Word の変更点パネル）はこの値を使う。CSS の `--paradis-height-lg` と同じ。 */
export const PARADIS_VIEWER_TOOLBAR_HEIGHT = 32;

/**
 * 帯の実際の高さ（CSS の値）。帯が折り返して高くなるビューアは {@link setParadisViewerToolbarHeight} で根に知らせ、
 * 知らせていなければ帯の既定の高さ（`--paradis-height-lg`）になる。帯の下に置く物の `top` などに使う。
 */
export const PARADIS_VIEWER_TOOLBAR_HEIGHT_CSS = 'var(--paradis-viewer-toolbar-height, var(--paradis-height-lg))';

/** 帯が広いときだけ出す物（420px 以下で隠す。paradisViewerToolbar.css）。 */
export const PARADIS_VIEWER_TOOLBAR_UNFOLDED_CLASS = 'paradis-viewer-toolbar-unfolded';
/** 帯が 420px 以下のときだけ出す物（畳んだボタン）。 */
export const PARADIS_VIEWER_TOOLBAR_FOLDED_CLASS = 'paradis-viewer-toolbar-folded';

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

/**
 * 帯の中のキットのボタン（24px）。帯は 32 で上下の余白が 4px しかなく、外に描くフォーカスの枠（幅 2・間 2）は帯の
 * `overflow: hidden` で欠けるので、枠はボタンの内側に描く（`paradis-focus-ring-inset`）。
 */
function appendParadisViewerToolbarKitButton(parent: HTMLElement, kind: ParadisButtonKind, className: string): HTMLButtonElement {
	const button = dom.append(parent, dom.$(`button.${className}`)) as HTMLButtonElement;
	button.type = 'button';
	button.classList.add(...paradisButtonClasses(kind, true).filter(name => name !== 'paradis-focus-ring'), 'paradis-focus-ring-inset');
	return button;
}

/** アイコンだけのボタン（UI キットのアイコンのボタンの 24px）。 */
export function appendParadisViewerToolbarIconButton(parent: HTMLElement, icon: ThemeIcon, title: string): HTMLButtonElement {
	const button = appendParadisViewerToolbarKitButton(parent, 'icon', 'paradis-viewer-toolbar-button');
	button.title = title;
	button.setAttribute('aria-label', title);
	dom.append(button, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`));
	return button;
}

/** 拡大率を出し、押すと 100% に戻すボタン（素のボタン、幅 44 以上）。 */
export function appendParadisViewerToolbarPercent(parent: HTMLElement, title: string): HTMLButtonElement {
	const button = appendParadisViewerToolbarKitButton(parent, 'ghost', 'paradis-viewer-toolbar-percent');
	button.title = title;
	return button;
}

/**
 * 表示の切り替え（押すとオン・オフが替わる）。見た目は素のボタンで、オンのときは選んだ塗り。
 * オンの状態は {@link setParadisViewerToolbarOptionChecked} で付け外す。
 */
export function appendParadisViewerToolbarOption(parent: HTMLElement, label: string, icon?: ThemeIcon): HTMLButtonElement {
	const button = appendParadisViewerToolbarKitButton(parent, 'ghost', 'paradis-viewer-toolbar-option');
	button.setAttribute('aria-pressed', 'false');
	if (icon) {
		dom.append(button, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`));
	}
	dom.append(button, dom.$('span.paradis-viewer-toolbar-option-label')).textContent = label;
	return button;
}

/**
 * 表示の切り替えのオン・オフを付け外す。パネルを開け閉めするボタン（`aria-expanded` を持つもの）は `aria-expanded` を、
 * それ以外は `aria-pressed` を合わせる。
 */
export function setParadisViewerToolbarOptionChecked(button: HTMLElement, checked: boolean): void {
	button.classList.toggle('checked', checked);
	const attribute = button.hasAttribute('aria-expanded') ? 'aria-expanded' : 'aria-pressed';
	button.setAttribute(attribute, String(checked));
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
