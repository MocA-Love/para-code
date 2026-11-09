/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 1（Q596）: ActionBar の 1 項目（タイトルバーのボタンなど）を、キットのボタンの見た目にする。
//
// 包んでいる本家のファイル（upstream を取り込むときは、ここの差分の「キー・フォーカス・読み上げ」を読む）:
//  - src/vs/base/browser/ui/actionbar/actionViewItems.ts（BaseActionViewItem: 項目の要素、クリック、無効の状態）
//  - src/vs/base/browser/ui/actionbar/actionbar.ts（項目の間の矢印キーの移動、tabindex の受け渡し）
//
// 項目の要素（`li.action-item`）はそのまま使い、中に本家の Button を入れない（タブの止まりが 2 つになり、矢印キーの
// 移動と読み上げが崩れる）。要素にボタンの見た目のクラス（paradisButton.ts）を付け、アイコン・文字・数のバッジを並べる。

import { $, append } from '../../base/browser/dom.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { ParadisCountBadge } from './paradisBadges.js';
import { paradisButtonClasses } from './paradisButton.js';

export interface IParadisActionButtonOptions {
	/** アイコン。codicon、または項目の CSS がマスクで描く 16px の要素のクラス。 */
	readonly icon: ThemeIcon | string;
	/** 文字。省くとアイコンだけの正方形のボタンになり、数は右上に重ねる。 */
	readonly label?: string;
	/** 数のバッジを置くか。 */
	readonly count?: boolean;
}

export interface IParadisActionButtonParts {
	readonly icon: HTMLElement;
	readonly label: HTMLElement | undefined;
	readonly count: ParadisCountBadge | undefined;
}

/**
 * `container` は BaseActionViewItem の render に渡された項目の要素。役目（role="button"）と読み上げの名前は
 * 呼ぶ側が付ける（件数を名前に入れるため）。24px・角丸 6・ポインタを重ねると背景、の素のボタンになる。
 */
export function renderParadisActionButton(container: HTMLElement, options: IParadisActionButtonOptions): IParadisActionButtonParts {
	const iconOnly = options.label === undefined;
	container.classList.add(...paradisButtonClasses(iconOnly ? 'icon' : 'ghost', true), 'paradis-action-button');

	const icon = append(container, $('span.paradis-action-button-icon'));
	if (typeof options.icon === 'string') {
		icon.classList.add(options.icon);
	} else {
		icon.classList.add(...ThemeIcon.asClassNameArray(options.icon));
	}
	icon.setAttribute('aria-hidden', 'true');

	let label: HTMLElement | undefined;
	if (options.label !== undefined) {
		label = append(container, $('span.paradis-action-button-label'));
		label.textContent = options.label;
	}

	const count = options.count ? new ParadisCountBadge(container, iconOnly ? 'overlay' : 'inline') : undefined;
	return { icon, label, count };
}
