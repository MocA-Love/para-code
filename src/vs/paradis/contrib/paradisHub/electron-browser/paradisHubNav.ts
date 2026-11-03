/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 統合のモーダルの左のナビの項目。どの領域も同じ見た目になるよう、領域はこの関数でナビを描く。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
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
	// Tab で止まるのは選んでいる項目だけ（ほかへは上下の矢印で移る。器の paradisHubDialog.ts）
	element.tabIndex = -1;
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
			if (active) {
				paradisHubFocusNavItem(nav, element, false);
			}
		},
	};
}

/**
 * ナビの中で Tab が止まる項目を `item` にする（ほかの項目は -1）。`focus` が true ならフォーカスも移す。
 * 選んでいる項目が変わったときと、矢印でフォーカスを移したときに呼ぶ。
 */
export function paradisHubFocusNavItem(nav: HTMLElement, item: HTMLElement, focus = true): void {
	for (const other of paradisHubNavItems(nav)) {
		other.tabIndex = other === item ? 0 : -1;
	}
	if (focus) {
		item.focus();
	}
}

/** ナビの項目（見出しを除く）を上から順に。 */
export function paradisHubNavItems(nav: HTMLElement): HTMLElement[] {
	return [...nav.children].filter((child): child is HTMLElement => dom.isHTMLElement(child) && child.classList.contains('phub-nav-item'));
}

/** スクロールに追従させる節。 */
export interface IParadisHubScrollSpySection {
	readonly id: string;
	readonly element: HTMLElement;
}

export interface IParadisHubScrollSpyOptions {
	/** スクロールする本文。 */
	readonly content: HTMLElement;
	/** 左のナビ。選んだ項目がナビの外に出たら、ナビをスクロールして見える位置へ入れる。 */
	readonly nav: HTMLElement;
	/** 本文の節（上から順）。 */
	readonly sections: readonly IParadisHubScrollSpySection[];
	/** 節のナビの項目。 */
	readonly navItem: (id: string) => HTMLElement | undefined;
	/** スクロールで選ぶ節が変わった。領域はナビの選択を切り替える。 */
	readonly onDidSelect: (id: string) => void;
	/** テストで差し替える。既定は本文のある窓のもの。 */
	readonly intersectionObserver?: typeof IntersectionObserver;
}

/** ナビを押して滑らかにスクロールしている間、選択を変えない時間の上限（`scrollend` が来ないときのため）。 */
const SUPPRESS_TIMEOUT_MS = 1000;

/** 節の上端が本文の上端からこれだけ下にあっても、上端に来たとみなす。 */
const TOP_SLACK_PX = 8;

/** 一番下まで来たとみなす残りの高さ。 */
const BOTTOM_SLACK_PX = 2;

/**
 * 本文のスクロールに合わせて、左のナビの選択を切り替える（設定と通知の領域）。
 *
 * 本文の上端にかかっている（または上端に一番近い）見えている節を選ぶ。一番下まで来たら最後の見えている節を選ぶ。
 * 検索で隠した節は飛ばす。ナビを押して節へスクロールする前に {@link suppress} を呼ぶと、スクロールが止まるまで選択を変えない。
 */
export class ParadisHubScrollSpy extends Disposable {

	/** 本文に見えている節（IntersectionObserver が知らせたもの）。 */
	private readonly visible = new Set<HTMLElement>();
	private selected: string | undefined;
	private suppressTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: IParadisHubScrollSpyOptions) {
		super();
		const targetWindow = dom.getWindow(options.content);
		const Observer = options.intersectionObserver ?? targetWindow.IntersectionObserver;
		const observer = new Observer(entries => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					this.visible.add(entry.target as HTMLElement);
				} else {
					this.visible.delete(entry.target as HTMLElement);
				}
			}
			this.update();
		}, { root: options.content, threshold: 0 });
		for (const section of options.sections) {
			observer.observe(section.element);
		}
		this._register({ dispose: () => observer.disconnect() });
		this._register(dom.addDisposableListener(options.content, dom.EventType.SCROLL, () => this.update()));
		// 押した節へのスクロールが止まったら、選択の切り替えを戻す（ここでは選び直さない。下の方の短い節を押したとき、
		// 一番下に着いたことで最後の節へ飛ばないように）
		this._register(dom.addDisposableListener(options.content, 'scrollend', () => this.endSuppress()));
		this._register({ dispose: () => this.endSuppress() });
	}

	/** こちらから節へスクロールする前に呼ぶ。押された節は呼び出し側が選ぶ。 */
	suppress(selected: string): void {
		this.selected = selected;
		this.endSuppress();
		this.suppressTimer = setTimeout(() => this.endSuppress(), SUPPRESS_TIMEOUT_MS);
	}

	private endSuppress(): void {
		if (this.suppressTimer !== undefined) {
			clearTimeout(this.suppressTimer);
			this.suppressTimer = undefined;
		}
	}

	/** いまの位置で選ぶ節を決め、変わっていたら知らせる。 */
	update(): void {
		if (this.suppressTimer !== undefined || this._store.isDisposed) {
			return;
		}
		const id = this.pick();
		if (id === undefined || id === this.selected) {
			return;
		}
		this.selected = id;
		this.options.onDidSelect(id);
		const item = this.options.navItem(id);
		if (item) {
			paradisHubRevealNavItem(this.options.nav, item);
		}
	}

	private pick(): string | undefined {
		const { content } = this.options;
		// 検索で隠した節（display: none）は箱を持たない
		const shown = this.options.sections.filter(section => section.element.getClientRects().length > 0);
		if (shown.length === 0) {
			return undefined;
		}
		if (content.scrollHeight > content.clientHeight && content.scrollTop + content.clientHeight >= content.scrollHeight - BOTTOM_SLACK_PX) {
			return shown[shown.length - 1].id;
		}
		const top = content.getBoundingClientRect().top + TOP_SLACK_PX;
		let picked: IParadisHubScrollSpySection | undefined;
		let firstBelow: IParadisHubScrollSpySection | undefined;
		for (const section of shown) {
			if (!this.visible.has(section.element)) {
				continue;
			}
			if (section.element.getBoundingClientRect().top <= top) {
				picked = section;
			} else {
				firstBelow ??= section;
			}
		}
		return (picked ?? firstBelow)?.id;
	}
}

/**
 * ナビの項目がナビの見えている範囲の外にあれば、ナビだけをスクロールして入れる
 * （`scrollIntoView` はモーダルの外側まで動かすので使わない）。
 */
export function paradisHubRevealNavItem(nav: HTMLElement, item: HTMLElement): void {
	const top = item.getBoundingClientRect().top - nav.getBoundingClientRect().top - nav.clientTop + nav.scrollTop;
	const bottom = top + item.offsetHeight;
	if (top < nav.scrollTop) {
		nav.scrollTop = top;
	} else if (bottom > nav.scrollTop + nav.clientHeight) {
		nav.scrollTop = bottom - nav.clientHeight;
	}
}
