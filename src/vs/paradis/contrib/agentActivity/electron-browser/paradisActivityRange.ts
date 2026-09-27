/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量ダイアログの「スペース別」「作業実績」タブで共通の期間（直近 7 / 30 / 90 日）と表示の整形。

import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { paradisActivityDayKey } from '../common/paradisAgentActivity.js';

export type ParadisActivityRangeDays = 7 | 30 | 90;

export interface IParadisActivityRange {
	readonly since: string;
	readonly until: string;
	/** since から until までの日付（YYYY-MM-DD、古い順）。 */
	readonly days: readonly string[];
}

/** 今日を含む直近 `days` 日。 */
export function paradisActivityRange(days: ParadisActivityRangeDays, today = new Date()): IParadisActivityRange {
	const list: string[] = [];
	for (let offset = days - 1; offset >= 0; offset--) {
		list.push(paradisActivityDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)));
	}
	return { since: list[0], until: list[list.length - 1], days: list };
}

/** 「7日間 / 30日間 / 90日間」の切り替えボタンを作る。押されたら `onChange` を呼ぶ。 */
export function paradisAppendRangeSegment(parent: HTMLElement, store: DisposableStore, current: () => ParadisActivityRangeDays, onChange: (days: ParadisActivityRangeDays) => void): () => void {
	const seg = dom.append(parent, dom.$('.paradis-ccusage-seg'));
	const buttons = new Map<ParadisActivityRangeDays, HTMLButtonElement>();
	for (const days of [7, 30, 90] as const) {
		const button = dom.append(seg, dom.$('button')) as HTMLButtonElement;
		button.type = 'button';
		// allow-any-unicode-next-line
		button.textContent = localize('paradis.activity.rangeDays', "{0}日間", days);
		buttons.set(days, button);
		store.add(dom.addDisposableListener(button, 'click', () => onChange(days)));
	}
	const sync = () => {
		for (const [days, button] of buttons) {
			button.classList.toggle('checked', days === current());
			button.setAttribute('aria-pressed', String(days === current()));
		}
	};
	sync();
	return sync;
}

/** 「3 時間 20 分」のような稼働時間の表記。 */
export function paradisFormatActiveDuration(ms: number): string {
	const totalMinutes = Math.round(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) {
		// allow-any-unicode-next-line
		return localize('paradis.activity.minutes', "{0} 分", minutes);
	}
	// allow-any-unicode-next-line
	return localize('paradis.activity.hoursMinutes', "{0} 時間 {1} 分", hours, minutes);
}

/** 日付（YYYY-MM-DD）を「9/26」の形に。 */
export function paradisShortDay(day: string): string {
	const [, month, date] = day.split('-');
	return `${Number(month)}/${Number(date)}`;
}
