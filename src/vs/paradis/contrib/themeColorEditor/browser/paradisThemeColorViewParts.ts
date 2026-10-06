/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタの 2 つのタブ（UI の色・シンタックスの色）で共有する小さな部品。

import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { PARADIS_DEFAULT_COLOR_VALUE } from '../common/paradisThemeColorModel.js';

const $ = dom.$;

/** 色見本。値が無ければ斜線の「なし」を描く。 */
export function paradisSetSwatch(element: HTMLElement, color: string | undefined): void {
	element.classList.toggle('none', !color);
	if (color) {
		element.style.setProperty('--paradis-tce-swatch', color);
	} else {
		element.style.removeProperty('--paradis-tce-swatch');
	}
}

/** 設定の値の表示（`"default"` は意味が分かる言葉にする）。 */
export function paradisDescribeValue(value: string | undefined): string {
	if (value === undefined) {
		return localize('paradis.themeColors.value.none', "なし");
	}
	if (value === PARADIS_DEFAULT_COLOR_VALUE) {
		return localize('paradis.themeColors.value.default', "色の既定値（\"default\"）");
	}
	return value.toUpperCase();
}

export interface IParadisLayerRow {
	readonly label: string;
	readonly value: string | undefined;
	/** 見本に塗る色（値が `"default"` などのときは解決済みの色）。 */
	readonly swatch: string | undefined;
	readonly active: boolean;
	readonly unsaved?: boolean;
}

/** 「自分で変えた色 / Para Code の既定 / テーマの色」の行を描き直す。 */
export function paradisRenderLayerRows(container: HTMLElement, rows: readonly IParadisLayerRow[]): void {
	dom.clearNode(container);
	for (const row of rows) {
		const element = dom.append(container, $('.paradis-tce-layer'));
		element.classList.toggle('active', row.active);
		paradisSetSwatch(dom.append(element, $('span.paradis-tce-swatch')), row.swatch);
		dom.append(element, $('span.paradis-tce-layer-label', undefined, row.label));
		dom.append(element, $('span.paradis-tce-layer-value', undefined, paradisDescribeValue(row.value)));
		if (row.unsaved) {
			dom.append(element, $('span.paradis-tce-badge.unsaved', undefined, localize('paradis.themeColors.badge.unsaved', "未保存")));
		}
		if (row.active) {
			dom.append(element, $('span.paradis-tce-badge.active', undefined, localize('paradis.themeColors.badge.active', "いま使用中")));
		}
	}
}

/** 二次ボタン（戻す・取り消すなど）。 */
export function paradisCreateButton(container: HTMLElement, label: string, store: DisposableStore, onClick: () => void, primary = false): Button {
	const button = store.add(new Button(container, { ...defaultButtonStyles, secondary: !primary, small: true }));
	button.label = label;
	store.add(button.onDidClick(onClick));
	return button;
}

/** 絞り込みのチップ（押し込み状態を持つ小さなボタン）。 */
export function paradisCreateChip(container: HTMLElement, label: string, store: DisposableStore, onClick: () => void): HTMLButtonElement {
	const chip = dom.append(container, $<HTMLButtonElement>('button.paradis-tce-chip', { type: 'button' }, label));
	store.add(dom.addDisposableListener(chip, dom.EventType.CLICK, onClick));
	return chip;
}
