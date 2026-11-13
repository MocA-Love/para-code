/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量のグラフ（ccusage の日別・トークンの推移、RTK の節約推移）をキーボードと読み上げで読めるようにする。
// グラフの svg 全体を 1 つの Tab の止まり先にし、左右の矢印キー・Home・End で棒（日）を選ぶと、マウスのときと
// 同じ吹き出しを出して選んだ日の内訳を読み上げる（paradis-18-5 の案 B）。フォーカスの枠は paradisFocusRing.css の
// 青い枠（キーボードのときだけ）。

import { addDisposableListener, EventType } from '../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../base/browser/keyboardEvent.js';
import { status } from '../../base/browser/ui/aria/aria.js';
import { KeyCode } from '../../base/common/keyCodes.js';
import { DisposableStore, IDisposable } from '../../base/common/lifecycle.js';
import { localize } from '../../nls.js';

export interface IParadisChartKeyboardOptions {
	/** グラフの svg。ここを 1 つの Tab の止まり先にする。 */
	readonly svg: SVGElement;
	/** 選べる点（棒・日）の数。 */
	readonly count: number;
	/** 読み上げの名前（{@link paradisChartAriaLabel} で作る）。 */
	readonly ariaLabel: string;
	/** キーボードで index の点を選んだ。マウスのときと同じ吹き出しを出し、読み上げる文を返す。 */
	readonly select: (index: number) => string;
	/** フォーカスが外れた。吹き出しと選んだ印を隠す。 */
	readonly clear: () => void;
}

export interface IParadisChartKeyboard extends IDisposable {
	/** マウスで重ねた点。次の矢印キーはここから動く。 */
	setCurrent(index: number): void;
}

/** グラフの svg にキーボードでの選び方を付ける。点が 0 個のときは止まり先を作らない。 */
export function attachParadisChartKeyboard(options: IParadisChartKeyboardOptions): IParadisChartKeyboard {
	const store = new DisposableStore();
	const { svg, count } = options;
	let current = -1;
	if (count > 0) {
		svg.setAttribute('tabindex', '0');
		svg.setAttribute('role', 'group');
		svg.setAttribute('aria-label', options.ariaLabel);
		svg.classList.add('paradis-focus-ring');
		store.add(addDisposableListener(svg, EventType.POINTER_DOWN, () => svg.focus({ preventScroll: true })));
		store.add(addDisposableListener(svg, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			let next: number;
			if (event.keyCode === KeyCode.RightArrow) {
				next = current < 0 ? 0 : Math.min(count - 1, current + 1);
			} else if (event.keyCode === KeyCode.LeftArrow) {
				next = current < 0 ? 0 : Math.max(0, current - 1);
			} else if (event.keyCode === KeyCode.Home) {
				next = 0;
			} else if (event.keyCode === KeyCode.End) {
				next = count - 1;
			} else {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			current = next;
			status(options.select(next));
		}));
		store.add(addDisposableListener(svg, EventType.BLUR, () => options.clear()));
	}
	return {
		setCurrent: index => { current = index; },
		dispose: () => store.dispose(),
	};
}

export interface IParadisChartSummary {
	readonly kind: 'bar' | 'line';
	readonly unit: 'day' | 'week';
	/** グラフの題（「日別コスト」など）。 */
	readonly title: string;
	readonly first: string;
	readonly last: string;
	readonly count: number;
	readonly total: string;
	/** 値が一番大きい点の名前と値。 */
	readonly maxLabel: string;
	readonly maxValue: string;
}

/** グラフの読み上げの名前: 題・期間・合計・最大の点と、矢印キーの案内。 */
export function paradisChartAriaLabel(summary: IParadisChartSummary): string {
	const { title, first, last, count, total, maxLabel, maxValue } = summary;
	if (summary.kind === 'bar') {
		return summary.unit === 'week'
			? localize('paradis.chart.ariaLabel.barWeek', "{0}の棒グラフ。{1} から {2} の {3} 週、合計 {4}。最大は {5} の {6}。左右の矢印キーで週を選べます。", title, first, last, count, total, maxLabel, maxValue)
			: localize('paradis.chart.ariaLabel.barDay', "{0}の棒グラフ。{1} から {2} の {3} 日、合計 {4}。最大は {5} の {6}。左右の矢印キーで日を選べます。", title, first, last, count, total, maxLabel, maxValue);
	}
	return summary.unit === 'week'
		? localize('paradis.chart.ariaLabel.lineWeek', "{0}の折れ線グラフ。{1} から {2} の {3} 週、合計 {4}。最大は {5} の {6}。左右の矢印キーで週を選べます。", title, first, last, count, total, maxLabel, maxValue)
		: localize('paradis.chart.ariaLabel.lineDay', "{0}の折れ線グラフ。{1} から {2} の {3} 日、合計 {4}。最大は {5} の {6}。左右の矢印キーで日を選べます。", title, first, last, count, total, maxLabel, maxValue);
}

/** 選んだ点の読み上げ: 「2026-11-03: Opus $1.20、その他 $0.10、合計 $1.30」。吹き出しの行と同じ中身。 */
export function paradisChartPointText(title: string, rows: readonly { readonly name: string; readonly value: string }[]): string {
	const parts = rows.map(row => localize('paradis.chart.pointRow', "{0} {1}", row.name, row.value));
	return localize('paradis.chart.pointText', "{0}: {1}", title, parts.join(localize('paradis.chart.pointSeparator', "、")));
}
