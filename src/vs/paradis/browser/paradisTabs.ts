/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 4（Q600）のタブ。高さ 32、選んだものは文字を強くして下に 2px のアクセントの線。
//
// 包んでいる本家のファイル: 無し（base に汎用のタブの部品が無い）。役目（tablist・tab・tabpanel・aria-selected）と
// 矢印キー・Home・End の移動は、置く側の画面が持つ（統合のモーダルは paradisHubDialog.ts）。ここは見た目のクラスと、
// スクロールバーを出さない列を縦のホイールでも横に送る口（scrollParadisTabsWithWheel）だけ。

import './media/paradisTabs.css';
import { addDisposableListener, EventType } from '../../base/browser/dom.js';
import { IDisposable } from '../../base/common/lifecycle.js';

/** タブを並べる入れ物のクラス。 */
export const PARADIS_TABS_CLASS = 'paradis-tabs';

/** 1 つのタブ（`button role="tab"`）に付けるクラス。キーボードのフォーカスは内側の青い枠。 */
export function paradisTabClasses(): string[] {
	return ['paradis-tab', 'paradis-focus-ring-inset'];
}

/** 行単位のホイール（`WheelEvent.DOM_DELTA_LINE`）を px に直す目安。 */
const WHEEL_LINE_HEIGHT = 16;

interface IParadisTabsWheel {
	readonly deltaX: number;
	readonly deltaY: number;
	readonly deltaMode: number;
	readonly shiftKey: boolean;
}

/**
 * 縦のホイールでタブの列を横に送ったときの `scrollLeft`。送らないとき（横のスワイプ・Shift＋ホイール・横にあふれていない・
 * 端に着いている）は `undefined` を返し、既定の動き（ブラウザの横スクロールや外側のスクロール）に任せる。
 */
export function paradisTabsWheelScrollLeft(scrollLeft: number, scrollWidth: number, clientWidth: number, wheel: IParadisTabsWheel): number | undefined {
	if (wheel.shiftKey || wheel.deltaX !== 0 || wheel.deltaY === 0) {
		return undefined;
	}
	const max = scrollWidth - clientWidth;
	if (max <= 0) {
		return undefined;
	}
	const delta = wheel.deltaMode === 1 ? wheel.deltaY * WHEEL_LINE_HEIGHT : wheel.deltaY;
	const next = Math.max(0, Math.min(max, scrollLeft + delta));
	return next === scrollLeft ? undefined : next;
}

/**
 * タブの列（スクロールバーを出していない、paradisTabs.css）を、縦のホイールしかないマウスでも横に送れるようにする。
 * 横のスワイプと Shift＋ホイールはブラウザの横スクロールのまま。端に着いたら既定の動きに任せる。
 */
export function scrollParadisTabsWithWheel(container: HTMLElement): IDisposable {
	return addDisposableListener(container, EventType.MOUSE_WHEEL, (event: WheelEvent) => {
		const next = paradisTabsWheelScrollLeft(container.scrollLeft, container.scrollWidth, container.clientWidth, event);
		if (next !== undefined) {
			event.preventDefault();
			container.scrollLeft = next;
		}
	}, { passive: false });
}
