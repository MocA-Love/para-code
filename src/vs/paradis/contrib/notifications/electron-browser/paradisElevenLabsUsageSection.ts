/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「使用量 (日別)」の ElevenLabs 版。日別の文字数（`/v1/usage/character-stats`）と
// モデル別・声別の内訳、プランの上限と残り（`/v1/user/subscription`）を出す。
// 読み上げエンジンが Aivis のときは何も描かない（Aivis 版の ParadisAivisUsageSection が描く）。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IParadisElevenLabsModel,
	IParadisElevenLabsUsageResult,
	paradisElevenLabsQuota,
	ParadisElevenLabsSubscriptionResult,
	paradisNameElevenLabsBreakdown,
} from '../common/paradisElevenLabs.js';
import { PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { ParadisAivisRenderGeneration } from './paradisAivisApiCache.js';
import { paradisElevenLabsModelCache } from './paradisElevenLabsApiCache.js';
import { paradisPreserveScroll } from './paradisNotificationSettingsDomUtils.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.elevenlabsUsage.title', "使用量 (日別)");
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.notif.elevenlabsUsage.desc', "ElevenLabs で読み上げた文字数を日別に集計し、プランの上限と残りを出します。日付は UTC で区切ります。");
// allow-any-unicode-next-line
const STR_7DAYS = localize('paradis.notif.elevenlabsUsage.7days', "7日");
// allow-any-unicode-next-line
const STR_30DAYS = localize('paradis.notif.elevenlabsUsage.30days', "30日");
// allow-any-unicode-next-line
const STR_NO_KEY = localize('paradis.notif.elevenlabsUsage.noKey', "ElevenLabs の API キーを設定すると使用量を表示できます。");
// allow-any-unicode-next-line
const STR_LOADING = localize('paradis.notif.elevenlabsUsage.loading', "読み込み中…");
const STR_CHARACTERS = 'Characters';
const STR_LIMIT = 'Limit';
const STR_REMAINING = 'Remaining';
// allow-any-unicode-next-line
const strDaysTotal = (n: number) => localize('paradis.notif.elevenlabsUsage.daysTotal', "{0}日間合計", n);
// allow-any-unicode-next-line
const strPlanUsed = (used: string) => localize('paradis.notif.elevenlabsUsage.planUsed', "今の期間に {0} 文字使用", used);
// allow-any-unicode-next-line
const strResetsAt = (date: string) => localize('paradis.notif.elevenlabsUsage.resetsAt', "{0} に戻ります", date);
// allow-any-unicode-next-line
const STR_PLAN_UNKNOWN = localize('paradis.notif.elevenlabsUsage.planUnknown', "取得できませんでした");
// allow-any-unicode-next-line
const STR_MISSING_PERMISSION = localize('paradis.notif.elevenlabsUsage.missingPermission', "API キーに user_read の権限を付けると残りを出せます。");
// allow-any-unicode-next-line
const STR_COL_DATE = localize('paradis.notif.elevenlabsUsage.colDate', "日付");
// allow-any-unicode-next-line
const STR_COL_CHARS = localize('paradis.notif.elevenlabsUsage.colChars', "文字数");
// allow-any-unicode-next-line
const strRemainingDays = (n: number) => localize('paradis.notif.elevenlabsUsage.remainingDays', "…残り {0} 日", n);
// allow-any-unicode-next-line
const STR_BY_MODEL = localize('paradis.notif.elevenlabsUsage.byModel', "モデル別");
// allow-any-unicode-next-line
const STR_BY_VOICE = localize('paradis.notif.elevenlabsUsage.byVoice', "声別");
// allow-any-unicode-next-line
const strChars = (n: string) => localize('paradis.notif.elevenlabsUsage.chars', "{0} 文字", n);

type Period = '7' | '30';

interface IUsageBundle {
	readonly usage: IParadisElevenLabsUsageResult;
	readonly subscription: ParadisElevenLabsSubscriptionResult | { readonly kind: 'error'; readonly message: string };
	readonly modelNames: ReadonlyMap<string, string>;
}

export class ParadisElevenLabsUsageSection extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _renderGeneration = new ParadisAivisRenderGeneration();
	/** 同じキー・期間の取得を、描き直しのたびにやり直さない。失敗した取得は覚えない。 */
	private readonly _requests = new Map<string, Promise<IUsageBundle>>();
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
		this._register({ dispose: () => this._requests.clear() });
		this._render();
	}

	private _render(): void {
		if (this._store.isDisposed) {
			return;
		}
		paradisPreserveScroll(this.container, () => this._renderBody());
	}

	private _renderBody(): void {
		const generation = this._renderGeneration.begin();
		dom.clearNode(this.container);
		this._renderDisposables.clear();

		const settings = this.settingsService.getAivisSettings();
		if (settings.engine !== 'elevenlabs') {
			return;
		}

		const header = dom.append(this.container, $('.setting-row'));
		const titles = dom.append(header, $('.sr-main'));
		dom.append(titles, $('.pns-section-title')).textContent = STR_TITLE;
		dom.append(titles, $('.pns-section-desc')).textContent = STR_DESC;
		const periodGroup = dom.append(header, $('.pns-engine-switch'));
		const btn7 = dom.append(periodGroup, $('button.pns-btn')) as HTMLButtonElement;
		btn7.textContent = STR_7DAYS;
		const btn30 = dom.append(periodGroup, $('button.pns-btn')) as HTMLButtonElement;
		btn30.textContent = STR_30DAYS;
		(this._period === '7' ? btn7 : btn30).classList.add('pns-btn-primary');
		this._renderDisposables.add(dom.addDisposableListener(btn7, 'click', () => { this._period = '7'; this._render(); }));
		this._renderDisposables.add(dom.addDisposableListener(btn30, 'click', () => { this._period = '30'; this._render(); }));

		const apiKey = settings.elevenLabsApiKey;
		if (!apiKey) {
			dom.append(this.container, $('.pns-empty')).textContent = STR_NO_KEY;
			return;
		}

		const bodyEl = dom.append(this.container, $('div'));
		bodyEl.textContent = STR_LOADING;
		const days = this._period === '7' ? 7 : 30;
		void this._load(apiKey, days).then(bundle => {
			if (this._store.isDisposed || !this._renderGeneration.isCurrent(generation)) {
				return;
			}
			dom.clearNode(bodyEl);
			this._renderUsage(bodyEl, bundle, days);
		}, error => {
			if (this._store.isDisposed || !this._renderGeneration.isCurrent(generation)) {
				return;
			}
			dom.clearNode(bodyEl);
			dom.append(bodyEl, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
		});
	}

	private _load(apiKey: string, days: number): Promise<IUsageBundle> {
		const key = JSON.stringify([apiKey, days]);
		const existing = this._requests.get(key);
		if (existing) {
			return existing;
		}
		const channel = this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL);
		const created = (async (): Promise<IUsageBundle> => {
			const [usage, subscription, models] = await Promise.all([
				channel.call<IParadisElevenLabsUsageResult>('getElevenLabsUsage', [apiKey, days]),
				channel.call<ParadisElevenLabsSubscriptionResult>('getElevenLabsSubscription', [apiKey]).catch(error => ({ kind: 'error' as const, message: error instanceof Error ? error.message : String(error) })),
				paradisElevenLabsModelCache.get(apiKey) ?? channel.call<IParadisElevenLabsModel[]>('listElevenLabsModels', [apiKey]).catch(() => []),
			]);
			return {
				usage,
				subscription,
				modelNames: new Map(models.map(model => [model.modelId, model.name])),
			};
		})();
		this._requests.set(key, created);
		created.catch(() => {
			if (this._requests.get(key) === created) {
				this._requests.delete(key);
			}
		});
		return created;
	}

	private _renderUsage(container: HTMLElement, bundle: IUsageBundle, days: number): void {
		const { usage, subscription } = bundle;

		const statGrid = dom.append(container, $('.pns-stat-grid'));
		this._statCard(statGrid, STR_CHARACTERS, usage.totalCharacters.toLocaleString(), strDaysTotal(days));
		if (subscription.kind === 'ok') {
			const sub = subscription.subscription;
			const quota = paradisElevenLabsQuota(sub);
			this._statCard(statGrid, STR_LIMIT, sub.characterLimit.toLocaleString(), strPlanUsed(sub.characterCount.toLocaleString()));
			this._statCard(statGrid, STR_REMAINING, quota.remaining.toLocaleString(), sub.nextResetAt !== null ? strResetsAt(new Date(sub.nextResetAt).toLocaleDateString()) : '—');
			const bar = dom.append(container, $('.pns-quota-bar'));
			const fill = dom.append(bar, $('.pns-quota-fill')) as HTMLElement;
			fill.style.width = `${Math.round(quota.usedRatio * 100)}%`;
		} else {
			this._statCard(statGrid, STR_LIMIT, '—', STR_PLAN_UNKNOWN);
			this._statCard(statGrid, STR_REMAINING, '—', STR_PLAN_UNKNOWN);
			const note = dom.append(container, $(subscription.kind === 'missing-permissions' ? '.pns-row-hint' : '.pns-error'));
			note.textContent = subscription.kind === 'missing-permissions' ? STR_MISSING_PERMISSION : subscription.message;
			note.style.marginBottom = '10px';
		}

		const chart = dom.append(container, $('.pns-bar-chart'));
		chart.style.marginBottom = '14px';
		const maxValue = Math.max(1, ...usage.days.map(day => day.characterCount));
		for (const day of usage.days) {
			const bar = dom.append(chart, $('.pns-bar')) as HTMLElement;
			bar.style.height = `${Math.max(2, (day.characterCount / maxValue) * 100)}%`;
			bar.title = `${day.date}: ${strChars(day.characterCount.toLocaleString())}`;
		}

		const table = dom.append(container, $('table.pns-usage-table'));
		const headRow = dom.append(dom.append(table, $('thead')), $('tr'));
		for (const label of [STR_COL_DATE, STR_COL_CHARS]) {
			dom.append(headRow, $('th')).textContent = label;
		}
		const tbody = dom.append(table, $('tbody'));
		const reversed = [...usage.days].reverse();
		for (const day of reversed.slice(0, 10)) {
			const row = dom.append(tbody, $('tr'));
			dom.append(row, $('td')).textContent = day.date;
			dom.append(row, $('td.num')).textContent = day.characterCount.toLocaleString();
		}
		if (reversed.length > 10) {
			const cell = dom.append(dom.append(tbody, $('tr')), $('td')) as HTMLTableCellElement;
			cell.colSpan = 2;
			cell.textContent = strRemainingDays(reversed.length - 10);
		}

		this._renderBreakdown(container, STR_BY_MODEL, paradisNameElevenLabsBreakdown(usage.byModel, bundle.modelNames));
		// 声別は API が声の名前をキーにして返すので、そのまま出す。
		this._renderBreakdown(container, STR_BY_VOICE, paradisNameElevenLabsBreakdown(usage.byVoice, new Map()));
	}

	private _renderBreakdown(container: HTMLElement, title: string, entries: readonly { readonly label: string; readonly characterCount: number }[]): void {
		if (entries.length === 0) {
			return;
		}
		const box = dom.append(container, $('div'));
		box.style.marginTop = '14px';
		dom.append(box, $('.pns-row-hint')).textContent = title;
		for (const entry of entries) {
			const row = dom.append(box, $('.pns-row'));
			dom.append(row, $('span')).textContent = entry.label;
			dom.append(row, $('span.pns-row-hint')).textContent = strChars(entry.characterCount.toLocaleString());
		}
	}

	private _statCard(container: HTMLElement, label: string, value: string, sub: string): void {
		const card = dom.append(container, $('.pns-stat-card'));
		dom.append(card, $('.pns-stat-label')).textContent = label;
		dom.append(card, $('.pns-stat-value')).textContent = value;
		dom.append(card, $('.pns-stat-sub')).textContent = sub;
	}
}
