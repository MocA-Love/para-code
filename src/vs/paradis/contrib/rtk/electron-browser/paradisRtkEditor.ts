/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// RTK 節約ダッシュボードの EditorPane。rtk CLI の集計結果(shared process 経由)を
// KPI カード・日別の節約推移・コマンド別内訳・直近のコマンドとして描画する。
// チャートは素の SVG DOM で構築し、workbench テーマのCSS変数+固定のアクセント色を使う。

import './media/paradisRtk.css';
import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { isParadisRtkNotFoundError, paradisRtkFormatTokens, paradisRtkLocalDateString } from '../common/paradisRtk.js';
import {
	IParadisRtkDashboardData,
	IParadisRtkDayData,
	MAX_COMMAND_ROWS,
	ParadisRtkClient,
	paradisRtkSavingsPercent
} from './paradisRtkClient.js';
import { PARADIS_RTK_EDITOR_ID } from './paradisRtkInput.js';

const $ = dom.$;

/** アクセント色(アンバー)。ダーク面/ライト面それぞれで検証済みの組み合わせ。 */
const ACCENT_DARK = '#c98500';
const ACCENT_LIGHT = '#eda100';

/** 直近のコマンド表に出す行数の上限。 */
const MAX_HISTORY_ROWS = 12;

/** 期間プリセット。 */
type ParadisRtkPresetKey = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | '7d' | '30d' | '90d';
/** チャートの表示単位。7日未満の期間では daily に強制される(effectiveGranularity 参照)。 */
type ParadisRtkGranularity = 'daily' | 'weekly';

interface IDateRange {
	/** YYYY-MM-DD、この日を含む。 */
	readonly from: string;
	/** YYYY-MM-DD、この日を含む。 */
	readonly to: string;
}

/** 日別/週別チャートの1本のバーに対応する集計単位。 */
interface IBucket {
	/** X軸目盛り用の短いラベル(例: "7/4")。 */
	readonly axisLabel: string;
	/** ツールチップ見出し用のラベル。 */
	readonly tooltipLabel: string;
	readonly commands: number;
	readonly inputTokens: number;
	readonly savedTokens: number;
}

export class ParadisRtkEditor extends EditorPane {

	static readonly ID = PARADIS_RTK_EDITOR_ID;

	private root: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private tooltip: HTMLElement | undefined;
	private updatedLabel: HTMLElement | undefined;
	private refreshIcon: HTMLElement | undefined;
	private presetButtons: { key: ParadisRtkPresetKey; button: HTMLButtonElement }[] = [];
	private granularityButtons: { granularity: ParadisRtkGranularity; button: HTMLButtonElement }[] = [];

	private readonly client: ParadisRtkClient;
	private readonly bodyDisposables = this._register(new DisposableStore());
	private readonly relayoutScheduler = this._register(new RunOnceScheduler(() => this.renderBody(), 100));

	private presetKey: ParadisRtkPresetKey = '7d';
	private granularity: ParadisRtkGranularity = 'daily';
	private data: IParadisRtkDashboardData | undefined;
	private lastError: string | undefined;
	private loading = false;
	private lastRenderedWidth = 0;
	private lastTooltipSignature: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(PARADIS_RTK_EDITOR_ID, group, telemetryService, themeService, storageService);
		this.client = instantiationService.createInstance(ParadisRtkClient);
		this._register(this.themeService.onDidColorThemeChange(() => this.renderBody()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.paradis-rtk'));

		const toolbar = dom.append(this.root, $('.paradis-rtk-toolbar'));

		// 「特定の日を指す」グループと「直近N日」グループに分け、視覚的なまとまりを作る。
		const pointPresetSeg = dom.append(toolbar, $('.paradis-rtk-seg'));
		const pointPresets: { key: ParadisRtkPresetKey; label: string }[] = [
			{ key: 'today', label: localize('paradis.rtk.period.today', "今日") },
			{ key: 'yesterday', label: localize('paradis.rtk.period.yesterday', "昨日") },
			{ key: 'thisWeek', label: localize('paradis.rtk.period.thisWeek', "今週") },
			{ key: 'lastWeek', label: localize('paradis.rtk.period.lastWeek', "先週") },
		];
		const rangePresetSeg = dom.append(toolbar, $('.paradis-rtk-seg'));
		const rangePresets: { key: ParadisRtkPresetKey; label: string }[] = [
			{ key: '7d', label: localize('paradis.rtk.period.7d', "7日間") },
			{ key: '30d', label: localize('paradis.rtk.period.30d', "30日間") },
			{ key: '90d', label: localize('paradis.rtk.period.90d', "90日間") },
		];
		for (const [seg, presets] of [[pointPresetSeg, pointPresets], [rangePresetSeg, rangePresets]] as const) {
			for (const preset of presets) {
				const button = dom.append(seg, $('button')) as HTMLButtonElement;
				button.textContent = preset.label;
				this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.setPreset(preset.key)));
				this.presetButtons.push({ key: preset.key, button });
			}
		}

		const granularitySeg = dom.append(toolbar, $('.paradis-rtk-seg'));
		const granularities: { granularity: ParadisRtkGranularity; label: string }[] = [
			{ granularity: 'daily', label: localize('paradis.rtk.granularity.daily', "日次") },
			{ granularity: 'weekly', label: localize('paradis.rtk.granularity.weekly', "週次") },
		];
		for (const g of granularities) {
			const button = dom.append(granularitySeg, $('button')) as HTMLButtonElement;
			button.textContent = g.label;
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.setGranularity(g.granularity)));
			this.granularityButtons.push({ granularity: g.granularity, button });
		}

		dom.append(toolbar, $('.paradis-rtk-toolbar-spacer'));
		this.updatedLabel = dom.append(toolbar, $('.paradis-rtk-updated'));

		const refresh = dom.append(toolbar, $('button.paradis-rtk-refresh')) as HTMLButtonElement;
		this.refreshIcon = dom.append(refresh, $(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		dom.append(refresh, $('span')).textContent = localize('paradis.rtk.refresh', "更新");
		this._register(dom.addDisposableListener(refresh, dom.EventType.CLICK, () => this.refresh(true)));

		this.body = dom.append(this.root, $('.paradis-rtk-body'));
		this.tooltip = dom.append(this.root, $('.paradis-rtk-tooltip'));

		this.updateFilterButtons();
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.data && !this.loading) {
			this.refresh();
		}
	}

	override layout(_dimension: dom.Dimension): void {
		const width = this.body?.clientWidth ?? 0;
		if (this.data && Math.abs(width - this.lastRenderedWidth) > 4) {
			this.relayoutScheduler.schedule();
		}
	}

	override focus(): void {
		super.focus();
		this.body?.focus();
	}

	private setPreset(key: ParadisRtkPresetKey): void {
		if (this.presetKey === key) {
			return;
		}
		this.presetKey = key;
		this.updateFilterButtons();
		// データは常に全期間ぶん保持しているので、期間切り替えは再描画(日付スライス)だけで済む
		this.renderBody();
	}

	private setGranularity(granularity: ParadisRtkGranularity): void {
		if (this.granularity === granularity) {
			return;
		}
		this.granularity = granularity;
		this.updateFilterButtons();
		this.renderBody();
	}

	private currentRange(): IDateRange {
		// 期間の基準は集計を出したマシンの今日。接続先と時差があると、手元の日付で切ると1日ずれる。
		return presetRange(this.presetKey, this.data ? parseLocalDate(this.data.today) : new Date());
	}

	/** 週別表示は最低7日分ないと意味がないため、短い期間では強制的に日次にする。 */
	private effectiveGranularity(rangeDays: number): ParadisRtkGranularity {
		return rangeDays < 7 ? 'daily' : this.granularity;
	}

	/** KPI カードのラベルに差し込む期間名。 */
	private periodLabel(): string {
		switch (this.presetKey) {
			case 'today': return localize('paradis.rtk.period.today', "今日");
			case 'yesterday': return localize('paradis.rtk.period.yesterday', "昨日");
			case 'thisWeek': return localize('paradis.rtk.period.thisWeek', "今週");
			case 'lastWeek': return localize('paradis.rtk.period.lastWeek', "先週");
			case '7d': return localize('paradis.rtk.period.7d', "7日間");
			case '30d': return localize('paradis.rtk.period.30d', "30日間");
			case '90d': return localize('paradis.rtk.period.90d', "90日間");
		}
	}

	private updateFilterButtons(): void {
		for (const { key, button } of this.presetButtons) {
			button.classList.toggle('checked', this.presetKey === key);
		}
		const range = this.currentRange();
		const rangeDays = spanDaysInclusive(range.from, range.to);
		const effective = this.effectiveGranularity(rangeDays);
		for (const { granularity, button } of this.granularityButtons) {
			button.classList.toggle('checked', granularity === effective);
			if (granularity === 'weekly') {
				button.disabled = rangeDays < 7;
				button.title = rangeDays < 7 ? localize('paradis.rtk.granularity.tooShort', "選択中の期間が短いため週次では表示できません") : '';
			}
		}
	}

	private async refresh(bypassCache = false): Promise<void> {
		if (this.loading || !this.body) {
			return;
		}
		this.loading = true;
		this.lastError = undefined;
		this.refreshIcon?.classList.add('spin');
		if (this.data) {
			// 再取得中は前回の描画を薄く保持する(スケルトンやレイアウトジャンプを避ける)
			this.body.classList.add('stale');
		} else {
			dom.clearNode(this.body);
			const message = dom.append(this.body, $('.paradis-rtk-message'));
			dom.append(message, $(`span${ThemeIcon.asCSSSelector(Codicon.loading)}.codicon-modifier-spin`));
			message.appendChild(this.body.ownerDocument.createTextNode(
				localize('paradis.rtk.loading', "rtk の集計を取得しています…")));
		}
		try {
			this.data = await this.client.fetchDashboard(bypassCache);
		} catch (error) {
			if (isParadisRtkNotFoundError(error)) {
				// SSH 接続中は接続先の rtk を実行するので、どちらのマシンに入れる話かを書き分ける
				// (手元に入っているのに見つからない、という誤解を避けるため)。
				// 接続先の PATH は SSH の非対話起動で決まるため、ターミナルでは動くのにここでは
				// 見つからないことがある。「入れてあるのに」で詰まらないよう設定へも誘導する。
				this.lastError = this.client.isRemote
					? localize('paradis.rtk.notFoundRemote', "接続先（{0}）の PATH に rtk が見つかりません。SSH 接続中は接続先に貯まった節約量を表示します。接続先へインストールするか、接続先のマシン設定 paradis.rtk.executablePath に rtk の絶対パスを指定してください。", this.client.remoteHostLabel ?? '')
					: localize('paradis.rtk.notFound', "rtk が見つかりません。https://github.com/rtk-ai/rtk からインストールしてください。");
			} else {
				this.lastError = localize('paradis.rtk.error', "rtk の実行に失敗しました: {0}", error instanceof Error ? error.message : String(error));
			}
		} finally {
			this.loading = false;
			this.refreshIcon?.classList.remove('spin');
			this.body.classList.remove('stale');
			this.renderBody();
		}
	}

	// ---------- rendering ----------

	private get accent(): string {
		const type = this.themeService.getColorTheme().type;
		return type === ColorScheme.LIGHT || type === ColorScheme.HIGH_CONTRAST_LIGHT ? ACCENT_LIGHT : ACCENT_DARK;
	}

	private renderBody(): void {
		if (!this.body) {
			return;
		}
		this.bodyDisposables.clear();
		dom.clearNode(this.body);
		this.hideTooltip();
		this.lastRenderedWidth = this.body.clientWidth;

		if (this.updatedLabel) {
			this.updatedLabel.textContent = this.data
				? localize('paradis.rtk.updatedAt', "{0} 更新", new Date(this.data.fetchedAt).toLocaleTimeString())
				: '';
		}

		if (this.lastError && !this.data) {
			const message = dom.append(this.body, $('.paradis-rtk-message'));
			dom.append(message, $(`span${ThemeIcon.asCSSSelector(Codicon.warning)}`));
			message.appendChild(this.body.ownerDocument.createTextNode(this.lastError));
			return;
		}
		if (!this.data) {
			return;
		}

		if (this.data.failedReports.length > 0) {
			dom.append(this.body, $('.paradis-rtk-note')).textContent =
				localize('paradis.rtk.partial', "一部の集計を取得できませんでした: {0}", this.data.failedReports.join('、'));
		}
		if (this.lastError) {
			dom.append(this.body, $('.paradis-rtk-note')).textContent =
				localize('paradis.rtk.refreshFailed', "更新に失敗しました(前回の内容を表示しています): {0}", this.lastError);
		}

		const range = this.currentRange();
		const days = this.data.days.filter(day => day.date >= range.from && day.date <= range.to);

		if (days.length === 0) {
			dom.append(this.body, $('.paradis-rtk-message')).textContent =
				localize('paradis.rtk.noData', "選択した期間には rtk の記録がありません。");
		} else {
			this.renderKpis(this.body, days);
			const granularity = this.effectiveGranularity(spanDaysInclusive(range.from, range.to));
			const chartCard = dom.append(this.body, $('.paradis-rtk-card'));
			this.renderSavedChart(chartCard, computeBuckets(days, granularity), granularity);
		}

		const grid = dom.append(this.body, $('.paradis-rtk-grid2'));
		this.renderCommandBreakdown(dom.append(grid, $('.paradis-rtk-card')));
		this.renderHistory(dom.append(grid, $('.paradis-rtk-card')));
	}

	private renderKpis(container: HTMLElement, days: IParadisRtkDayData[]): void {
		const kpis = dom.append(container, $('.paradis-rtk-kpis'));
		const accent = this.accent;

		// 1枚目: 今日の節約量。期間フィルターに関わらず常に今日を出す(ステータスバーと同じ値)。
		const today = this.data?.days.find(day => day.date === this.data?.today);
		const todaySaved = today?.savedTokens ?? 0;
		const todayPercent = paradisRtkSavingsPercent(todaySaved, today?.inputTokens ?? 0);
		const todayTile = dom.append(kpis, $('.paradis-rtk-card'));
		dom.append(todayTile, $('.paradis-rtk-stat-label')).textContent = localize('paradis.rtk.kpi.today', "今日の節約トークン数");
		const todayValue = dom.append(todayTile, $('.paradis-rtk-stat-value.hero'));
		todayValue.textContent = paradisRtkFormatTokens(todaySaved);
		todayValue.style.color = accent;
		const track = dom.append(todayTile, $('.paradis-rtk-meter-track'));
		track.style.background = `color-mix(in srgb, ${accent} 22%, transparent)`;
		const fill = dom.append(track, $('.paradis-rtk-meter-fill'));
		fill.style.width = `${Math.max(0, Math.min(100, todayPercent)).toFixed(1)}%`;
		fill.style.background = accent;
		dom.append(todayTile, $('.paradis-rtk-stat-sub')).textContent =
			localize('paradis.rtk.kpi.todaySub', "節約率 {0}%", todayPercent.toFixed(1));

		const periodCommands = days.reduce((sum, day) => sum + day.commands, 0);
		const periodSaved = days.reduce((sum, day) => sum + day.savedTokens, 0);
		const periodInput = days.reduce((sum, day) => sum + day.inputTokens, 0);

		const commandsTile = dom.append(kpis, $('.paradis-rtk-card'));
		dom.append(commandsTile, $('.paradis-rtk-stat-label')).textContent =
			localize('paradis.rtk.kpi.commands', "コマンド数（{0}）", this.periodLabel());
		dom.append(commandsTile, $('.paradis-rtk-stat-value')).textContent = periodCommands.toLocaleString();
		dom.append(commandsTile, $('.paradis-rtk-stat-sub')).textContent =
			localize('paradis.rtk.kpi.commandsSub', "1日あたり {0}", Math.round(periodCommands / days.length).toLocaleString());

		const rateTile = dom.append(kpis, $('.paradis-rtk-card'));
		dom.append(rateTile, $('.paradis-rtk-stat-label')).textContent =
			localize('paradis.rtk.kpi.rate', "平均節約率（{0}）", this.periodLabel());
		dom.append(rateTile, $('.paradis-rtk-stat-value')).textContent = `${paradisRtkSavingsPercent(periodSaved, periodInput).toFixed(1)}%`;
		dom.append(rateTile, $('.paradis-rtk-stat-sub')).textContent =
			localize('paradis.rtk.kpi.rateSub', "節約 {0} / 入力 {1}", paradisRtkFormatTokens(periodSaved), paradisRtkFormatTokens(periodInput));

		const totals = this.data?.totals;
		const totalTile = dom.append(kpis, $('.paradis-rtk-card'));
		dom.append(totalTile, $('.paradis-rtk-stat-label')).textContent = localize('paradis.rtk.kpi.total', "累計節約トークン数");
		dom.append(totalTile, $('.paradis-rtk-stat-value')).textContent = paradisRtkFormatTokens(totals?.savedTokens ?? 0);
		dom.append(totalTile, $('.paradis-rtk-stat-sub')).textContent =
			localize('paradis.rtk.kpi.totalSub', "全期間 · {0} コマンド", (totals?.commands ?? 0).toLocaleString());
	}

	// ---------- daily bar chart ----------

	private renderSavedChart(card: HTMLElement, buckets: IBucket[], granularity: ParadisRtkGranularity): void {
		dom.append(card, $('h3')).textContent = granularity === 'weekly'
			? localize('paradis.rtk.chart.titleWeekly', "週別節約推移")
			: localize('paradis.rtk.chart.title', "日別節約推移");
		dom.append(card, $('.desc')).textContent = localize('paradis.rtk.chart.desc', "rtk が削減したトークン数。バーにカーソルを合わせると内訳が出ます。");

		const doc = card.ownerDocument;
		const accent = this.accent;
		const width = Math.max(320, card.clientWidth > 0 ? card.clientWidth - 34 : (this.body?.clientWidth ?? 720) - 74);
		const height = 235;
		const padL = 52; const padR = 8; const padT = 14; const padB = 20;
		const plotW = width - padL - padR;
		const plotH = height - padT - padB;

		const svg = svgEl(doc, 'svg', { width: String(width), height: String(height), viewBox: `0 0 ${width} ${height}` });
		card.appendChild(svg);

		const maxSaved = Math.max(1, ...buckets.map(bucket => bucket.savedTokens));
		const step = niceStep(maxSaved * 1.12 / 4);
		const maxY = step * 4;
		const y = (v: number) => padT + plotH - (v / maxY) * plotH;

		for (let i = 0; i <= 4; i++) {
			const value = step * i;
			const line = svgEl(doc, 'line', { x1: String(padL), x2: String(width - padR), y1: String(y(value)), y2: String(y(value)), 'stroke-width': '1' });
			line.style.stroke = i === 0 ? 'color-mix(in srgb, var(--vscode-foreground) 28%, transparent)' : 'color-mix(in srgb, var(--vscode-foreground) 10%, transparent)';
			svg.appendChild(line);
			const tick = svgEl(doc, 'text', { x: String(padL - 6), y: String(y(value) + 3), 'text-anchor': 'end', class: 'paradis-rtk-axis-text' });
			tick.textContent = paradisRtkFormatTokens(value);
			svg.appendChild(tick);
		}

		const band = plotW / Math.max(1, buckets.length);
		const barW = Math.max(2, Math.min(24, band * 0.6));
		const labelEvery = Math.max(1, Math.ceil(34 / band));
		const maxIndex = buckets.reduce((best, bucket, i) => (bucket.savedTokens > buckets[best].savedTokens ? i : best), 0);

		buckets.forEach((bucket, index) => {
			const cx = padL + band * index + band / 2;
			const x0 = cx - barW / 2;
			const yTop = y(bucket.savedTokens);
			const h = Math.max(1, y(0) - yTop);
			if (barW >= 8) {
				// 上端のみ 4px 丸め(データ端)、ベースラインは角のまま
				const r = Math.min(4, barW / 2, h);
				const path = svgEl(doc, 'path', {
					d: `M${x0},${y(0)} L${x0},${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} L${x0 + barW - r},${yTop} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} L${x0 + barW},${y(0)} Z`
				});
				path.style.fill = accent;
				svg.appendChild(path);
			} else {
				const rect = svgEl(doc, 'rect', { x: String(x0), y: String(yTop), width: String(barW), height: String(h) });
				rect.style.fill = accent;
				svg.appendChild(rect);
			}

			if (index % labelEvery === 0) {
				const label = svgEl(doc, 'text', { x: String(cx), y: String(height - 6), 'text-anchor': 'middle', class: 'paradis-rtk-axis-text' });
				label.textContent = bucket.axisLabel;
				svg.appendChild(label);
			}
			if (index === maxIndex && bucket.savedTokens > 0) {
				const label = svgEl(doc, 'text', { x: String(cx), y: String(yTop - 5), 'text-anchor': 'middle', class: 'paradis-rtk-direct-label' });
				label.textContent = paradisRtkFormatTokens(bucket.savedTokens);
				svg.appendChild(label);
			}

			// ヒットターゲットはバー本体より広く(バンド全体)
			const hit = svgEl(doc, 'rect', { x: String(padL + band * index), y: String(padT), width: String(band), height: String(plotH), fill: 'transparent' });
			this.bodyDisposables.add(dom.addDisposableListener(hit, dom.EventType.POINTER_MOVE, e => {
				this.showTooltip(e, bucket.tooltipLabel, [
					{ color: accent, name: localize('paradis.rtk.tooltip.saved', "節約トークン"), value: paradisRtkFormatTokens(bucket.savedTokens) },
					{ name: localize('paradis.rtk.tooltip.input', "入力トークン"), value: paradisRtkFormatTokens(bucket.inputTokens) },
					{ name: localize('paradis.rtk.tooltip.rate', "節約率"), value: `${paradisRtkSavingsPercent(bucket.savedTokens, bucket.inputTokens).toFixed(1)}%` },
					{ name: localize('paradis.rtk.tooltip.commands', "コマンド数"), value: bucket.commands.toLocaleString() },
				]);
			}));
			this.bodyDisposables.add(dom.addDisposableListener(hit, dom.EventType.POINTER_LEAVE, () => this.hideTooltip()));
			svg.appendChild(hit);
		});
	}

	// ---------- command breakdown / history ----------

	private renderCommandBreakdown(card: HTMLElement): void {
		dom.append(card, $('h3')).textContent = localize('paradis.rtk.commands.title', "コマンド別内訳");
		dom.append(card, $('.desc')).textContent = localize('paradis.rtk.commands.desc', "節約量の多い順 · 全期間（期間フィルターの対象外）");

		const commands = (this.data?.commands ?? []).slice(0, MAX_COMMAND_ROWS);
		if (commands.length === 0) {
			dom.append(card, $('.paradis-rtk-note')).textContent = localize('paradis.rtk.commands.none', "コマンド別の記録がありません。");
			return;
		}

		const accent = this.accent;
		const maxSaved = Math.max(1, ...commands.map(row => row.savedTokens));
		for (const row of commands) {
			const item = dom.append(card, $('.paradis-rtk-hbar-row'));
			const name = dom.append(item, $('span.name'));
			name.textContent = row.command;
			name.title = localize('paradis.rtk.commands.rowTooltip', "{0} · {1} 回 · 平均節約率 {2}% · 平均 {3}",
				row.command, row.count.toLocaleString(), row.avgSavingsPct.toFixed(1), formatDuration(row.avgTimeMs));
			const track = dom.append(item, $('.track'));
			const bar = dom.append(track, $('.bar'));
			bar.style.width = `${Math.min(100, Math.max(1, (row.savedTokens / maxSaved) * 100)).toFixed(1)}%`;
			bar.style.background = accent;
			dom.append(item, $('span.val')).textContent = paradisRtkFormatTokens(row.savedTokens);
		}
	}

	private renderHistory(card: HTMLElement): void {
		dom.append(card, $('h3')).textContent = localize('paradis.rtk.history.title', "直近のコマンド");
		dom.append(card, $('.desc')).textContent = localize('paradis.rtk.history.desc', "新しい順（期間フィルターの対象外）");

		const history = (this.data?.history ?? []).slice(0, MAX_HISTORY_ROWS);
		if (history.length === 0) {
			dom.append(card, $('.paradis-rtk-note')).textContent = localize('paradis.rtk.history.none', "実行の記録がありません。");
			return;
		}

		const table = dom.append(card, $('table.paradis-rtk-history'));
		const headRow = dom.append(dom.append(table, $('thead')), $('tr'));
		dom.append(headRow, $('th')).textContent = localize('paradis.rtk.history.time', "時刻");
		dom.append(headRow, $('th')).textContent = localize('paradis.rtk.history.command', "コマンド");
		dom.append(headRow, $('th.num')).textContent = localize('paradis.rtk.history.rate', "節約率");
		dom.append(headRow, $('th.num')).textContent = localize('paradis.rtk.history.tokens', "トークン");
		const tbody = dom.append(table, $('tbody'));
		for (const entry of history) {
			const row = dom.append(tbody, $('tr'));
			dom.append(row, $('td')).textContent = entry.timestampLabel;
			const commandCell = dom.append(row, $('td'));
			commandCell.textContent = entry.command;
			commandCell.title = entry.command;
			dom.append(row, $('td.num')).textContent = `${entry.savingsPct.toFixed(0)}%`;
			dom.append(row, $('td.num')).textContent = paradisRtkFormatTokens(entry.tokens);
		}
	}

	// ---------- tooltip ----------

	private showTooltip(e: PointerEvent, title: string, rows: ITooltipRow[]): void {
		if (!this.tooltip || !this.root) {
			return;
		}
		// pointermove ごとの DOM 再構築を避ける(同じ内容なら位置更新だけ)
		const signature = `${title}|${rows.map(row => `${row.name}=${row.value}`).join('|')}`;
		if (signature !== this.lastTooltipSignature) {
			this.lastTooltipSignature = signature;
			dom.clearNode(this.tooltip);
			dom.append(this.tooltip, $('.tt-title')).textContent = title;
			for (const row of rows) {
				const rowEl = dom.append(this.tooltip, $('.tt-row'));
				if (row.color) {
					dom.append(rowEl, $('.tt-key')).style.background = row.color;
				}
				dom.append(rowEl, $('.tt-name')).textContent = row.name;
				dom.append(rowEl, $('.tt-val')).textContent = row.value;
			}
		}
		this.tooltip.style.display = 'block';
		const rootRect = this.root.getBoundingClientRect();
		let left = e.clientX - rootRect.left + 14;
		let top = e.clientY - rootRect.top + 14;
		left = Math.min(left, rootRect.width - this.tooltip.offsetWidth - 8);
		top = Math.min(top, rootRect.height - this.tooltip.offsetHeight - 8);
		this.tooltip.style.left = `${Math.max(0, left)}px`;
		this.tooltip.style.top = `${Math.max(0, top)}px`;
	}

	private hideTooltip(): void {
		if (this.tooltip) {
			this.tooltip.style.display = 'none';
			this.lastTooltipSignature = undefined;
		}
	}
}

interface ITooltipRow {
	readonly color?: string;
	readonly name: string;
	readonly value: string;
}

// ---------- helpers ----------

function svgEl(doc: Document, tag: string, attrs: Record<string, string>): SVGElement {
	const el = doc.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElement;
	for (const [key, value] of Object.entries(attrs)) {
		el.setAttribute(key, value);
	}
	return el;
}

/** 4分割の軸目盛りがきれいな数(1/2/2.5/5 × 10^n)になるステップを選ぶ。 */
function niceStep(rawStep: number): number {
	let magnitude = 1;
	for (let i = 0; i < 14; i++) {
		for (const multiplier of [1, 2, 2.5, 5]) {
			const candidate = magnitude * multiplier;
			if (candidate >= rawStep) {
				return candidate;
			}
		}
		magnitude *= 10;
	}
	return magnitude;
}

/** "YYYY-MM-DD" をローカル時刻の Date に変換する(タイムゾーン変換を避けるため Date.parse は使わない)。 */
function parseLocalDate(isoDate: string): Date {
	const [y, m, d] = isoDate.split('-').map(Number);
	return new Date(y, m - 1, d);
}

function addDaysLocal(date: Date, delta: number): Date {
	const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	d.setDate(d.getDate() + delta);
	return d;
}

/** 月曜始まりの週の開始日を返す。 */
function startOfWeekMonday(date: Date): Date {
	const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const dow = d.getDay();
	return addDaysLocal(d, dow === 0 ? -6 : 1 - dow);
}

/** 両端を含む日数。 */
function spanDaysInclusive(from: string, to: string): number {
	return Math.round((parseLocalDate(to).getTime() - parseLocalDate(from).getTime()) / 86400000) + 1;
}

/** プリセットキーを実際の日付レンジ(両端含む、YYYY-MM-DD)に変換する。 */
function presetRange(key: ParadisRtkPresetKey, today: Date): IDateRange {
	const todayStr = paradisRtkLocalDateString(today);
	switch (key) {
		case 'today':
			return { from: todayStr, to: todayStr };
		case 'yesterday': {
			const y = paradisRtkLocalDateString(addDaysLocal(today, -1));
			return { from: y, to: y };
		}
		case 'thisWeek':
			return { from: paradisRtkLocalDateString(startOfWeekMonday(today)), to: todayStr };
		case 'lastWeek': {
			const thisStart = startOfWeekMonday(today);
			return { from: paradisRtkLocalDateString(addDaysLocal(thisStart, -7)), to: paradisRtkLocalDateString(addDaysLocal(thisStart, -1)) };
		}
		case '7d':
			return { from: paradisRtkLocalDateString(addDaysLocal(today, -6)), to: todayStr };
		case '30d':
			return { from: paradisRtkLocalDateString(addDaysLocal(today, -29)), to: todayStr };
		case '90d':
			return { from: paradisRtkLocalDateString(addDaysLocal(today, -89)), to: todayStr };
	}
}

/**
 * 日別データを表示単位(日次/週次)のバケットへ集計する。週次は月曜始まりの週ごとに合算する。
 * バケットは日付昇順で返す。
 */
function computeBuckets(days: IParadisRtkDayData[], granularity: ParadisRtkGranularity): IBucket[] {
	if (granularity === 'daily') {
		return days.map(day => ({
			axisLabel: shortDate(day.date),
			tooltipLabel: day.date,
			commands: day.commands,
			inputTokens: day.inputTokens,
			savedTokens: day.savedTokens,
		}));
	}

	const byWeek = new Map<string, { commands: number; inputTokens: number; savedTokens: number }>();
	for (const day of days) {
		const weekStart = paradisRtkLocalDateString(startOfWeekMonday(parseLocalDate(day.date)));
		const bucket = byWeek.get(weekStart) ?? { commands: 0, inputTokens: 0, savedTokens: 0 };
		bucket.commands += day.commands;
		bucket.inputTokens += day.inputTokens;
		bucket.savedTokens += day.savedTokens;
		byWeek.set(weekStart, bucket);
	}
	return [...byWeek.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([weekStart, bucket]) => ({
			axisLabel: shortDate(weekStart),
			tooltipLabel: localize('paradis.rtk.weekOf', "{0} の週", shortDate(weekStart)),
			...bucket,
		}));
}

/** "2026-07-04" → "7/4"。 */
function shortDate(isoDate: string): string {
	const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(isoDate);
	return match ? `${Number(match[1])}/${Number(match[2])}` : isoDate;
}

/** 平均実行時間の表示(ツールチップ用)。 */
function formatDuration(milliseconds: number): string {
	if (milliseconds >= 1000) {
		return `${(milliseconds / 1000).toFixed(1)}s`;
	}
	return `${Math.round(milliseconds)}ms`;
}
