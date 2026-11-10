/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアの帯の「読みやすい | 広い | 全幅」。UI キットの切り替えの組（paradisSegmented.ts）で、ズームの左に置く。
// 帯が 420px 以下になったら（container query、paradisViewerToolbar.css）、組を隠して 1 つのボタンに畳み、押すと
// UI キットのメニュー（ContextView。帯の overflow に切られない）で選ぶ。

import * as dom from '../../../../base/browser/dom.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { paradisMenuItem, showParadisMenu } from '../../../browser/paradisMenu.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { PARADIS_MARKDOWN_WIDTHS, ParadisMarkdownWidth } from '../common/paradisMarkdownWidth.js';
import { appendParadisViewerToolbarIconButton, PARADIS_VIEWER_TOOLBAR_FOLDED_CLASS, PARADIS_VIEWER_TOOLBAR_UNFOLDED_CLASS } from './paradisViewerToolbar.js';

/** 帯の組に出す短い名前。 */
function shortLabel(width: ParadisMarkdownWidth): string {
	switch (width) {
		case 'readable': return localize('paradis.markdown.width.readable', "読みやすい");
		case 'wide': return localize('paradis.markdown.width.wide', "広い");
		case 'full': return localize('paradis.markdown.width.full', "全幅");
	}
}

/** title とメニューに出す全文。 */
export function paradisMarkdownWidthTitle(width: ParadisMarkdownWidth): string {
	switch (width) {
		case 'readable': return localize('paradis.markdown.width.readableTitle', "読みやすい幅（882px）");
		case 'wide': return localize('paradis.markdown.width.wideTitle', "広い（1280px）");
		case 'full': return localize('paradis.markdown.width.fullTitle', "全幅（窓いっぱい）");
	}
}

/** 帯の幅の切り替え（組と、狭いときの畳んだボタン）。利用者が選んだときだけ `onDidChoose` を呼ぶ。 */
export class ParadisMarkdownWidthControl extends Disposable {

	private readonly _segmented: ParadisSegmented<ParadisMarkdownWidth>;
	readonly foldButton: HTMLButtonElement;
	private _value: ParadisMarkdownWidth;

	constructor(
		parent: HTMLElement,
		value: ParadisMarkdownWidth,
		private readonly _onDidChoose: (width: ParadisMarkdownWidth) => void,
		private readonly _contextMenuService: IContextMenuService,
	) {
		super();
		this._value = value;
		const ariaLabel = localize('paradis.markdown.width', "本文の幅");
		this._segmented = this._register(new ParadisSegmented<ParadisMarkdownWidth>(parent, {
			ariaLabel,
			value,
			items: PARADIS_MARKDOWN_WIDTHS.map(width => ({ value: width, label: shortLabel(width) })),
		}));
		this._segmented.element.classList.add('paradis-markdown-width', PARADIS_VIEWER_TOOLBAR_UNFOLDED_CLASS);
		for (const width of PARADIS_MARKDOWN_WIDTHS) {
			this._segmented.setItemEnabled(width, true, paradisMarkdownWidthTitle(width));
		}
		this._register(this._segmented.onDidChange(width => this._choose(width)));

		this.foldButton = appendParadisViewerToolbarIconButton(parent, Codicon.arrowBoth, ariaLabel);
		this.foldButton.classList.add(PARADIS_VIEWER_TOOLBAR_FOLDED_CLASS);
		this.foldButton.setAttribute('aria-haspopup', 'menu');
		this.foldButton.setAttribute('aria-expanded', 'false');
		this._register(dom.addDisposableListener(this.foldButton, dom.EventType.CLICK, () => this.showMenu()));
	}

	get value(): ParadisMarkdownWidth {
		return this._value;
	}

	/** いまの幅を出す（`onDidChoose` は呼ばない）。 */
	set value(width: ParadisMarkdownWidth) {
		this._value = width;
		this._segmented.value = width;
	}

	/**
	 * 畳んだボタンのメニュー。いまの幅の行にチェックのアイコンを出す（キットのメニューは行の左を詰めているので、
	 * 本家のチェックの欄は使わずアイコンの欄に出す。ほかの行は同じ幅の空きでそろう）。
	 */
	showMenu(): void {
		this.foldButton.setAttribute('aria-expanded', 'true');
		showParadisMenu(this._contextMenuService, {
			anchor: this.foldButton,
			actions: PARADIS_MARKDOWN_WIDTHS.map(width => {
				const action = toAction({
					id: `paradis.markdown.width.${width}`,
					label: paradisMarkdownWidthTitle(width),
					run: () => this._choose(width),
				});
				return width === this._value ? paradisMenuItem(action, { icon: Codicon.check }) : action;
			}),
			onHide: () => this.foldButton.setAttribute('aria-expanded', 'false'),
		});
	}

	private _choose(width: ParadisMarkdownWidth): void {
		const changed = width !== this._value;
		this.value = width;
		if (changed) {
			this._onDidChoose(width);
		}
	}
}
