/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 1（Q596）の小さな部品: 数のバッジ・チップ・状態の点。
// 包んでいる本家のファイル: 無し（DOM だけの部品。読み上げはバッジを付けたボタンの名前が持つ）。
//
// 数のバッジの決まり（Q596-4 A、見本 para-ui-kit.html の 2 章「数のバッジ」）:
//  - 色を付けるのは要対応（警告の色）とエラー（危険の色）のときだけ。平常の数は塗らず、補助の文字の色。
//  - 0 件は出さない。文字の横は 100 件から `99+`、アイコンの右上（14px の丸）は 10 件から `9+`。
//  - 色だけで要対応を伝えない。件数と意味はボタンの読み上げの名前（aria-label）に入れる。

import './media/paradisBadges.css';
import { $, append } from '../../base/browser/dom.js';

/** 数の意味。`plain` は平常の数（稼働中の件数など）で、色を付けない。 */
export type ParadisCountTone = 'plain' | 'attention' | 'error';

/** 数を置く場所。`inline` は文字の横、`overlay` はアイコンだけのボタンの右上に重ねる。 */
export type ParadisCountPlacement = 'inline' | 'overlay';

/** 数のバッジに出す文字。出さないとき（0 件以下・数でない）は undefined。 */
export function paradisCountLabel(count: number, placement: ParadisCountPlacement): string | undefined {
	if (!Number.isFinite(count) || count < 1) {
		return undefined;
	}
	const limit = placement === 'overlay' ? 9 : 99;
	return count > limit ? `${limit}+` : String(Math.floor(count));
}

/**
 * 数のバッジ。読み上げからは隠す（件数は付けたボタンの aria-label に入れる）。
 * 文字の横に置くときは数の分だけボタンの幅が変わる。タイトルバーでは titlebarFit が中身の変化を見て測り直す。
 */
export class ParadisCountBadge {

	readonly element: HTMLElement;

	constructor(parent: HTMLElement, private readonly placement: ParadisCountPlacement) {
		this.element = append(parent, $(placement === 'overlay' ? 'span.paradis-count.paradis-count-overlay' : 'span.paradis-count'));
		this.element.setAttribute('aria-hidden', 'true');
		this.update(0, 'plain');
	}

	update(count: number, tone: ParadisCountTone): void {
		const label = paradisCountLabel(count, this.placement);
		this.element.textContent = label ?? '';
		this.element.classList.toggle('hidden', label === undefined);
		this.element.classList.toggle('attention', tone === 'attention');
		this.element.classList.toggle('error', tone === 'error');
	}
}

/** チップ・状態の点の意味。チップは塗らず、枠は同じ色の淡い線、文字は太字にしない。 */
export type ParadisChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** 状態の札（チップ）。長い文字は省略記号で切る（全文のホバーは置く側で付ける）。 */
export function createParadisChip(parent: HTMLElement, label: string, tone: ParadisChipTone = 'neutral'): HTMLElement {
	const chip = append(parent, $(`span.paradis-chip.paradis-chip-${tone}`));
	append(chip, $('span.paradis-chip-label')).textContent = label;
	return chip;
}

/** 状態の点の意味。`running` は動いている間だけ点が明滅する（動きを減らす設定では止まる）。 */
export type ParadisStatusTone = 'neutral' | 'running' | 'success' | 'warning' | 'danger';

/** 状態の点（行の中で、文字の前に 6px の点 1 つ）。点は飾りなので読み上げからは隠し、文字で状態を伝える。 */
export function createParadisStatusDot(parent: HTMLElement, label: string, tone: ParadisStatusTone = 'neutral'): HTMLElement {
	const status = append(parent, $(`span.paradis-status.paradis-status-${tone}`));
	append(status, $('span.paradis-status-dot')).setAttribute('aria-hidden', 'true');
	append(status, $('span.paradis-status-label')).textContent = label;
	return status;
}
