/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量ダイアログの「作業実績」タブ。
//
// 起動したエージェント（会話の数）とターン（ユーザーの依頼の数）を分けて数える。Orca の「起動した
// エージェント数」は依頼のたびに増えるのでターン数に近く、実感と合わないため。稼働時間は会話ログの
// 記録の間隔が5分以内の区間の合計、PR はエージェントが作った PR の URL（会話ログに残るもの）の数。
// 「画像で共有」から、数字と日付だけを載せた白地のカードを PNG で書き出せる。

import '../../ccusage/electron-browser/media/paradisCcusage.css';
import './media/paradisAgentActivity.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IParadisUsageSection } from '../../usageDashboard/electron-browser/paradisUsageSection.js';
import { IParadisWorkStatsResult, ParadisWorkStatsAgentFilter, paradisCombineWorkStats } from '../common/paradisAgentActivity.js';
import { ParadisAgentActivityClient } from './paradisAgentActivityClient.js';
import { IParadisActivityRange, ParadisActivityRangeDays, paradisActivityRange, paradisAppendRangeSegment, paradisFormatActiveDuration, paradisShortDay } from './paradisActivityRange.js';
import { IParadisShareCardData, paradisDrawShareCard, paradisShareCardPng } from './paradisWorkShareCard.js';

const $ = dom.$;
const SVG_NS = 'http://www.w3.org/2000/svg';

export class ParadisWorkStatsSection extends Disposable implements IParadisUsageSection {

	readonly element: HTMLElement;
	private readonly body: HTMLElement;
	private readonly shareButton: HTMLButtonElement;
	private readonly syncRange: () => void;
	private readonly agentButtons = new Map<ParadisWorkStatsAgentFilter, HTMLButtonElement>();
	private readonly client: ParadisAgentActivityClient;
	private readonly overlay = this._register(new MutableDisposable<DisposableStore>());
	private rangeDays: ParadisActivityRangeDays = 7;
	private agentFilter: ParadisWorkStatsAgentFilter = 'all';
	private width = 0;
	private loadedOnce = false;
	private loading = false;
	private sequence = 0;
	private data: { readonly range: IParadisActivityRange; readonly result: IParadisWorkStatsResult } | undefined;
	private error: string | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.client = instantiationService.createInstance(ParadisAgentActivityClient);
		this.element = $('.paradis-ccusage.paradis-activity-panel');
		const toolbar = dom.append(this.element, $('.paradis-ccusage-toolbar'));
		const store = this._register(new DisposableStore());
		this.syncRange = paradisAppendRangeSegment(toolbar, store, () => this.rangeDays, days => {
			this.rangeDays = days;
			this.syncRange();
			void this.refresh(false);
		});
		const agentSeg = dom.append(toolbar, $('.paradis-ccusage-seg'));
		for (const [value, label] of [
			['all', localize('paradis.workStats.allAgents', "すべてのエージェント")],
			['claude', 'Claude Code'],
			['codex', 'Codex'],
		] as const) {
			const button = dom.append(agentSeg, $('button')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			this.agentButtons.set(value, button);
			store.add(dom.addDisposableListener(button, 'click', () => {
				this.agentFilter = value;
				this.render();
			}));
		}
		dom.append(toolbar, $('.paradis-ccusage-toolbar-spacer'));
		this.shareButton = dom.append(toolbar, $('button.paradis-work-share-button')) as HTMLButtonElement;
		this.shareButton.type = 'button';
		dom.append(this.shareButton, $(`span${ThemeIcon.asCSSSelector(Codicon.fileMedia)}`));
		dom.append(this.shareButton, $('span')).textContent = localize('paradis.workStats.share', "画像で共有");
		store.add(dom.addDisposableListener(this.shareButton, 'click', () => {
			this.openSharePreview().catch(error => {
				this.overlay.clear();
				this.notificationService.error(localize('paradis.workStats.shareFailed', "共有画像を作れませんでした: {0}", error instanceof Error ? error.message : String(error)));
			});
		}));
		this.body = dom.append(this.element, $('.paradis-ccusage-body'));
		this.render();
	}

	layout(width: number): void {
		if (Math.abs(width - this.width) > 1) {
			this.width = width;
			this.render();
		}
	}

	setVisible(visible: boolean): void {
		if (visible && !this.loadedOnce) {
			void this.refresh(false);
		}
		if (!visible) {
			this.overlay.clear();
		}
	}

	async refresh(bypassCache = false): Promise<void> {
		this.loadedOnce = true;
		const sequence = ++this.sequence;
		this.loading = true;
		this.error = undefined;
		this.render();
		try {
			const range = paradisActivityRange(this.rangeDays);
			const result = await this.client.workStats({ since: range.since, until: range.until, bypassCache });
			if (sequence === this.sequence && !this._store.isDisposed) {
				this.data = { range, result };
			}
		} catch (error) {
			if (sequence === this.sequence) {
				this.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			if (sequence === this.sequence && !this._store.isDisposed) {
				this.loading = false;
				this.render();
			}
		}
	}

	private scopeLabel(): string {
		return this.agentFilter === 'claude' ? 'Claude Code'
			: this.agentFilter === 'codex' ? 'Codex'
				: localize('paradis.workStats.scopeAll', "Claude Code と Codex の合計");
	}

	private render(): void {
		for (const [value, button] of this.agentButtons) {
			button.classList.toggle('checked', value === this.agentFilter);
			button.setAttribute('aria-pressed', String(value === this.agentFilter));
		}
		this.shareButton.disabled = this.data === undefined;
		dom.clearNode(this.body);
		this.body.classList.toggle('stale', this.loading && this.data !== undefined);
		if (this.error) {
			const message = dom.append(this.body, $('.paradis-ccusage-message'));
			dom.append(message, $(`span${ThemeIcon.asCSSSelector(Codicon.warning)}`));
			dom.append(message, $('span')).textContent = this.error;
			return;
		}
		if (!this.data) {
			const message = dom.append(this.body, $('.paradis-ccusage-message'));
			dom.append(message, $(`span${ThemeIcon.asCSSSelector(Codicon.loading)}.codicon-modifier-spin`));
			dom.append(message, $('span')).textContent = localize('paradis.workStats.loading', "会話ログを集計しています…");
			return;
		}
		const { range, result } = this.data;
		const totals = paradisCombineWorkStats(result, this.agentFilter, range.days);
		dom.append(this.body, $('.paradis-ccusage-note')).textContent = localize('paradis.workStats.note', "この PC の Claude Code と Codex の会話ログから数えています。ターンはあなたが依頼した回数、稼働時間は記録の間隔が5分以内の区間の合計です。");
		const kpis = dom.append(this.body, $('.paradis-ccusage-kpis.paradis-activity-kpis'));
		this.tile(kpis, localize('paradis.workStats.sessions', "起動したエージェント"), totals.sessions.toLocaleString(), localize('paradis.workStats.sessionsUnit', "セッション"));
		this.tile(kpis, localize('paradis.workStats.turns', "ターン数"), totals.turns.toLocaleString());
		this.tile(kpis, localize('paradis.workStats.activeTime', "稼働時間"), paradisFormatActiveDuration(totals.activeMs));
		this.tile(kpis, localize('paradis.workStats.prs', "作成した PR"), totals.prs.toLocaleString());

		const card = dom.append(this.body, $('.paradis-ccusage-card'));
		dom.append(card, $('h3')).textContent = localize('paradis.workStats.chartTitle', "日別のターン数");
		this.renderChart(card, range.days, totals.dailyTurns);
	}

	private tile(parent: HTMLElement, label: string, value: string, unit?: string): void {
		const card = dom.append(parent, $('.paradis-ccusage-card'));
		dom.append(card, $('.paradis-ccusage-stat-label')).textContent = label;
		const valueEl = dom.append(card, $('.paradis-ccusage-stat-value'));
		valueEl.textContent = value;
		if (unit) {
			dom.append(valueEl, $('span.unit')).textContent = ` ${unit}`;
		}
	}

	private renderChart(parent: HTMLElement, days: readonly string[], values: readonly number[]): void {
		const doc = parent.ownerDocument;
		const width = Math.max(320, (this.width || 720) - 72);
		const height = 180;
		const left = 32;
		const bottom = 24;
		const top = 8;
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.classList.add('paradis-work-chart');
		svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', localize('paradis.workStats.chartAria', "日別のターン数のグラフ"));
		// Round the scale up to an even number so the middle grid line lands on a whole turn count.
		const peak = Math.max(1, ...values);
		const max = peak + (peak % 2);
		const plotHeight = height - bottom - top;
		for (const fraction of [0, 0.5, 1]) {
			const y = top + plotHeight * (1 - fraction);
			const line = doc.createElementNS(SVG_NS, 'line');
			line.classList.add('grid');
			line.setAttribute('x1', String(left));
			line.setAttribute('x2', String(width));
			line.setAttribute('y1', String(y));
			line.setAttribute('y2', String(y));
			svg.appendChild(line);
			const label = doc.createElementNS(SVG_NS, 'text');
			label.classList.add('axis');
			label.setAttribute('x', String(left - 6));
			label.setAttribute('y', String(y + 3));
			label.setAttribute('text-anchor', 'end');
			label.textContent = String(Math.round(max * fraction));
			svg.appendChild(label);
		}
		const slot = (width - left) / Math.max(1, days.length);
		const barWidth = Math.max(2, Math.min(28, slot * 0.7));
		const labelEvery = Math.max(1, Math.ceil(days.length / 10));
		days.forEach((day, index) => {
			const x = left + slot * index + (slot - barWidth) / 2;
			const barHeight = plotHeight * values[index] / max;
			if (barHeight > 0) {
				const rect = doc.createElementNS(SVG_NS, 'rect');
				rect.classList.add('bar');
				rect.setAttribute('x', x.toFixed(1));
				rect.setAttribute('y', (top + plotHeight - barHeight).toFixed(1));
				rect.setAttribute('width', barWidth.toFixed(1));
				rect.setAttribute('height', barHeight.toFixed(1));
				rect.setAttribute('rx', '2');
				const title = doc.createElementNS(SVG_NS, 'title');
				title.textContent = localize('paradis.workStats.barTitle', "{0}: {1} ターン", day, values[index]);
				rect.appendChild(title);
				svg.appendChild(rect);
			}
			if (index % labelEvery === 0 || index === days.length - 1) {
				const label = doc.createElementNS(SVG_NS, 'text');
				label.classList.add('axis');
				label.setAttribute('x', (x + barWidth / 2).toFixed(1));
				label.setAttribute('y', String(height - 6));
				label.setAttribute('text-anchor', 'middle');
				label.textContent = paradisShortDay(day);
				svg.appendChild(label);
			}
		});
		parent.appendChild(svg);
	}

	private shareData(): IParadisShareCardData | undefined {
		if (!this.data) {
			return undefined;
		}
		const { range, result } = this.data;
		const totals = paradisCombineWorkStats(result, this.agentFilter, range.days);
		const since = range.since.replace(/-/g, '/');
		const until = range.until.slice(5).replace(/-/g, '/');
		return { periodLabel: `${since} – ${until}`, scopeLabel: this.scopeLabel(), sessions: totals.sessions, turns: totals.turns, activeMs: totals.activeMs, prs: totals.prs, dailyTurns: totals.dailyTurns };
	}

	private async openSharePreview(): Promise<void> {
		const data = this.shareData();
		if (!data) {
			return;
		}
		const store = new DisposableStore();
		this.overlay.value = store;
		const canvas = paradisDrawShareCard(this.element.ownerDocument, data);
		const blob = await paradisShareCardPng(canvas);
		if (this.overlay.value !== store) {
			return;
		}
		const url = URL.createObjectURL(blob);
		store.add(toDisposable(() => URL.revokeObjectURL(url)));

		const overlay = dom.append(this.element, $('.paradis-work-share-overlay'));
		store.add(toDisposable(() => overlay.remove()));
		const preview = dom.append(overlay, $('.paradis-work-share-preview'));
		preview.setAttribute('role', 'dialog');
		preview.setAttribute('aria-label', localize('paradis.workStats.previewTitle', "共有画像のプレビュー"));
		const head = dom.append(preview, $('.head'));
		dom.append(head, $('span')).textContent = localize('paradis.workStats.previewTitle', "共有画像のプレビュー");
		const close = dom.append(head, $('button.close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('paradis.workStats.previewClose', "閉じる"));
		dom.append(close, $(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		store.add(dom.addDisposableListener(close, 'click', () => this.overlay.clear()));
		store.add(dom.addDisposableListener(overlay, 'mousedown', event => {
			if (event.target === overlay) {
				this.overlay.clear();
			}
		}));
		const image = dom.append(preview, $('img')) as HTMLImageElement;
		image.src = url;
		image.alt = localize('paradis.workStats.previewAlt', "作業実績の共有画像");
		dom.append(preview, $('.hint')).textContent = localize('paradis.workStats.previewHint', "載せるのは期間と数字だけです。リポジトリ名・ブランチ名・PR のタイトル・金額は載せません。");
		const actions = dom.append(preview, $('.actions'));
		const post = dom.append(actions, $('button')) as HTMLButtonElement;
		post.type = 'button';
		post.textContent = localize('paradis.workStats.postToX', "X に投稿");
		const copy = dom.append(actions, $('button.primary')) as HTMLButtonElement;
		copy.type = 'button';
		copy.textContent = localize('paradis.workStats.copyPng', "PNG をコピー");
		store.add(dom.addDisposableListener(copy, 'click', async () => {
			if (await this.copyPng(blob)) {
				this.notificationService.info(localize('paradis.workStats.copied', "共有画像をクリップボードにコピーしました。"));
			}
		}));
		store.add(dom.addDisposableListener(post, 'click', async () => {
			// X の投稿画面には画像を直接渡せないので、先にクリップボードへ入れてから開く。
			const copied = await this.copyPng(blob);
			const text = localize('paradis.workStats.postText', "Para Code での作業実績（{0}）", data.periodLabel);
			await this.openerService.open(URI.parse(`https://x.com/intent/post?text=${encodeURIComponent(text)}`), { openExternal: true });
			if (copied) {
				this.notificationService.info(localize('paradis.workStats.pasteHint', "共有画像をクリップボードにコピーしました。投稿画面に貼り付けてください。"));
			}
		}));
		copy.focus();
	}

	private async copyPng(blob: Blob): Promise<boolean> {
		try {
			await dom.getWindow(this.element).navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			return true;
		} catch (error) {
			this.notificationService.error(localize('paradis.workStats.copyFailed', "共有画像をコピーできませんでした: {0}", error instanceof Error ? error.message : String(error)));
			return false;
		}
	}
}
