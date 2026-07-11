/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「使用量 (日別)」セクション（Superset apps/desktop の AivisUsage.tsx の移植）。
// Aivis Cloud API のリクエスト数・文字数・クレジット消費を日別に集計して表示する。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisAivisMeResult, IParadisAivisUsageDayEntry, IParadisAivisUsageResult, PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { paradisPreserveScroll } from './paradisNotificationSettingsDomUtils.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.usage.title', "使用量 (日別)");
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.notif.usage.desc', "Aivis API のリクエスト数・文字数・クレジット消費を日別に集計します。");
// allow-any-unicode-next-line
const STR_7DAYS = localize('paradis.notif.usage.7days', "7日");
// allow-any-unicode-next-line
const STR_30DAYS = localize('paradis.notif.usage.30days', "30日");
// allow-any-unicode-next-line
const STR_NO_KEY = localize('paradis.notif.usage.noKey', "Aivis API キーを設定すると使用量を表示できます。");
// allow-any-unicode-next-line
const STR_LOADING = localize('paradis.notif.usage.loading', "読み込み中…");
// allow-any-unicode-next-line
const STR_REQUESTS = localize('paradis.notif.usage.requests', "Requests");
// allow-any-unicode-next-line
const STR_CHARACTERS = localize('paradis.notif.usage.characters', "Characters");
// allow-any-unicode-next-line
const STR_CREDITS = localize('paradis.notif.usage.credits', "Credits consumed");
// allow-any-unicode-next-line
const strAvgChars = (n: string) => localize('paradis.notif.usage.avgChars', "平均 {0} 文字/回", n);
// allow-any-unicode-next-line
const strDaysTotal = (n: number) => localize('paradis.notif.usage.daysTotal', "{0}日間合計", n);
// allow-any-unicode-next-line
const strBalance = (n: string) => localize('paradis.notif.usage.balance', "残高 {0}", n);
// allow-any-unicode-next-line
const STR_COL_DATE = localize('paradis.notif.usage.colDate', "日付");
// allow-any-unicode-next-line
const strRemainingDays = (n: number) => localize('paradis.notif.usage.remainingDays', "…残り {0} 日", n);
// allow-any-unicode-next-line
const strApiKeyBreakdown = (n: number) => localize('paradis.notif.usage.apiKeyBreakdown', "API キー別 ({0} keys)", n);

type Period = '7' | '30';

function toIsoDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function rangeFor(period: Period): { start: string; end: string; days: number } {
	const end = new Date();
	const start = new Date();
	const days = period === '7' ? 7 : 30;
	start.setDate(end.getDate() - (days - 1));
	return { start: toIsoDate(start), end: toIsoDate(end), days };
}

function fillMissingDates(days: readonly IParadisAivisUsageDayEntry[], start: string, end: string): IParadisAivisUsageDayEntry[] {
	const result: IParadisAivisUsageDayEntry[] = [];
	const map = new Map(days.map(d => [d.date, d]));
	const s = new Date(`${start}T00:00:00`);
	const e = new Date(`${end}T00:00:00`);
	for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
		const key = toIsoDate(d);
		result.push(map.get(key) ?? { date: key, requestCount: 0, characterCount: 0, creditConsumed: 0, byApiKey: {} });
	}
	return result;
}

export class ParadisAivisUsageSection extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _period: Period = '30';

	constructor(
		private readonly container: HTMLElement,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
	) {
		super();
		this._register(this.settingsService.onDidChange(scope => {
			if (scope === 'aivis') {
				this._render();
			}
		}));
		this._render();
	}

	private _render(): void {
		if (this._store.isDisposed) {
			return;
		}
		// 再描画で直前にフォーカスされていた要素がDOMから外れることでスクロール位置が
		// 先頭に戻ってしまう問題への対策(paradisNotificationSettingsDomUtils.ts参照)。
		paradisPreserveScroll(this.container, () => this._renderBody());
	}

	private _renderBody(): void {
		dom.clearNode(this.container);
		this._renderDisposables.clear();

		const header = dom.append(this.container, $('.pns-row'));
		const titles = dom.append(header, $('div'));
		dom.append(titles, $('.pns-section-title')).textContent = STR_TITLE;
		dom.append(titles, $('.pns-section-desc')).textContent = STR_DESC;

		const periodGroup = dom.append(header, $('div'));
		periodGroup.style.display = 'flex';
		periodGroup.style.gap = '4px';
		const btn7 = dom.append(periodGroup, $('button.pns-btn')) as HTMLButtonElement;
		btn7.textContent = STR_7DAYS;
		const btn30 = dom.append(periodGroup, $('button.pns-btn')) as HTMLButtonElement;
		btn30.textContent = STR_30DAYS;
		(this._period === '7' ? btn7 : btn30).classList.add('pns-btn-primary');
		this._renderDisposables.add(dom.addDisposableListener(btn7, 'click', () => { this._period = '7'; this._render(); }));
		this._renderDisposables.add(dom.addDisposableListener(btn30, 'click', () => { this._period = '30'; this._render(); }));

		const apiKey = this.settingsService.getAivisSettings().apiKey;
		if (!apiKey) {
			dom.append(this.container, $('.pns-empty')).textContent = STR_NO_KEY;
			return;
		}

		const bodyEl = dom.append(this.container, $('div'));
		bodyEl.textContent = STR_LOADING;

		const range = rangeFor(this._period);
		const channel = this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL);
		void Promise.all([
			channel.call<IParadisAivisUsageResult>('getAivisUsageDaily', [apiKey, range.start, range.end]),
			channel.call<IParadisAivisMeResult>('getAivisMe', [apiKey]).catch(() => null),
		]).then(([usage, me]) => {
			if (this._store.isDisposed) {
				return;
			}
			dom.clearNode(bodyEl);
			this._renderUsage(bodyEl, usage, me, range);
		}, error => {
			if (this._store.isDisposed) {
				return;
			}
			dom.clearNode(bodyEl);
			dom.append(bodyEl, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
		});
	}

	private _renderUsage(container: HTMLElement, usage: IParadisAivisUsageResult, me: IParadisAivisMeResult | null, range: { start: string; end: string; days: number }): void {
		const filled = fillMissingDates(usage.days, range.start, range.end);
		const total = usage.total;

		const statGrid = dom.append(container, $('.pns-stat-grid'));
		this._statCard(statGrid, STR_REQUESTS, total.requestCount.toLocaleString(), total.requestCount > 0 ? strAvgChars((total.characterCount / total.requestCount).toFixed(1)) : '—');
		this._statCard(statGrid, STR_CHARACTERS, total.characterCount.toLocaleString(), strDaysTotal(range.days));
		this._statCard(statGrid, STR_CREDITS, total.creditConsumed.toFixed(2), me?.creditBalance !== null && me?.creditBalance !== undefined ? strBalance(me.creditBalance.toLocaleString()) : '—');

		const maxValue = Math.max(1, ...filled.map(d => d.creditConsumed));
		const chartBox = dom.append(container, $('div'));
		chartBox.style.marginBottom = '14px';
		const chart = dom.append(chartBox, $('.pns-bar-chart'));
		for (const day of filled) {
			const bar = dom.append(chart, $('.pns-bar')) as HTMLElement;
			bar.style.height = `${Math.max(2, (day.creditConsumed / maxValue) * 100)}%`;
			bar.title = `${day.date}: ${day.creditConsumed.toFixed(2)} credits`;
		}

		const table = dom.append(container, $('table.pns-usage-table'));
		const thead = dom.append(table, $('thead'));
		const headRow = dom.append(thead, $('tr'));
		for (const label of [STR_COL_DATE, 'Requests', 'Chars', 'Credits']) {
			dom.append(headRow, $('th')).textContent = label;
		}
		const tbody = dom.append(table, $('tbody'));
		const reversed = [...filled].reverse().slice(0, 10);
		for (const day of reversed) {
			const row = dom.append(tbody, $('tr'));
			dom.append(row, $('td')).textContent = day.date;
			dom.append(row, $('td.num')).textContent = day.requestCount.toLocaleString();
			dom.append(row, $('td.num')).textContent = day.characterCount.toLocaleString();
			dom.append(row, $('td.num')).textContent = day.creditConsumed.toFixed(2);
		}
		if (filled.length > 10) {
			const row = dom.append(tbody, $('tr'));
			const cell = dom.append(row, $('td')) as HTMLTableCellElement;
			cell.colSpan = 4;
			cell.textContent = strRemainingDays(filled.length - 10);
		}

		const byApiKey = new Map<string, { name: string; requestCount: number; characterCount: number; creditConsumed: number }>();
		for (const day of usage.days) {
			for (const [id, bucket] of Object.entries(day.byApiKey)) {
				const prev = byApiKey.get(id) ?? { name: bucket.name, requestCount: 0, characterCount: 0, creditConsumed: 0 };
				prev.requestCount += bucket.requestCount;
				prev.characterCount += bucket.characterCount;
				prev.creditConsumed += bucket.creditConsumed;
				byApiKey.set(id, prev);
			}
		}
		const breakdown = [...byApiKey.entries()].sort((a, b) => b[1].creditConsumed - a[1].creditConsumed);
		if (breakdown.length > 1) {
			const box = dom.append(container, $('div'));
			box.style.marginTop = '14px';
			const label = dom.append(box, $('.pns-row-hint'));
			label.textContent = strApiKeyBreakdown(breakdown.length);
			for (const [, entry] of breakdown) {
				const row = dom.append(box, $('.pns-row'));
				dom.append(row, $('span')).textContent = entry.name;
				const value = dom.append(row, $('span.pns-row-hint'));
				value.textContent = `${entry.requestCount.toLocaleString()} req · ${entry.creditConsumed.toFixed(2)} credits`;
			}
		}
	}

	private _statCard(container: HTMLElement, label: string, value: string, sub: string): void {
		const card = dom.append(container, $('.pns-stat-card'));
		dom.append(card, $('.pns-stat-label')).textContent = label;
		dom.append(card, $('.pns-stat-value')).textContent = value;
		dom.append(card, $('.pns-stat-sub')).textContent = sub;
	}
}
