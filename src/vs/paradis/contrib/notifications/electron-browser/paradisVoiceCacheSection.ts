/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「使用量」の末尾に置く、ElevenLabs の読み上げの音声キャッシュ。使い回すかの切り替えと、
// キャッシュから鳴らした回数・API で合成した回数（直近 30 日）、置いている件数と大きさ、消すボタンを出す。
// 読み上げエンジンが Aivis のときは何も描かない。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import { IParadisVoiceCacheInfo, paradisVoiceCacheTotals } from '../common/paradisVoiceCache.js';
import { ParadisAivisRenderGeneration } from './paradisAivisApiCache.js';
import { paradisPreserveScroll } from './paradisNotificationSettingsDomUtils.js';

const $ = dom.$;

const PERIOD_DAYS = 30;

// allow-any-unicode-next-line
const STR_LABEL = localize('paradis.notif.voiceCache.label', "同じ文の読み上げを使い回す");
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.notif.voiceCache.desc', "一度 ElevenLabs で合成した通知の声をこの PC に 10 日まで置き、同じ声・同じ設定・同じ文なら合成し直さずに鳴らします。SSH 先のペインの通知も、この PC で合成するので同じように使い回します。声・モデル・声の調整・辞書を変えると別の音として合成します。辞書を直した直後の 1 回は、前の発音のまま鳴ることがあります。ElevenLabs 側で声を直したときは、キャッシュを消してください。テスト再生は毎回合成し直し、置いてある音を置き換えます。");
// allow-any-unicode-next-line
const STR_FROM_CACHE = localize('paradis.notif.voiceCache.fromCache', "キャッシュから");
// allow-any-unicode-next-line
const STR_FROM_API = localize('paradis.notif.voiceCache.fromApi', "API で合成");
// allow-any-unicode-next-line
const STR_STORED = localize('paradis.notif.voiceCache.stored', "保存中");
// allow-any-unicode-next-line
const strTimes = (n: string) => localize('paradis.notif.voiceCache.times', "{0} 回", n);
// allow-any-unicode-next-line
const strSaved = (chars: string, days: number) => localize('paradis.notif.voiceCache.saved', "{0} 文字を送らずに済みました（{1}日）", chars, days);
// allow-any-unicode-next-line
const strSent = (chars: string, days: number) => localize('paradis.notif.voiceCache.sent', "{0} 文字（{1}日）", chars, days);
// allow-any-unicode-next-line
const strEntries = (n: string) => localize('paradis.notif.voiceCache.entries', "{0} 件", n);
const strMegabytes = (n: string) => localize('paradis.notif.voiceCache.megabytes', "{0} MB", n);
// allow-any-unicode-next-line
const STR_CLEAR = localize('paradis.notif.voiceCache.clear', "キャッシュを消す");
// allow-any-unicode-next-line
const STR_CLEAR_HINT = localize('paradis.notif.voiceCache.clearHint', "消しても回数の記録は残ります。次の通知からまた合成し直します。");
// allow-any-unicode-next-line
const STR_LOADING = localize('paradis.notif.voiceCache.loading', "読み込み中…");

export class ParadisVoiceCacheSection extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _renderGeneration = new ParadisAivisRenderGeneration();

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

		const row = dom.append(this.container, $('.setting-row'));
		row.style.marginTop = '14px';
		const labels = dom.append(row, $('.sr-main'));
		dom.append(labels, $('.sr-label')).textContent = STR_LABEL;
		dom.append(labels, $('.sr-desc')).textContent = STR_DESC;
		const toggle = dom.append(row, $('input.pns-toggle')) as HTMLInputElement;
		toggle.type = 'checkbox';
		toggle.checked = settings.elevenLabsVoiceCache !== false;
		toggle.setAttribute('aria-label', STR_LABEL);
		this._renderDisposables.add(dom.addDisposableListener(toggle, 'change', () => {
			this.settingsService.setAivisSettings({ elevenLabsVoiceCache: toggle.checked });
		}));

		const bodyEl = dom.append(this.container, $('div'));
		bodyEl.textContent = STR_LOADING;
		const channel = this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL);
		void channel.call<IParadisVoiceCacheInfo>('getVoiceCacheInfo').then(info => {
			if (this._store.isDisposed || !this._renderGeneration.isCurrent(generation)) {
				return;
			}
			dom.clearNode(bodyEl);
			this._renderInfo(bodyEl, info);
		}, error => {
			if (this._store.isDisposed || !this._renderGeneration.isCurrent(generation)) {
				return;
			}
			dom.clearNode(bodyEl);
			dom.append(bodyEl, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
		});
	}

	private _renderInfo(container: HTMLElement, info: IParadisVoiceCacheInfo): void {
		const totals = paradisVoiceCacheTotals(info.days, Date.now(), PERIOD_DAYS);
		const grid = dom.append(container, $('.pns-stat-grid'));
		this._statCard(grid, STR_FROM_CACHE, strTimes(totals.hits.toLocaleString()), strSaved(totals.hitCharacters.toLocaleString(), PERIOD_DAYS));
		this._statCard(grid, STR_FROM_API, strTimes(totals.calls.toLocaleString()), strSent(totals.callCharacters.toLocaleString(), PERIOD_DAYS));
		this._statCard(grid, STR_STORED, strEntries(info.entries.toLocaleString()), strMegabytes((info.bytes / (1024 * 1024)).toFixed(1)));

		const actions = dom.append(container, $('.pns-row'));
		const clearBtn = dom.append(actions, $('button.pns-btn.pns-btn-danger')) as HTMLButtonElement;
		clearBtn.textContent = STR_CLEAR;
		clearBtn.disabled = info.entries === 0;
		dom.append(actions, $('span.pns-row-hint')).textContent = STR_CLEAR_HINT;
		this._renderDisposables.add(dom.addDisposableListener(clearBtn, 'click', () => {
			clearBtn.disabled = true;
			void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('clearVoiceCache')
				.finally(() => this._render());
		}));
	}

	private _statCard(container: HTMLElement, label: string, value: string, sub: string): void {
		const card = dom.append(container, $('.pns-stat-card'));
		dom.append(card, $('.pns-stat-label')).textContent = label;
		dom.append(card, $('.pns-stat-value')).textContent = value;
		dom.append(card, $('.pns-stat-sub')).textContent = sub;
	}
}
