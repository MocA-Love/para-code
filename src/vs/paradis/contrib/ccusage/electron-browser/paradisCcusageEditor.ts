/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ccusage ダッシュボードの EditorPane。ccusage CLI の集計結果(shared process 経由)を
// KPI カード・モデル別積み上げバー・トークン推移・プロジェクト/セッション一覧として描画する。
// チャートは素の SVG DOM で構築し、workbench テーマのCSS変数+固定のカテゴリカルパレット
// (ダーク/ライト両方で色覚多様性・コントラスト検証済み)を使う。

import './media/paradisCcusage.css';
import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
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
import { ParadisCcusageAgent } from '../common/paradisCcusage.js';
import { FETCH_WINDOW_DAYS, IParadisCcusageDashboardData, IParadisCcusageDayData, IParadisCcusageModelSlice, ParadisCcusageClient } from './paradisCcusageClient.js';
import { PARADIS_CCUSAGE_EDITOR_ID } from './paradisCcusageInput.js';

const $ = dom.$;

/**
 * カテゴリカルパレット(モデル系列)。ダーク面/ライト面それぞれで検証済みの固定順。
 * 順序自体が色覚多様性対策(隣接ΔE最大化)なので並べ替えないこと。
 */
const SERIES_DARK = ['#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767', '#d95926', '#d55181', '#008300'];
const SERIES_LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#4a3aa7', '#e34948', '#eb6834', '#e87ba4', '#008300'];
/** プロジェクト別(量の軸)用の順次パレット(濃い=大きい)。 */
const SEQ_DARK = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'];
const SEQ_LIGHT = ['#0d366b', '#184f95', '#256abf', '#3987e5', '#86b6ef'];
/** 「その他」に畳んだ系列のニュートラル色。 */
const OTHER_COLOR = '#898781';

/** 積み上げ対象のモデル数上限(超過分は「その他」へ畳む)。 */
const MAX_MODEL_SERIES = 7;
const MAX_PROJECT_ROWS = 5;
const MAX_SESSION_ROWS = 8;

type AgentFilter = 'all' | ParadisCcusageAgent;

/** 期間プリセット。'custom' のときは常に customRange が設定されている。 */
type ParadisCcusagePresetKey = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | '7d' | '30d' | '90d' | 'custom';
/** チャートの表示単位。7日未満の期間では daily に強制される(effectiveGranularity 参照)。 */
type ParadisCcusageGranularity = 'daily' | 'weekly';

interface IDateRange {
	/** YYYY-MM-DD、この日を含む。 */
	readonly from: string;
	/** YYYY-MM-DD、この日を含む。 */
	readonly to: string;
}

/** 日別/週別チャートの1本のバー・ポイントに対応する集計単位。 */
interface IBucket {
	/** ソート用キー(バケット開始日、YYYY-MM-DD)。 */
	readonly key: string;
	/** X軸目盛り用の短いラベル(例: "7/4")。 */
	readonly axisLabel: string;
	/** ツールチップ見出し用のラベル(daily は正確な日付、weekly は "Week of 7/4" 形式)。 */
	readonly tooltipLabel: string;
	readonly models: IParadisCcusageModelSlice[];
}

interface IModelTotal {
	readonly model: string;
	readonly agent: ParadisCcusageAgent;
	cost: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
}

export class ParadisCcusageEditor extends EditorPane {

	static readonly ID = PARADIS_CCUSAGE_EDITOR_ID;

	private root: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private tooltip: HTMLElement | undefined;
	private updatedLabel: HTMLElement | undefined;
	private refreshIcon: HTMLElement | undefined;
	private presetButtons: { key: ParadisCcusagePresetKey; button: HTMLButtonElement }[] = [];
	private granularityButtons: { granularity: ParadisCcusageGranularity; button: HTMLButtonElement }[] = [];
	private agentButtons: { agent: AgentFilter; button: HTMLButtonElement }[] = [];
	private customRangeRow: HTMLElement | undefined;
	private customFromInput: HTMLInputElement | undefined;
	private customToInput: HTMLInputElement | undefined;

	private readonly client: ParadisCcusageClient;
	private readonly bodyDisposables = this._register(new DisposableStore());
	private readonly relayoutScheduler = this._register(new RunOnceScheduler(() => this.renderBody(), 100));

	private presetKey: ParadisCcusagePresetKey = '30d';
	private customRange: IDateRange | undefined;
	private granularity: ParadisCcusageGranularity = 'daily';
	private agentFilter: AgentFilter = 'all';
	private data: IParadisCcusageDashboardData | undefined;
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
		super(PARADIS_CCUSAGE_EDITOR_ID, group, telemetryService, themeService, storageService);
		this.client = instantiationService.createInstance(ParadisCcusageClient);
		this._register(this.themeService.onDidColorThemeChange(() => this.renderBody()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.paradis-ccusage'));

		// フィルター行(1行・下の全カードに適用)
		const toolbar = dom.append(this.root, $('.paradis-ccusage-toolbar'));

		// プリセットは「特定の日を指す」グループと「直近N日/カスタム」グループの2つの seg に分け、
		// 視覚的にまとまりを作る(ボタンが増えても1グループの見た目は詰まりすぎない)。
		const pointPresetSeg = dom.append(toolbar, $('.paradis-ccusage-seg'));
		const pointPresets: { key: ParadisCcusagePresetKey; label: string }[] = [
			{ key: 'today', label: localize('paradis.ccusage.period.today', "Today") },
			{ key: 'yesterday', label: localize('paradis.ccusage.period.yesterday', "Yesterday") },
			{ key: 'thisWeek', label: localize('paradis.ccusage.period.thisWeek', "This Week") },
			{ key: 'lastWeek', label: localize('paradis.ccusage.period.lastWeek', "Last Week") },
		];
		for (const preset of pointPresets) {
			const button = dom.append(pointPresetSeg, $('button')) as HTMLButtonElement;
			button.textContent = preset.label;
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.setPreset(preset.key)));
			this.presetButtons.push({ key: preset.key, button });
		}

		const rangePresetSeg = dom.append(toolbar, $('.paradis-ccusage-seg'));
		const rangePresets: { key: ParadisCcusagePresetKey; label: string }[] = [
			{ key: '7d', label: localize('paradis.ccusage.period.7d', "7 Days") },
			{ key: '30d', label: localize('paradis.ccusage.period.30d', "30 Days") },
			{ key: '90d', label: localize('paradis.ccusage.period.90d', "90 Days") },
			{ key: 'custom', label: localize('paradis.ccusage.period.custom', "Custom…") },
		];
		for (const preset of rangePresets) {
			const button = dom.append(rangePresetSeg, $('button')) as HTMLButtonElement;
			button.textContent = preset.label;
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				if (preset.key === 'custom') {
					this.toggleCustomRangePanel();
				} else {
					this.setPreset(preset.key);
				}
			}));
			this.presetButtons.push({ key: preset.key, button });
		}

		const granularitySeg = dom.append(toolbar, $('.paradis-ccusage-seg'));
		const granularities: { granularity: ParadisCcusageGranularity; label: string }[] = [
			{ granularity: 'daily', label: localize('paradis.ccusage.granularity.daily', "Daily") },
			{ granularity: 'weekly', label: localize('paradis.ccusage.granularity.weekly', "Weekly") },
		];
		for (const g of granularities) {
			const button = dom.append(granularitySeg, $('button')) as HTMLButtonElement;
			button.textContent = g.label;
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.setGranularity(g.granularity)));
			this.granularityButtons.push({ granularity: g.granularity, button });
		}

		const agentSeg = dom.append(toolbar, $('.paradis-ccusage-seg'));
		const agents: { agent: AgentFilter; label: string }[] = [
			{ agent: 'all', label: localize('paradis.ccusage.agent.all', "All Agents") },
			{ agent: 'claude', label: 'Claude Code' },
			{ agent: 'codex', label: 'Codex' },
			{ agent: 'gemini', label: 'Gemini' },
		];
		for (const agent of agents) {
			const button = dom.append(agentSeg, $('button')) as HTMLButtonElement;
			button.textContent = agent.label;
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.setAgentFilter(agent.agent)));
			this.agentButtons.push({ agent: agent.agent, button });
		}

		dom.append(toolbar, $('.paradis-ccusage-toolbar-spacer'));
		this.updatedLabel = dom.append(toolbar, $('.paradis-ccusage-updated'));

		const refresh = dom.append(toolbar, $('button.paradis-ccusage-refresh')) as HTMLButtonElement;
		this.refreshIcon = dom.append(refresh, $(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		dom.append(refresh, $('span')).textContent = localize('paradis.ccusage.refresh', "Refresh");
		this._register(dom.addDisposableListener(refresh, dom.EventType.CLICK, () => this.refresh(true)));

		// 「カスタム…」選択時にツールバー下に開く日付範囲入力(常に取得済みの90日窓の中に制限)
		this.customRangeRow = dom.append(this.root, $('.paradis-ccusage-custom-range'));
		this.customFromInput = dom.append(this.customRangeRow, $('input')) as HTMLInputElement;
		this.customFromInput.type = 'date';
		dom.append(this.customRangeRow, $('span.arrow')).textContent = '→';
		this.customToInput = dom.append(this.customRangeRow, $('input')) as HTMLInputElement;
		this.customToInput.type = 'date';
		const applyButton = dom.append(this.customRangeRow, $('button')) as HTMLButtonElement;
		applyButton.textContent = localize('paradis.ccusage.customRange.apply', "Apply");
		this._register(dom.addDisposableListener(applyButton, dom.EventType.CLICK, () => this.applyCustomRange()));

		this.body = dom.append(this.root, $('.paradis-ccusage-body'));
		this.tooltip = dom.append(this.root, $('.paradis-ccusage-tooltip'));

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

	private setPreset(key: ParadisCcusagePresetKey): void {
		if (this.presetKey === key && !this.customRange) {
			return;
		}
		this.presetKey = key;
		this.customRange = undefined;
		this.customRangeRow?.classList.remove('open');
		this.updateFilterButtons();
		// データは常に90日分保持しているので、期間切り替えは再描画(日付スライス)だけで済む
		this.renderBody();
	}

	private setGranularity(granularity: ParadisCcusageGranularity): void {
		if (this.granularity === granularity) {
			return;
		}
		this.granularity = granularity;
		this.updateFilterButtons();
		this.renderBody();
	}

	private toggleCustomRangePanel(): void {
		if (!this.customRangeRow || !this.customFromInput || !this.customToInput) {
			return;
		}
		const opening = !this.customRangeRow.classList.contains('open');
		if (opening) {
			// 開くたびに範囲(取得済みの90日窓)を最新化する。タブを長時間開きっぱなしでも日付がずれない。
			const today = new Date();
			const minStr = localDateString(addDaysLocal(today, -(FETCH_WINDOW_DAYS - 1)));
			const maxStr = localDateString(today);
			this.customFromInput.min = minStr;
			this.customFromInput.max = maxStr;
			this.customToInput.min = minStr;
			this.customToInput.max = maxStr;
			this.customFromInput.value ||= this.customRange?.from ?? minStr;
			this.customToInput.value ||= this.customRange?.to ?? maxStr;
		}
		this.customRangeRow.classList.toggle('open', opening);
	}

	private applyCustomRange(): void {
		if (!this.customFromInput?.value || !this.customToInput?.value) {
			return;
		}
		// <input type=date> の min/max はピッカー操作の補助でしかなく、値そのものは窓外でも
		// 確定しうる(特にタブを日をまたいで開きっぱなしにした場合)ため、取得済みの90日窓へ改めてクランプする。
		const today = new Date();
		const minStr = localDateString(addDaysLocal(today, -(FETCH_WINDOW_DAYS - 1)));
		const maxStr = localDateString(today);
		const clamp = (value: string) => value < minStr ? minStr : (value > maxStr ? maxStr : value);
		let from = clamp(this.customFromInput.value);
		let to = clamp(this.customToInput.value);
		if (from > to) {
			[from, to] = [to, from];
		}
		this.customRange = { from, to };
		this.presetKey = 'custom';
		this.customRangeRow?.classList.remove('open');
		this.updateFilterButtons();
		this.renderBody();
	}

	/** 選択中のプリセット/カスタム範囲を日付レンジ(両端含む)として返す。 */
	private currentRange(): IDateRange {
		return this.customRange ?? presetRange(this.presetKey, new Date());
	}

	/** 週別表示は最低7日分ないと意味がないため、短い期間では強制的に daily にする。 */
	private effectiveGranularity(rangeDays: number): ParadisCcusageGranularity {
		return rangeDays < 7 ? 'daily' : this.granularity;
	}

	/** KPI カードの「コスト」ラベルを選択中のプリセットに合わせて出し分ける。 */
	private periodLabel(): string {
		if (this.customRange) {
			return localize('paradis.ccusage.kpi.costCustom', "Cost (custom range)");
		}
		switch (this.presetKey) {
			case 'today': return localize('paradis.ccusage.kpi.costToday', "Cost (today)");
			case 'yesterday': return localize('paradis.ccusage.kpi.costYesterday', "Cost (yesterday)");
			case 'thisWeek': return localize('paradis.ccusage.kpi.costThisWeek', "Cost (this week)");
			case 'lastWeek': return localize('paradis.ccusage.kpi.costLastWeek', "Cost (last week)");
			case '7d': return localize('paradis.ccusage.kpi.costPeriod', "Cost (last {0} days)", 7);
			case '30d': return localize('paradis.ccusage.kpi.costPeriod', "Cost (last {0} days)", 30);
			case '90d': return localize('paradis.ccusage.kpi.costPeriod', "Cost (last {0} days)", 90);
			case 'custom': return localize('paradis.ccusage.kpi.costCustom', "Cost (custom range)");
		}
	}

	private setAgentFilter(agent: AgentFilter): void {
		if (this.agentFilter === agent) {
			return;
		}
		this.agentFilter = agent;
		this.updateFilterButtons();
		this.renderBody();
	}

	private updateFilterButtons(): void {
		for (const { key, button } of this.presetButtons) {
			button.classList.toggle('checked', key === 'custom' ? !!this.customRange : (!this.customRange && this.presetKey === key));
		}

		const range = this.currentRange();
		const rangeDays = spanDaysInclusive(range.from, range.to);
		const effective = this.effectiveGranularity(rangeDays);
		for (const { granularity, button } of this.granularityButtons) {
			button.classList.toggle('checked', granularity === effective);
			if (granularity === 'weekly') {
				button.disabled = rangeDays < 7;
				button.title = rangeDays < 7 ? localize('paradis.ccusage.granularity.tooShort', "Selected period is too short for a weekly view") : '';
			}
		}

		for (const { agent, button } of this.agentButtons) {
			button.classList.toggle('checked', agent === this.agentFilter);
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
			const message = dom.append(this.body, $('.paradis-ccusage-message'));
			dom.append(message, $(`span${ThemeIcon.asCSSSelector(Codicon.loading)}.codicon-modifier-spin`));
			message.appendChild(this.body.ownerDocument.createTextNode(
				localize('paradis.ccusage.loading', "Collecting usage data via ccusage… The first run may take a while.")));
		}
		try {
			this.data = await this.client.fetchDashboard(bypassCache);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.refreshIcon?.classList.remove('spin');
			this.body.classList.remove('stale');
			this.renderBody();
		}
	}

	// ---------- rendering ----------

	private get isLightTheme(): boolean {
		const type = this.themeService.getColorTheme().type;
		return type === ColorScheme.LIGHT || type === ColorScheme.HIGH_CONTRAST_LIGHT;
	}

	private get seriesPalette(): string[] {
		return this.isLightTheme ? SERIES_LIGHT : SERIES_DARK;
	}

	private get seqPalette(): string[] {
		return this.isLightTheme ? SEQ_LIGHT : SEQ_DARK;
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
				? localize('paradis.ccusage.updatedAt', "Updated {0}", new Date(this.data.fetchedAt).toLocaleTimeString())
				: '';
		}

		if (this.lastError && !this.data) {
			const message = dom.append(this.body, $('.paradis-ccusage-message'));
			dom.append(message, $(`span${ThemeIcon.asCSSSelector(Codicon.warning)}`));
			message.appendChild(this.body.ownerDocument.createTextNode(
				localize('paradis.ccusage.error', "Failed to run ccusage: {0}\n\nInstall ccusage (e.g. `npm i -g ccusage`) or set \"paradis.ccusage.executablePath\" in Settings.", this.lastError)));
			return;
		}
		if (!this.data) {
			return;
		}

		const range = this.currentRange();
		const days = this.filterDaysInRange(this.data.days, range);
		const totals = this.computeModelTotals(days);

		if (this.data.failedReports.length > 0) {
			const note = dom.append(this.body, $('.paradis-ccusage-note'));
			note.textContent = localize('paradis.ccusage.partial', "Some reports could not be loaded: {0}", this.data.failedReports.join(', '));
		}
		if (this.lastError) {
			const note = dom.append(this.body, $('.paradis-ccusage-note'));
			note.textContent = localize('paradis.ccusage.refreshFailed', "Refresh failed (showing previous data): {0}", this.lastError);
		}

		if (totals.length === 0) {
			const message = dom.append(this.body, $('.paradis-ccusage-message'));
			message.textContent = localize('paradis.ccusage.noData', "No usage data found for the selected period and agent.");
			return;
		}

		const rangeDays = spanDaysInclusive(range.from, range.to);
		const granularity = this.effectiveGranularity(rangeDays);
		const buckets = computeBuckets(days, granularity);

		this.renderKpis(this.body, days, totals);
		this.renderBlockCard(this.body);

		const grid = dom.append(this.body, $('.paradis-ccusage-grid2'));
		const left = dom.append(grid, $('.paradis-ccusage-card'));
		this.renderDailyChart(left, buckets, totals, granularity);
		const right = dom.append(grid, $('.paradis-ccusage-card'));
		this.renderModelBreakdown(right, totals);
		if (this.agentFilter === 'all' || this.agentFilter === 'claude') {
			this.renderProjects(right, range);
		}

		const grid2 = dom.append(this.body, $('.paradis-ccusage-grid2'));
		const trendCard = dom.append(grid2, $('.paradis-ccusage-card'));
		this.renderTokenTrend(trendCard, buckets, granularity);
		if (this.agentFilter === 'all' || this.agentFilter === 'claude') {
			const sessionsCard = dom.append(grid2, $('.paradis-ccusage-card'));
			this.renderSessions(sessionsCard, range);
		}
	}

	private filterDaysInRange(days: IParadisCcusageDayData[], range: IDateRange): IParadisCcusageDayData[] {
		const inPeriod = days.filter(day => day.date >= range.from && day.date <= range.to);
		if (this.agentFilter === 'all') {
			return inPeriod;
		}
		return inPeriod.map(day => ({ date: day.date, models: day.models.filter(m => m.agent === this.agentFilter) }));
	}

	private computeModelTotals(days: IParadisCcusageDayData[]): IModelTotal[] {
		const byModel = new Map<string, IModelTotal>();
		for (const day of days) {
			for (const slice of day.models) {
				let total = byModel.get(slice.model);
				if (!total) {
					total = { model: slice.model, agent: slice.agent, cost: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
					byModel.set(slice.model, total);
				}
				total.cost += slice.cost;
				total.inputTokens += slice.inputTokens;
				total.outputTokens += slice.outputTokens;
				total.cacheCreationTokens += slice.cacheCreationTokens;
				total.cacheReadTokens += slice.cacheReadTokens;
			}
		}
		return [...byModel.values()].sort((a, b) => b.cost - a.cost);
	}

	/** コスト降順の上位モデルへ固定スロットで色を割り当てる(超過分は「その他」)。 */
	private buildModelColorMap(totals: IModelTotal[]): Map<string, string> {
		const palette = this.seriesPalette;
		const map = new Map<string, string>();
		totals.forEach((total, index) => {
			map.set(total.model, index < MAX_MODEL_SERIES ? palette[index % palette.length] : OTHER_COLOR);
		});
		return map;
	}

	private renderKpis(container: HTMLElement, days: IParadisCcusageDayData[], totals: IModelTotal[]): void {
		const kpis = dom.append(container, $('.paradis-ccusage-kpis'));

		const totalCost = totals.reduce((sum, t) => sum + t.cost, 0);
		const inputTokens = totals.reduce((sum, t) => sum + t.inputTokens, 0);
		const outputTokens = totals.reduce((sum, t) => sum + t.outputTokens, 0);
		const cacheCreation = totals.reduce((sum, t) => sum + t.cacheCreationTokens, 0);
		const cacheRead = totals.reduce((sum, t) => sum + t.cacheReadTokens, 0);
		const allTokens = inputTokens + outputTokens + cacheCreation + cacheRead;
		const cacheDenominator = inputTokens + cacheCreation + cacheRead;
		const cacheRate = cacheDenominator > 0 ? (cacheRead / cacheDenominator) * 100 : 0;

		// 期間コスト(ヒーロー数値) + エージェント内訳
		const costTile = dom.append(kpis, $('.paradis-ccusage-card'));
		dom.append(costTile, $('.paradis-ccusage-stat-label')).textContent = this.periodLabel();
		dom.append(costTile, $('.paradis-ccusage-stat-value.hero')).textContent = formatUsd(totalCost);
		const agentCosts = new Map<ParadisCcusageAgent, number>();
		for (const total of totals) {
			agentCosts.set(total.agent, (agentCosts.get(total.agent) ?? 0) + total.cost);
		}
		if (this.agentFilter === 'all' && agentCosts.size > 1) {
			const parts = [...agentCosts.entries()].sort((a, b) => b[1] - a[1]).map(([agent, cost]) => `${agentDisplayName(agent)} ${formatUsd(cost)}`);
			dom.append(costTile, $('.paradis-ccusage-stat-sub')).textContent = parts.join(' · ');
		}

		const tokensTile = dom.append(kpis, $('.paradis-ccusage-card'));
		dom.append(tokensTile, $('.paradis-ccusage-stat-label')).textContent = localize('paradis.ccusage.kpi.tokens', "Total tokens");
		dom.append(tokensTile, $('.paradis-ccusage-stat-value')).textContent = formatTokens(allTokens);
		dom.append(tokensTile, $('.paradis-ccusage-stat-sub')).textContent =
			localize('paradis.ccusage.kpi.tokensSub', "Input {0} · Output {1}", formatTokens(inputTokens), formatTokens(outputTokens));

		const cacheTile = dom.append(kpis, $('.paradis-ccusage-card'));
		dom.append(cacheTile, $('.paradis-ccusage-stat-label')).textContent = localize('paradis.ccusage.kpi.cacheRate', "Cache read rate");
		dom.append(cacheTile, $('.paradis-ccusage-stat-value')).textContent = `${cacheRate.toFixed(1)}%`;
		dom.append(cacheTile, $('.paradis-ccusage-stat-sub')).textContent =
			localize('paradis.ccusage.kpi.cacheSub', "Cache read {0}", formatTokens(cacheRead));

		// 消費速度(アクティブブロックの burnRate。Claude Code のブロック概念に基づく)
		const burnTile = dom.append(kpis, $('.paradis-ccusage-card'));
		dom.append(burnTile, $('.paradis-ccusage-stat-label')).textContent = localize('paradis.ccusage.kpi.burnRate', "Current burn rate");
		const block = this.data?.block;
		const burnValue = dom.append(burnTile, $('.paradis-ccusage-stat-value'));
		if (block?.tokensPerMinute !== undefined) {
			burnValue.textContent = formatTokens(block.tokensPerMinute * 60);
			dom.append(burnValue, $('span.unit')).textContent = ' tok/h';
			if (block.costPerHour !== undefined) {
				dom.append(burnTile, $('.paradis-ccusage-stat-sub')).textContent = `≈ ${formatUsd(block.costPerHour)} / h`;
			}
		} else {
			burnValue.textContent = '—';
			dom.append(burnTile, $('.paradis-ccusage-stat-sub')).textContent = localize('paradis.ccusage.kpi.noActiveBlock', "No active block");
		}
	}

	private renderBlockCard(container: HTMLElement): void {
		const block = this.data?.block;
		if (!block || (this.agentFilter !== 'all' && this.agentFilter !== 'claude')) {
			return;
		}
		const card = dom.append(container, $('.paradis-ccusage-card.paradis-ccusage-block'));
		const accent = this.seriesPalette[0];

		const meterWrap = dom.append(card, $('div'));
		const start = new Date(block.startTime);
		const end = new Date(block.endTime);
		dom.append(meterWrap, $('.paradis-ccusage-stat-label')).textContent =
			localize('paradis.ccusage.block.title', "Current 5-hour block (Claude Code · {0} – {1})", formatClock(start), formatClock(end));
		const track = dom.append(meterWrap, $('.paradis-ccusage-meter-track'));
		track.style.background = `color-mix(in srgb, ${accent} 22%, transparent)`;
		const fill = dom.append(track, $('.paradis-ccusage-meter-fill'));
		const now = Date.now();
		const ratio = Math.max(0, Math.min(1, (now - block.startTime) / Math.max(1, block.endTime - block.startTime)));
		fill.style.width = `${(ratio * 100).toFixed(1)}%`;
		fill.style.background = accent;
		const scale = dom.append(meterWrap, $('.paradis-ccusage-meter-scale'));
		dom.append(scale, $('span')).textContent = formatClock(start);
		const remaining = block.remainingMinutes !== undefined
			? localize('paradis.ccusage.block.remaining', "{0} remaining", formatDuration(block.remainingMinutes))
			: '';
		dom.append(scale, $('span')).textContent = remaining;
		dom.append(scale, $('span')).textContent = formatClock(end);

		appendBlockStat(card, localize('paradis.ccusage.block.cost', "Block cost"), formatUsd(block.costUSD));
		if (block.projectedCost !== undefined) {
			appendBlockStat(card, localize('paradis.ccusage.block.projectedCost', "Projected cost"), formatUsd(block.projectedCost));
		}
		if (block.projectedTokens !== undefined) {
			appendBlockStat(card, localize('paradis.ccusage.block.projectedTokens', "Projected tokens"), formatTokens(block.projectedTokens));
		}
	}

	// ---------- daily stacked bar ----------

	private renderDailyChart(card: HTMLElement, buckets: IBucket[], totals: IModelTotal[], granularity: ParadisCcusageGranularity): void {
		dom.append(card, $('h3')).textContent = granularity === 'weekly'
			? localize('paradis.ccusage.weekly.title', "Weekly Cost")
			: localize('paradis.ccusage.daily.title', "Daily Cost");
		dom.append(card, $('.desc')).textContent = localize('paradis.ccusage.daily.desc', "Per-model breakdown (USD). Hover a bar for details.");

		const colorMap = this.buildModelColorMap(totals);
		const seriesModels = totals.slice(0, MAX_MODEL_SERIES).map(t => t.model);
		const hasOther = totals.length > MAX_MODEL_SERIES;

		const legend = dom.append(card, $('.paradis-ccusage-legend'));
		for (const model of seriesModels) {
			const item = dom.append(legend, $('.item'));
			const swatch = dom.append(item, $('.swatch'));
			swatch.style.background = colorMap.get(model) ?? OTHER_COLOR;
			item.appendChild(card.ownerDocument.createTextNode(prettyModelName(model)));
		}
		if (hasOther) {
			const item = dom.append(legend, $('.item'));
			dom.append(item, $('.swatch')).style.background = OTHER_COLOR;
			item.appendChild(card.ownerDocument.createTextNode(localize('paradis.ccusage.other', "Other")));
		}

		const doc = card.ownerDocument;
		const width = Math.max(320, card.clientWidth > 0 ? card.clientWidth - 34 : (this.body?.clientWidth ?? 720) * 0.55);
		const height = 235;
		const padL = 44; const padR = 8; const padT = 14; const padB = 20;
		const plotW = width - padL - padR;
		const plotH = height - padT - padB;

		const svg = svgEl(doc, 'svg', { width: String(width), height: String(height), viewBox: `0 0 ${width} ${height}` });
		card.appendChild(svg);

		const barCosts = buckets.map(bucket => {
			const perModel = new Map<string, number>();
			let other = 0;
			for (const slice of bucket.models) {
				if (seriesModels.includes(slice.model)) {
					perModel.set(slice.model, (perModel.get(slice.model) ?? 0) + slice.cost);
				} else {
					other += slice.cost;
				}
			}
			const total = bucket.models.reduce((sum, slice) => sum + slice.cost, 0);
			return { axisLabel: bucket.axisLabel, tooltipLabel: bucket.tooltipLabel, perModel, other, total };
		});

		const maxTotal = Math.max(0.01, ...barCosts.map(d => d.total));
		const step = niceStep(maxTotal * 1.12 / 4);
		const maxY = step * 4;
		const y = (v: number) => padT + plotH - (v / maxY) * plotH;

		for (let i = 0; i <= 4; i++) {
			const value = step * i;
			const line = svgEl(doc, 'line', { x1: String(padL), x2: String(width - padR), y1: String(y(value)), y2: String(y(value)), 'stroke-width': '1' });
			line.style.stroke = i === 0 ? 'color-mix(in srgb, var(--vscode-foreground) 28%, transparent)' : 'color-mix(in srgb, var(--vscode-foreground) 10%, transparent)';
			svg.appendChild(line);
			const tick = svgEl(doc, 'text', { x: String(padL - 6), y: String(y(value) + 3), 'text-anchor': 'end', class: 'paradis-ccusage-axis-text' });
			tick.textContent = `$${formatAxisNumber(value)}`;
			svg.appendChild(tick);
		}

		const band = plotW / Math.max(1, barCosts.length);
		const barW = Math.max(2, Math.min(24, band * 0.6));
		const gap = band > 8 ? 2 : 1;
		const labelEvery = Math.max(1, Math.ceil(34 / band));
		const maxIndex = barCosts.reduce((best, d, i) => (d.total > barCosts[best].total ? i : best), 0);

		barCosts.forEach((bar, index) => {
			const cx = padL + band * index + band / 2;
			const x0 = cx - barW / 2;
			let acc = 0;
			const segments: { color: string; value: number }[] = [];
			for (const model of seriesModels) {
				const value = bar.perModel.get(model) ?? 0;
				if (value > 0) {
					segments.push({ color: colorMap.get(model) ?? OTHER_COLOR, value });
				}
			}
			if (bar.other > 0) {
				segments.push({ color: OTHER_COLOR, value: bar.other });
			}
			segments.forEach((segment, segmentIndex) => {
				const isTop = segmentIndex === segments.length - 1;
				const yTop = y(acc + segment.value);
				const yBottom = y(acc) - (segmentIndex === 0 ? 0 : gap);
				const h = Math.max(1, yBottom - yTop);
				if (isTop && barW >= 8) {
					// 最上段のみ 4px 丸め(データ端)、ベースラインは角のまま
					const r = Math.min(4, barW / 2, h);
					const path = svgEl(doc, 'path', {
						d: `M${x0},${yBottom} L${x0},${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} L${x0 + barW - r},${yTop} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} L${x0 + barW},${yBottom} Z`
					});
					path.style.fill = segment.color;
					svg.appendChild(path);
				} else {
					const rect = svgEl(doc, 'rect', { x: String(x0), y: String(yTop), width: String(barW), height: String(h) });
					rect.style.fill = segment.color;
					svg.appendChild(rect);
				}
				acc += segment.value;
			});

			if (index % labelEvery === 0) {
				const label = svgEl(doc, 'text', { x: String(cx), y: String(height - 6), 'text-anchor': 'middle', class: 'paradis-ccusage-axis-text' });
				label.textContent = bar.axisLabel;
				svg.appendChild(label);
			}
			if (index === maxIndex && bar.total > 0) {
				const label = svgEl(doc, 'text', { x: String(cx), y: String(y(bar.total) - 5), 'text-anchor': 'middle', class: 'paradis-ccusage-direct-label' });
				label.textContent = formatUsd(bar.total);
				svg.appendChild(label);
			}

			// ヒットターゲットはバー本体より広く(バンド全体)
			const hit = svgEl(doc, 'rect', { x: String(padL + band * index), y: String(padT), width: String(band), height: String(plotH), fill: 'transparent' });
			this.bodyDisposables.add(dom.addDisposableListener(hit, dom.EventType.POINTER_MOVE, e => {
				const rows: ITooltipRow[] = [];
				for (const model of seriesModels) {
					const value = bar.perModel.get(model);
					if (value !== undefined && value > 0) {
						rows.push({ color: colorMap.get(model), name: prettyModelName(model), value: formatUsd(value) });
					}
				}
				if (bar.other > 0) {
					rows.push({ color: OTHER_COLOR, name: localize('paradis.ccusage.other', "Other"), value: formatUsd(bar.other) });
				}
				rows.push({ name: localize('paradis.ccusage.total', "Total"), value: formatUsd(bar.total), isTotal: true });
				this.showTooltip(e, bar.tooltipLabel, rows);
			}));
			this.bodyDisposables.add(dom.addDisposableListener(hit, dom.EventType.POINTER_LEAVE, () => this.hideTooltip()));
			svg.appendChild(hit);
		});
	}

	// ---------- token trend line ----------

	private renderTokenTrend(card: HTMLElement, buckets: IBucket[], granularity: ParadisCcusageGranularity): void {
		dom.append(card, $('h3')).textContent = localize('paradis.ccusage.trend.title', "Token Trend");
		dom.append(card, $('.desc')).textContent = granularity === 'weekly'
			? localize('paradis.ccusage.trend.descWeekly', "Weekly input + output tokens (cache excluded). Hover for cache reads too.")
			: localize('paradis.ccusage.trend.desc', "Daily input + output tokens (cache excluded). Hover for cache reads too.");

		const doc = card.ownerDocument;
		const width = Math.max(320, card.clientWidth > 0 ? card.clientWidth - 34 : (this.body?.clientWidth ?? 720) * 0.55);
		const height = 185;
		const padL = 46; const padR = 10; const padT = 12; const padB = 20;
		const plotW = width - padL - padR;
		const plotH = height - padT - padB;

		const points = buckets.map(bucket => ({
			axisLabel: bucket.axisLabel,
			tooltipLabel: bucket.tooltipLabel,
			io: bucket.models.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0),
			cacheRead: bucket.models.reduce((sum, m) => sum + m.cacheReadTokens, 0),
		}));
		const maxIo = Math.max(1, ...points.map(p => p.io));
		const step = niceStep(maxIo * 1.15 / 4);
		const maxY = step * 4;

		const svg = svgEl(doc, 'svg', { width: String(width), height: String(height), viewBox: `0 0 ${width} ${height}` });
		card.appendChild(svg);

		const x = (i: number) => points.length > 1 ? padL + (i / (points.length - 1)) * plotW : padL + plotW / 2;
		const y = (v: number) => padT + plotH - (v / maxY) * plotH;

		for (let i = 0; i <= 4; i++) {
			const value = step * i;
			const line = svgEl(doc, 'line', { x1: String(padL), x2: String(width - padR), y1: String(y(value)), y2: String(y(value)), 'stroke-width': '1' });
			line.style.stroke = i === 0 ? 'color-mix(in srgb, var(--vscode-foreground) 28%, transparent)' : 'color-mix(in srgb, var(--vscode-foreground) 10%, transparent)';
			svg.appendChild(line);
			const tick = svgEl(doc, 'text', { x: String(padL - 6), y: String(y(value) + 3), 'text-anchor': 'end', class: 'paradis-ccusage-axis-text' });
			tick.textContent = formatTokens(value);
			svg.appendChild(tick);
		}
		const labelEvery = Math.max(1, Math.ceil(34 / (plotW / Math.max(1, points.length - 1))));
		points.forEach((point, index) => {
			if (index % labelEvery === 0) {
				const label = svgEl(doc, 'text', { x: String(x(index)), y: String(height - 6), 'text-anchor': 'middle', class: 'paradis-ccusage-axis-text' });
				label.textContent = point.axisLabel;
				svg.appendChild(label);
			}
		});

		const accent = this.seriesPalette[0];
		if (points.length > 1) {
			const coords = points.map((p, i) => `${x(i)},${y(p.io)}`).join(' ');
			const area = svgEl(doc, 'polygon', { points: `${padL},${y(0)} ${coords} ${x(points.length - 1)},${y(0)}`, opacity: '0.1' });
			area.style.fill = accent;
			svg.appendChild(area);
			const line = svgEl(doc, 'polyline', { points: coords, fill: 'none', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
			line.style.stroke = accent;
			svg.appendChild(line);
		}
		if (points.length > 0) {
			const last = points.length - 1;
			const dot = svgEl(doc, 'circle', { cx: String(x(last)), cy: String(y(points[last].io)), r: '4.5', 'stroke-width': '2' });
			dot.style.fill = accent;
			dot.style.stroke = 'var(--vscode-editorWidget-background, var(--vscode-editor-background))';
			svg.appendChild(dot);
			const endLabel = svgEl(doc, 'text', { x: String(x(last) - 7), y: String(y(points[last].io) - 8), 'text-anchor': 'end', class: 'paradis-ccusage-direct-label' });
			endLabel.textContent = formatTokens(points[last].io);
			svg.appendChild(endLabel);
		}

		// クロスヘア: ポインタを最寄りの日にスナップし、全系列の値をツールチップで出す
		const crosshair = svgEl(doc, 'line', { y1: String(padT), y2: String(padT + plotH), 'stroke-width': '1', visibility: 'hidden' });
		crosshair.style.stroke = 'color-mix(in srgb, var(--vscode-foreground) 35%, transparent)';
		svg.appendChild(crosshair);
		const hover = svgEl(doc, 'rect', { x: String(padL), y: String(padT), width: String(plotW), height: String(plotH), fill: 'transparent' });
		this.bodyDisposables.add(dom.addDisposableListener(hover, dom.EventType.POINTER_MOVE, e => {
			if (points.length === 0) {
				return;
			}
			const svgRect = svg.getBoundingClientRect();
			const relX = e.clientX - svgRect.left;
			const index = Math.max(0, Math.min(points.length - 1, Math.round((relX - padL) / Math.max(1, plotW) * (points.length - 1))));
			crosshair.setAttribute('x1', String(x(index)));
			crosshair.setAttribute('x2', String(x(index)));
			crosshair.setAttribute('visibility', 'visible');
			this.showTooltip(e, points[index].tooltipLabel, [
				{ color: accent, name: localize('paradis.ccusage.trend.io', "Input + Output"), value: formatTokens(points[index].io) },
				{ name: localize('paradis.ccusage.trend.cacheRead', "Cache read"), value: formatTokens(points[index].cacheRead) },
			]);
		}));
		this.bodyDisposables.add(dom.addDisposableListener(hover, dom.EventType.POINTER_LEAVE, () => {
			crosshair.setAttribute('visibility', 'hidden');
			this.hideTooltip();
		}));
		svg.appendChild(hover);
	}

	// ---------- model / project lists ----------

	private renderModelBreakdown(card: HTMLElement, totals: IModelTotal[]): void {
		dom.append(card, $('h3')).textContent = localize('paradis.ccusage.models.title', "Cost by Model");
		const totalCost = totals.reduce((sum, t) => sum + t.cost, 0);
		dom.append(card, $('.desc')).textContent = localize('paradis.ccusage.models.desc', "Total {0}", formatUsd(totalCost));

		const colorMap = this.buildModelColorMap(totals);
		const maxCost = Math.max(0.01, ...totals.map(t => t.cost));

		const agentOrder: ParadisCcusageAgent[] = ['claude', 'codex', 'gemini', 'other'];
		for (const agent of agentOrder) {
			const agentTotals = totals.filter(t => t.agent === agent);
			if (agentTotals.length === 0) {
				continue;
			}
			if (this.agentFilter === 'all') {
				const head = dom.append(card, $('.paradis-ccusage-agent-head'));
				dom.append(head, $('span')).textContent = agentDisplayName(agent);
				dom.append(head, $('span.total')).textContent = formatUsd(agentTotals.reduce((sum, t) => sum + t.cost, 0));
			}
			for (const total of agentTotals) {
				appendHBarRow(card, prettyModelName(total.model), total.model, total.cost, maxCost, colorMap.get(total.model) ?? OTHER_COLOR, formatUsd(total.cost));
			}
		}
	}

	private renderProjects(card: HTMLElement, range: IDateRange): void {
		// 選択中の期間内のコストへスライスしてから集計する
		const projects = (this.data?.projects ?? [])
			.map(project => ({
				name: project.name,
				rawName: project.rawName,
				cost: project.dailyCosts.reduce((sum, day) => sum + (day.date >= range.from && day.date <= range.to ? day.cost : 0), 0),
			}))
			.filter(project => project.cost > 0)
			.sort((a, b) => b.cost - a.cost);
		if (projects.length === 0) {
			return;
		}
		const heading = dom.append(card, $('h3'));
		heading.style.marginTop = '16px';
		heading.textContent = localize('paradis.ccusage.projects.title', "Cost by Project");
		dom.append(card, $('.desc')).textContent = localize('paradis.ccusage.projects.desc', "Claude Code only · top {0}", Math.min(MAX_PROJECT_ROWS, projects.length));

		const seq = this.seqPalette;
		const top = projects.slice(0, MAX_PROJECT_ROWS);
		const restCost = projects.slice(MAX_PROJECT_ROWS).reduce((sum, p) => sum + p.cost, 0);
		// 「その他」の合計が個別プロジェクトの最大値を超えることがあるため、スケールに含める
		const maxCost = Math.max(0.01, ...top.map(p => p.cost), restCost);
		top.forEach((project, index) => {
			appendHBarRow(card, project.name, project.rawName, project.cost, maxCost, seq[Math.min(index, seq.length - 1)], formatUsd(project.cost));
		});
		if (restCost > 0) {
			appendHBarRow(card, localize('paradis.ccusage.projects.rest', "Other ({0})", projects.length - MAX_PROJECT_ROWS), '', restCost, maxCost, seq[seq.length - 1], formatUsd(restCost));
		}
	}

	private renderSessions(card: HTMLElement, range: IDateRange): void {
		dom.append(card, $('h3')).textContent = localize('paradis.ccusage.sessions.title', "Recent Sessions");
		dom.append(card, $('.desc')).textContent = localize('paradis.ccusage.sessions.desc', "Claude Code only · most recent first");

		// filterDaysInRange/renderProjects と同じ「ローカル日付文字列の辞書順比較」で期間判定を揃える。
		// 活動日時が取れないセッションは判定不能なので表示に残す。
		const sessions = (this.data?.sessions ?? [])
			.filter(session => {
				if (session.lastActivity === undefined) {
					return true;
				}
				const activityDate = localDateString(new Date(session.lastActivity));
				return activityDate >= range.from && activityDate <= range.to;
			})
			.slice(0, MAX_SESSION_ROWS);
		if (sessions.length === 0) {
			dom.append(card, $('.paradis-ccusage-note')).textContent = localize('paradis.ccusage.sessions.none', "No sessions in the selected period.");
			return;
		}

		const colorMap = this.buildModelColorMap(this.computeModelTotals(this.filterDaysInRange(this.data?.days ?? [], range)));
		const table = dom.append(card, $('table.paradis-ccusage-sessions'));
		const thead = dom.append(table, $('thead'));
		const headRow = dom.append(thead, $('tr'));
		dom.append(headRow, $('th')).textContent = localize('paradis.ccusage.sessions.project', "Project");
		dom.append(headRow, $('th')).textContent = localize('paradis.ccusage.sessions.models', "Models");
		dom.append(headRow, $('th.num')).textContent = localize('paradis.ccusage.sessions.tokens', "Tokens");
		dom.append(headRow, $('th.num')).textContent = localize('paradis.ccusage.sessions.cost', "Cost");
		dom.append(headRow, $('th')).textContent = localize('paradis.ccusage.sessions.lastActivity', "Last Activity");
		const tbody = dom.append(table, $('tbody'));
		for (const session of sessions) {
			const row = dom.append(tbody, $('tr'));
			const projectCell = dom.append(row, $('td'));
			projectCell.textContent = session.project;
			projectCell.title = session.rawProject;
			const modelsCell = dom.append(row, $('td'));
			for (const model of session.models) {
				const dot = dom.append(modelsCell, $('span.model-dot'));
				dot.style.background = colorMap.get(model) ?? OTHER_COLOR;
				dot.title = prettyModelName(model);
			}
			dom.append(row, $('td.num')).textContent = formatTokens(session.totalTokens);
			dom.append(row, $('td.num')).textContent = formatUsd(session.totalCost);
			dom.append(row, $('td')).textContent = session.lastActivity !== undefined ? fromNow(session.lastActivity, true) : '—';
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
			const titleEl = dom.append(this.tooltip, $('.tt-title'));
			titleEl.textContent = title;
			for (const row of rows) {
				const rowEl = dom.append(this.tooltip, $(row.isTotal ? '.tt-row.total' : '.tt-row'));
				if (row.color) {
					const key = dom.append(rowEl, $('.tt-key'));
					key.style.background = row.color;
				}
				const name = dom.append(rowEl, $('.tt-name'));
				name.textContent = row.name;
				const value = dom.append(rowEl, $('.tt-val'));
				value.textContent = row.value;
			}
		}
		this.tooltip.style.display = 'block';
		const rootRect = this.root.getBoundingClientRect();
		const tipWidth = this.tooltip.offsetWidth;
		const tipHeight = this.tooltip.offsetHeight;
		let left = e.clientX - rootRect.left + 14;
		let top = e.clientY - rootRect.top + 14;
		left = Math.min(left, rootRect.width - tipWidth - 8);
		top = Math.min(top, rootRect.height - tipHeight - 8);
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
	readonly isTotal?: boolean;
}

// ---------- helpers ----------

function svgEl(doc: Document, tag: string, attrs: Record<string, string>): SVGElement {
	const el = doc.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElement;
	for (const [key, value] of Object.entries(attrs)) {
		el.setAttribute(key, value);
	}
	return el;
}

function appendBlockStat(card: HTMLElement, label: string, value: string): void {
	const kv = dom.append(card, $('.paradis-ccusage-block-kv'));
	dom.append(kv, $('.k')).textContent = label;
	dom.append(kv, $('.v')).textContent = value;
}

function appendHBarRow(container: HTMLElement, name: string, tooltip: string, value: number, maxValue: number, color: string, formatted: string): void {
	const row = dom.append(container, $('.paradis-ccusage-hbar-row'));
	const nameEl = dom.append(row, $('span.name'));
	nameEl.textContent = name;
	if (tooltip) {
		nameEl.title = tooltip;
	}
	const track = dom.append(row, $('.track'));
	const bar = dom.append(track, $('.bar'));
	bar.style.width = `${Math.min(100, Math.max(1, (value / maxValue) * 100)).toFixed(1)}%`;
	bar.style.background = color;
	dom.append(row, $('span.val')).textContent = formatted;
}

function agentDisplayName(agent: ParadisCcusageAgent): string {
	switch (agent) {
		case 'claude': return 'Claude Code';
		case 'codex': return 'Codex';
		case 'gemini': return 'Gemini';
		default: return localize('paradis.ccusage.agent.other', "Other");
	}
}

/** "claude-opus-4-8" → "Opus 4.8"、"gpt-5.5" → "GPT-5.5" のような表示名を作る。 */
function prettyModelName(modelName: string): string {
	let name = modelName;
	if (name.toLowerCase().startsWith('claude-')) {
		name = name.slice('claude-'.length).replace(/-\d{8}$/, '');
		const parts = name.split('-');
		const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
		const version = parts.slice(1).join('.');
		return version ? `${family} ${version}` : family;
	}
	if (name.toLowerCase().startsWith('gpt')) {
		return name.replace(/^gpt/i, 'GPT');
	}
	if (name.toLowerCase().startsWith('gemini')) {
		return name.split('-').map(part => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
	}
	return name;
}

function formatUsd(value: number): string {
	if (value >= 1000) {
		return `$${Math.round(value).toLocaleString('en-US')}`;
	}
	return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
	if (value >= 1e9) {
		return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;
	}
	if (value >= 1e6) {
		return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
	}
	if (value >= 1e3) {
		return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`;
	}
	return String(Math.round(value));
}

function formatAxisNumber(value: number): string {
	if (value >= 1000) {
		return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
	}
	if (Number.isInteger(value)) {
		return String(value);
	}
	return value.toFixed(value < 10 ? 1 : 0);
}

/** 4分割の軸目盛りがきれいな数(1/2/2.5/5 × 10^n)になるステップを選ぶ。 */
function niceStep(rawStep: number): number {
	let magnitude = 0.05;
	for (let i = 0; i < 12; i++) {
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

/** ローカル時刻で YYYY-MM-DD を返す(daily の period と同じ基準)。 */
function localDateString(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
	const diff = dow === 0 ? -6 : 1 - dow;
	return addDaysLocal(d, diff);
}

/** 両端を含む日数。 */
function spanDaysInclusive(from: string, to: string): number {
	return Math.round((parseLocalDate(to).getTime() - parseLocalDate(from).getTime()) / 86400000) + 1;
}

/** プリセットキーを実際の日付レンジ(両端含む、YYYY-MM-DD)に変換する。 */
function presetRange(key: ParadisCcusagePresetKey, today: Date): IDateRange {
	const todayStr = localDateString(today);
	switch (key) {
		case 'today':
			return { from: todayStr, to: todayStr };
		case 'yesterday': {
			const y = localDateString(addDaysLocal(today, -1));
			return { from: y, to: y };
		}
		case 'thisWeek':
			return { from: localDateString(startOfWeekMonday(today)), to: todayStr };
		case 'lastWeek': {
			const thisStart = startOfWeekMonday(today);
			return { from: localDateString(addDaysLocal(thisStart, -7)), to: localDateString(addDaysLocal(thisStart, -1)) };
		}
		case '7d':
			return { from: localDateString(addDaysLocal(today, -6)), to: todayStr };
		case '30d':
			return { from: localDateString(addDaysLocal(today, -29)), to: todayStr };
		case '90d':
			return { from: localDateString(addDaysLocal(today, -89)), to: todayStr };
		case 'custom':
			// presetKey が 'custom' のときは currentRange() が customRange を先に見るため、ここには来ない。
			return { from: todayStr, to: todayStr };
	}
}

/**
 * 日別データを表示単位(daily/weekly)のバケットへ集計する。weekly は月曜始まりの週ごとに
 * モデル別スライスを合算する。バケットは日付昇順で返す。
 */
function computeBuckets(days: IParadisCcusageDayData[], granularity: ParadisCcusageGranularity): IBucket[] {
	if (granularity === 'daily') {
		return days.map(day => ({ key: day.date, axisLabel: shortDate(day.date), tooltipLabel: day.date, models: day.models }));
	}

	const byWeek = new Map<string, Map<string, IParadisCcusageModelSlice>>();
	for (const day of days) {
		const weekStart = localDateString(startOfWeekMonday(parseLocalDate(day.date)));
		let models = byWeek.get(weekStart);
		if (!models) {
			models = new Map();
			byWeek.set(weekStart, models);
		}
		for (const slice of day.models) {
			const existing = models.get(slice.model);
			models.set(slice.model, existing ? {
				model: slice.model,
				agent: slice.agent,
				cost: existing.cost + slice.cost,
				inputTokens: existing.inputTokens + slice.inputTokens,
				outputTokens: existing.outputTokens + slice.outputTokens,
				cacheCreationTokens: existing.cacheCreationTokens + slice.cacheCreationTokens,
				cacheReadTokens: existing.cacheReadTokens + slice.cacheReadTokens,
			} : { ...slice });
		}
	}
	return [...byWeek.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([weekStart, models]) => ({
			key: weekStart,
			axisLabel: shortDate(weekStart),
			tooltipLabel: localize('paradis.ccusage.weekOf', "Week of {0}", shortDate(weekStart)),
			models: [...models.values()],
		}));
}

/** "2026-07-04" → "7/4"。 */
function shortDate(isoDate: string): string {
	const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(isoDate);
	if (!match) {
		return isoDate;
	}
	return `${Number(match[1])}/${Number(match[2])}`;
}

function formatClock(date: Date): string {
	return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = Math.round(minutes % 60);
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
