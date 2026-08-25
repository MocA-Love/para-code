/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub API 利用状況ダッシュボードの中身（ホスト非依存）。
// タブ(EditorPane)と統合ダイアログのどちらからも同じものを出せるよう、描画・取得・
// フィルタ状態をここへ集約し、ホストは `IParadisUsageSection` 越しに幅と可視状態を流し込むだけにする。
// 表示は2階層に分かれている:
//  - アカウント全体のレート枠と消費ペース（gh api rate_limit 由来。他ツールの消費も含む）
//  - Para Code 自身が発行した gh 呼び出しの内訳（どの処理が枠を食っているか）
// チャートは素の SVG DOM で構築し、workbench テーマの CSS 変数で色付けする
// （ccusage ダッシュボードと同じ方針）。

import './media/paradisGithubMetrics.css';
import * as dom from '../../../../base/browser/dom.js';
import { disposableTimeout, IntervalTimer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IParadisGithubCallCounts,
	IParadisGithubConsumption,
	IParadisGithubMetricsSnapshot,
	IParadisGithubOperationStat,
	IParadisGithubRateLimitEntry,
	paradisGithubFormatCountdown,
	paradisGithubSeverity,
	PARADIS_GITHUB_PRIMARY_RESOURCES,
	PARADIS_GITHUB_UNSCOPED_SPACE,
} from '../common/paradisGithubMetrics.js';
import { IParadisUsageSection } from '../../usageDashboard/electron-browser/paradisUsageSection.js';
import { ParadisGithubMetricsClient, PARADIS_GITHUB_METRICS_SETTING_REFRESH_INTERVAL } from './paradisGithubMetricsClient.js';
import { paradisGithubFormatDuration, paradisGithubResourceLabel, paradisGithubRoundedPercent } from './paradisGithubMetricsFormat.js';

const $ = dom.$;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 表示中の自動更新間隔の既定値。1回ごとに gh のプロセスが起動しうるので、
 * shared process 側の最短取得間隔(45秒)より長くして無駄打ちを避ける。
 * 設定 {@link PARADIS_GITHUB_METRICS_SETTING_REFRESH_INTERVAL} で変えられる(0 = 手動のみ)。
 */
const VISIBLE_REFRESH_INTERVAL_MS = 60_000;
/** コピーボタンのフィードバック表示時間。 */
const COPIED_FEEDBACK_MS = 2000;
/** 表に出す呼び出し元・スペースの最大数。 */
const MAX_OPERATION_ROWS = 12;
const MAX_SPACE_ROWS = 12;
/** 一覧に出す直近エラーの最大数。 */
const MAX_ERROR_ROWS = 5;
/** ホストから幅を教えてもらう前に仮定しておく幅。 */
const DEFAULT_SECTION_WIDTH = 900;

/** 内訳・概況カードで見る時間窓。「セッション」はレート枠消費(アカウント全体)には対応する集計が無いため、1時間相当にフォールバックする。 */
type ParadisGithubWindowKey = '5m' | '1h' | 'session';
/** 資源での絞り込み。'all' は全資源を合算表示する。 */
type ParadisGithubResourceFilter = 'all' | 'core' | 'graphql' | 'search';

export class ParadisGithubMetricsSection extends Disposable implements IParadisUsageSection {

	readonly element: HTMLElement;

	private readonly body: HTMLElement;
	private readonly updatedLabel: HTMLElement;
	private readonly refreshIcon: HTMLElement;

	private readonly client: ParadisGithubMetricsClient;
	private readonly bodyDisposables = this._register(new DisposableStore());
	private readonly autoRefreshTimer = this._register(new IntervalTimer());
	/** コピー完了表示を元に戻すタイマー。連打しても1つしか持たない。 */
	private readonly copyFeedback = this._register(new MutableDisposable());

	private snapshot: IParadisGithubMetricsSnapshot | undefined;
	private lastError: string | undefined;
	private loading = false;
	/** ホストから渡された使える幅。実測できないダイアログ内でもチャートを組めるよう覚えておく。 */
	private sectionWidth = DEFAULT_SECTION_WIDTH;
	/** セグメントコントロールの選択状態。データの再取得はせず、既存スナップショットの再描画だけで反映する。 */
	private windowKey: ParadisGithubWindowKey = '5m';
	private resourceFilter: ParadisGithubResourceFilter = 'all';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this.client = instantiationService.createInstance(ParadisGithubMetricsClient);

		this.element = $('.paradis-ghm');

		const toolbar = dom.append(this.element, $('.paradis-ghm-toolbar'));
		const titles = dom.append(toolbar, $('.paradis-ghm-titles'));
		dom.append(titles, $('h2')).textContent = localize('paradis.githubMetrics.title', "GitHub API 利用状況");
		dom.append(titles, $('p')).textContent = localize('paradis.githubMetrics.subtitle', "あなたのGitHubアカウントのレート制限と、Para Code自身が送信したリクエストです。");
		this.updatedLabel = dom.append(titles, $('.paradis-ghm-updated'));

		dom.append(toolbar, $('.paradis-ghm-toolbar-spacer'));

		const refresh = dom.append(toolbar, $('button.paradis-ghm-button')) as HTMLButtonElement;
		this.refreshIcon = dom.append(refresh, $(ThemeIcon.asCSSSelector(Codicon.refresh)));
		dom.append(refresh, $('span')).textContent = localize('paradis.githubMetrics.refresh', "更新");
		this._register(dom.addDisposableListener(refresh, dom.EventType.CLICK, () => void this.refresh(true)));

		this.body = dom.append(this.element, $('.paradis-ghm-body'));
		this.body.tabIndex = 0;
	}

	/** 最初に開かれたときだけ読み込む（既に持っている・取得中なら何もしない）。 */
	ensureLoaded(): void {
		if (!this.snapshot && !this.loading) {
			void this.refresh(false);
		}
	}

	focus(): void {
		this.body.focus();
	}

	layout(width: number): void {
		// 中身は CSS のグリッド/フレックスで伸縮するため、寸法に応じた再描画は不要。
		// 幅だけは覚えておき、実測できないホストでもチャートの組み立てに使えるようにする。
		if (width === this.sectionWidth) {
			return;
		}
		this.sectionWidth = width;
	}

	setVisible(visible: boolean): void {
		if (visible) {
			void this.refresh(false);
			this.scheduleAutoRefresh();
		} else {
			this.autoRefreshTimer.cancel();
		}
	}

	/** 設定された間隔で自分を取り直す。0（手動のみ）ならタイマーを張らない。 */
	private scheduleAutoRefresh(): void {
		const configured = this.configurationService.getValue<number>(PARADIS_GITHUB_METRICS_SETTING_REFRESH_INTERVAL);
		const intervalMs = typeof configured === 'number' && Number.isFinite(configured)
			? Math.max(0, Math.round(configured)) * 1000
			: VISIBLE_REFRESH_INTERVAL_MS;
		this.autoRefreshTimer.cancel();
		if (intervalMs > 0) {
			this.autoRefreshTimer.cancelAndSet(() => void this.refresh(false), intervalMs);
		}
	}

	async refresh(bypassCache = false): Promise<void> {
		if (this.loading) {
			return;
		}
		this.loading = true;
		this.lastError = undefined;
		this.refreshIcon.classList.add('spin');
		if (!this.snapshot) {
			dom.clearNode(this.body);
			dom.append(this.body, $('.paradis-ghm-message')).textContent = localize('paradis.githubMetrics.loading', "読み込み中…");
		}
		try {
			this.snapshot = await this.client.getSnapshot(bypassCache);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.refreshIcon.classList.remove('spin');
			// 取得中にセクションが破棄されていたら、破棄済みのストアに触らない
			if (!this._store.isDisposed) {
				this.renderBody();
			}
		}
	}

	// ---------- 描画 ----------

	private renderBody(): void {
		const body = this.body;
		this.bodyDisposables.clear();
		dom.clearNode(body);

		const snapshot = this.snapshot;
		// 「更新」はレート枠の実取得時刻（shared process 側で短時間キャッシュされるため）
		this.updatedLabel.textContent = snapshot
			? localize('paradis.githubMetrics.updatedAt', "更新: {0}・セッション開始: {1}", fromNow(snapshot.rateLimitFetchedAt ?? snapshot.generatedAt, true), fromNow(snapshot.sessionStartedAt, true))
			: '';

		if (!snapshot) {
			dom.append(body, $('.paradis-ghm-message')).textContent =
				this.lastError ?? localize('paradis.githubMetrics.noData', "まだデータがありません。");
			return;
		}

		if (!snapshot.ghAvailable) {
			dom.append(body, $('.paradis-ghm-banner.error')).textContent =
				localize('paradis.githubMetrics.noGh', "GitHub CLI（gh）が見つかりませんでした。レート制限を確認するには、インストールして `gh auth login` でサインインしてください。");
		} else if (snapshot.rateLimitError) {
			dom.append(body, $('.paradis-ghm-banner.warning')).textContent =
				localize('paradis.githubMetrics.rateLimitError', "レート制限を取得できませんでした: {0}", snapshot.rateLimitError);
		}

		this.renderControls(body);
		this.renderOverview(body, snapshot);
		this.renderRateLimits(body, snapshot);
		this.renderConsumption(body, snapshot);
		this.renderBreakdown(body, snapshot);
		this.renderErrors(body, snapshot);
		this.renderDebugCopy(body, snapshot);
	}

	/** 期間・リソースのセグメントコントロール。クリックしても再取得はせず renderBody() を呼び直すだけ。 */
	private renderControls(container: HTMLElement): void {
		const row = dom.append(container, $('.paradis-ghm-segrow'));

		dom.append(row, $('.paradis-ghm-seggroup-label')).textContent = localize('paradis.githubMetrics.controls.window', "期間");
		const windowSeg = dom.append(row, $('.paradis-ghm-seg'));
		const windowOptions: { key: ParadisGithubWindowKey; label: string }[] = [
			{ key: '5m', label: localize('paradis.githubMetrics.window.5m', "5分") },
			{ key: '1h', label: localize('paradis.githubMetrics.window.1h', "1時間") },
			{ key: 'session', label: localize('paradis.githubMetrics.window.session', "セッション") },
		];
		for (const option of windowOptions) {
			const button = dom.append(windowSeg, $('button')) as HTMLButtonElement;
			button.textContent = option.label;
			button.classList.toggle('checked', this.windowKey === option.key);
			this.bodyDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this.windowKey = option.key;
				this.renderBody();
			}));
		}

		dom.append(row, $('.paradis-ghm-seggroup-label')).textContent = localize('paradis.githubMetrics.controls.resource', "リソース");
		const resourceSeg = dom.append(row, $('.paradis-ghm-seg'));
		const resourceOptions: { key: ParadisGithubResourceFilter; label: string; gql?: boolean }[] = [
			{ key: 'all', label: localize('paradis.githubMetrics.resource.all', "すべて") },
			{ key: 'core', label: localize('paradis.githubMetrics.resource.core', "コア（REST）") },
			{ key: 'graphql', label: localize('paradis.githubMetrics.resource.graphql', "GraphQL"), gql: true },
			{ key: 'search', label: localize('paradis.githubMetrics.resource.search', "検索") },
		];
		for (const option of resourceOptions) {
			const button = dom.append(resourceSeg, $('button')) as HTMLButtonElement;
			button.textContent = option.label;
			button.classList.toggle('checked', this.resourceFilter === option.key);
			if (option.gql) {
				button.classList.add('gql');
			}
			this.bodyDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this.resourceFilter = option.key;
				this.renderBody();
			}));
		}
	}

	private renderOverview(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const grid = dom.append(container, $('.paradis-ghm-grid.cols4'));

		for (const resource of PARADIS_GITHUB_PRIMARY_RESOURCES) {
			const entry = snapshot.rateLimits.find(item => item.resource === resource);
			const card = dom.append(grid, $('.paradis-ghm-card'));
			card.classList.toggle('emph', this.resourceFilter === resource);
			dom.append(card, $('.k')).textContent = localize('paradis.githubMetrics.card.remaining', "残り {0}", paradisGithubResourceLabel(resource));
			if (entry) {
				const ratio = entry.limit > 0 ? Math.max(0, Math.min(1, entry.remaining / entry.limit)) : 0;
				const value = dom.append(card, $('.v'));
				value.textContent = entry.remaining.toLocaleString();
				dom.append(value, $('small')).textContent = ` / ${entry.limit.toLocaleString()}`;
				const gauge = dom.append(card, $('.paradis-ghm-gauge'));
				dom.append(gauge, $(`span.${paradisGithubSeverity(ratio)}`)).style.width = `${paradisGithubRoundedPercent(ratio)}%`;
				dom.append(card, $('.s')).textContent = entry.resetAt > snapshot.generatedAt
					? localize('paradis.githubMetrics.card.resetsIn', "{0}後にリセット", paradisGithubFormatCountdown(entry.resetAt - snapshot.generatedAt))
					: localize('paradis.githubMetrics.card.resetting', "リセット中");
			} else {
				dom.append(card, $('.v')).textContent = '—';
				dom.append(card, $('.s')).textContent = localize('paradis.githubMetrics.card.noValue', "取得できません");
			}
		}

		// レート枠の消費(アカウント全体)には「セッション」に対応する累計が無いため、1時間相当にフォールバックする
		const consumptionWindow = this.windowKey === '5m' ? '5m' : '1h';
		const consumedCard = dom.append(grid, $('.paradis-ghm-card'));
		dom.append(consumedCard, $('.k')).textContent = consumptionWindow === '5m'
			? localize('paradis.githubMetrics.card.consumed5m', "直近5分の消費量")
			: localize('paradis.githubMetrics.card.consumed1h', "直近1時間の消費量");
		const consumedValue = sumConsumption(snapshot.consumption, this.resourceFilter, consumptionWindow);
		dom.append(consumedCard, $('.v')).textContent = consumedValue !== undefined ? Math.round(consumedValue).toLocaleString() : '—';
		const primaryConsumption = snapshot.consumption.find(item => item.resource === (this.resourceFilter === 'all' ? 'core' : this.resourceFilter));
		dom.append(consumedCard, $('.s')).textContent = primaryConsumption?.perMinute !== undefined
			? localize('paradis.githubMetrics.card.pace', "{0} req/分・全ソース合計", primaryConsumption.perMinute.toFixed(1))
			: localize('paradis.githubMetrics.card.measuring', "計測中…");

		const operationCounts = sumOperationCounts(snapshot.operations, this.resourceFilter, this.windowKey);
		const callsCard = dom.append(grid, $('.paradis-ghm-card'));
		dom.append(callsCard, $('.k')).textContent = localize('paradis.githubMetrics.card.paraCalls', "Para Codeが送信（{0}）", windowLabel(this.windowKey));
		dom.append(callsCard, $('.v')).textContent = operationCounts.calls.toLocaleString();
		dom.append(callsCard, $('.s')).textContent = localize(
			'paradis.githubMetrics.card.paraCallsSub',
			"失敗{0}件・レート制限{1}件・セッション内{2}件",
			operationCounts.failures,
			operationCounts.rateLimited,
			snapshot.totals.sessionCalls
		);
	}

	private renderRateLimits(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		if (snapshot.rateLimits.length === 0) {
			return;
		}
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.limits', "レート制限");
		const list = dom.append(container, $('.paradis-ghm-panel'));

		// 主要資源を先に、それ以外は元の順で続ける（見る頻度の高い順に並べる）
		const ordered = [...snapshot.rateLimits].sort((a, b) => resourceRank(a) - resourceRank(b));
		for (const entry of ordered) {
			this.renderRateLimitRow(list, entry, snapshot);
		}
	}

	private renderRateLimitRow(container: HTMLElement, entry: IParadisGithubRateLimitEntry, snapshot: IParadisGithubMetricsSnapshot): void {
		const ratio = entry.limit > 0 ? Math.max(0, Math.min(1, entry.remaining / entry.limit)) : 0;
		const row = dom.append(container, $('.paradis-ghm-limit-row'));

		const head = dom.append(row, $('.paradis-ghm-limit-head'));
		const badge = dom.append(head, $('.paradis-ghm-badge'));
		badge.classList.add(entry.resource);
		badge.textContent = paradisGithubResourceLabel(entry.resource);
		dom.append(head, $('.paradis-ghm-limit-value')).textContent =
			`${entry.remaining.toLocaleString()} / ${entry.limit.toLocaleString()}`;
		dom.append(head, $('.paradis-ghm-limit-percent')).textContent =
			localize('paradis.githubMetrics.limit.percent', "残り{0}%", paradisGithubRoundedPercent(ratio));

		const gauge = dom.append(row, $('.paradis-ghm-gauge'));
		dom.append(gauge, $(`span.${paradisGithubSeverity(ratio)}`)).style.width = `${paradisGithubRoundedPercent(ratio)}%`;

		const consumption = snapshot.consumption.find(item => item.resource === entry.resource);
		const facts: string[] = [];
		facts.push(entry.resetAt > snapshot.generatedAt
			? localize('paradis.githubMetrics.limit.resetsIn', "{0}後にリセット", paradisGithubFormatCountdown(entry.resetAt - snapshot.generatedAt))
			: localize('paradis.githubMetrics.limit.resetting', "リセット中"));
		if (consumption?.rolling1h !== undefined) {
			facts.push(localize('paradis.githubMetrics.limit.consumed1h', "直近1時間で{0}消費", Math.round(consumption.rolling1h).toLocaleString()));
		}
		if (consumption?.exhaustionEtaMs !== undefined) {
			facts.push(localize('paradis.githubMetrics.limit.eta', "このペースだとあと{0}で枯渇", paradisGithubFormatCountdown(consumption.exhaustionEtaMs)));
		}
		dom.append(row, $('.paradis-ghm-limit-facts')).textContent = facts.join(' · ');
	}

	private renderConsumption(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const core = snapshot.consumption.find(item => item.resource === 'core');
		const graphql = snapshot.consumption.find(item => item.resource === 'graphql');

		if (this.resourceFilter === 'all') {
			if ((!core || core.series.length < 2) && (!graphql || graphql.series.length < 2)) {
				return;
			}
			dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.trend', "消費量の推移");
			const panel = dom.append(container, $('.paradis-ghm-panel.padded'));
			dom.append(panel, $('.paradis-ghm-chart-caption')).textContent =
				localize('paradis.githubMetrics.trend.caption.all', "サンプル間で消費したリクエスト数（全ソース合算、右が最新。searchは割合が小さいためグラフから省略）。サンプルはこの画面またはステータスバーが表示されている間だけ取得するため、各バーの時間幅は揃いません。");
			const legend = dom.append(panel, $('.paradis-ghm-legend'));
			const coreLegend = dom.append(legend, $('span'));
			dom.append(coreLegend, $('i', { style: 'background:var(--vscode-charts-blue)' }));
			dom.append(coreLegend, $('span')).textContent = paradisGithubResourceLabel('core');
			const graphqlLegend = dom.append(legend, $('span'));
			dom.append(graphqlLegend, $('i', { style: 'background:var(--vscode-charts-purple)' }));
			dom.append(graphqlLegend, $('span')).textContent = paradisGithubResourceLabel('graphql');
			panel.appendChild(createStackedBarChart(panel.ownerDocument, core?.series ?? [], 'core', graphql?.series ?? [], 'graphql'));
			return;
		}

		const consumption = snapshot.consumption.find(item => item.resource === this.resourceFilter);
		if (!consumption || consumption.series.length < 2) {
			return;
		}
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.trendResource', "{0}の消費量の推移", paradisGithubResourceLabel(this.resourceFilter));
		const panel = dom.append(container, $('.paradis-ghm-panel.padded'));
		dom.append(panel, $('.paradis-ghm-chart-caption')).textContent =
			localize('paradis.githubMetrics.trend.caption', "サンプル間で消費したリクエスト数（全ソース合算、右が最新）。サンプルはこの画面またはステータスバーが表示されている間だけ取得するため、各バーの時間幅は揃いません。");
		panel.appendChild(createBarChart(panel.ownerDocument, consumption.series, this.resourceFilter));
	}

	/** 内訳を「呼び出し元」「スペース」の2カラムで見せる。ccusageダッシュボードと同じ2カラムパネル構成。 */
	private renderBreakdown(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const grid = dom.append(container, $('.paradis-ghm-grid.cols2'));

		const callerColumn = dom.append(grid, $('div'));
		const callerTitle = dom.append(callerColumn, $('.paradis-ghm-section-title'));
		callerTitle.textContent = localize('paradis.githubMetrics.section.byCaller', "内訳：呼び出し元");
		if (this.resourceFilter === 'graphql') {
			dom.append(callerTitle, $('span.hint')).textContent = localize('paradis.githubMetrics.byCaller.graphqlHint', "（GraphQL操作）");
		}
		const callerPanel = dom.append(callerColumn, $('.paradis-ghm-panel'));
		this.renderCallerBreakdown(callerPanel, snapshot);

		const spaceColumn = dom.append(grid, $('div'));
		const spaceTitle = dom.append(spaceColumn, $('.paradis-ghm-section-title'));
		spaceTitle.textContent = localize('paradis.githubMetrics.section.bySpace', "内訳：スペース");
		if (this.resourceFilter !== 'all') {
			dom.append(spaceTitle, $('span.hint')).textContent = localize('paradis.githubMetrics.bySpace.allResourcesHint', "（全リソース）");
		}
		const spacePanel = dom.append(spaceColumn, $('.paradis-ghm-panel'));
		this.renderSpaceBreakdown(spacePanel, snapshot);
	}

	private renderCallerBreakdown(panel: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const operations = snapshot.operations
			.filter(operation => this.resourceFilter === 'all' || operation.resource === this.resourceFilter)
			.slice()
			.sort((a, b) => countsForWindow(b, this.windowKey).calls - countsForWindow(a, this.windowKey).calls);

		if (operations.length === 0) {
			dom.append(panel, $('.paradis-ghm-empty')).textContent = this.resourceFilter === 'search'
				? localize('paradis.githubMetrics.caller.emptySearch', "Para CodeはSearch APIを直接呼び出しません。")
				: localize('paradis.githubMetrics.operations.empty', "Para Codeはまだ GitHub へリクエストを送信していません。");
			return;
		}

		// バーの長さは表示中の行同士の相対比較（最大値=満幅）。全件0でも見えるよう下限を設ける
		const maxCalls = Math.max(1, ...operations.map(operation => countsForWindow(operation, this.windowKey).calls));

		for (const operation of operations.slice(0, MAX_OPERATION_ROWS)) {
			const counts = countsForWindow(operation, this.windowKey);
			const row = dom.append(panel, $('.paradis-ghm-hbar-row'));

			const head = dom.append(row, $('.paradis-ghm-hbar-head'));
			const name = dom.append(head, $('.paradis-ghm-hbar-name.paradis-ghm-mono'));
			name.textContent = operation.callSite;
			if (operation.topWorktreePath) {
				dom.append(name, $('.paradis-ghm-hbar-sub')).textContent = localize('paradis.githubMetrics.table.topWorktree', "最多: {0}", spaceLabel(operation.topWorktreePath));
			}
			dom.append(head, $('.paradis-ghm-hbar-value')).textContent = counts.calls.toLocaleString();

			const track = dom.append(row, $('.paradis-ghm-hbar-track'));
			const widthPercent = Math.max(2, (counts.calls / maxCalls) * 100);
			dom.append(track, $(`span.${operation.resource}`)).style.width = `${widthPercent}%`;

			const facts: string[] = [localize('paradis.githubMetrics.hbar.avg', "平均{0}", paradisGithubFormatDuration(counts.avgDurationMs))];
			if (counts.failures > 0) {
				facts.push(localize('paradis.githubMetrics.hbar.failed', "失敗{0}件", counts.failures));
			}
			// counts はすでに選択中の窓（5分/1時間/セッション）の集計なので、lastRunAt もその窓の中の最終実行になる
			facts.push(counts.lastRunAt !== undefined ? localize('paradis.githubMetrics.hbar.last', "最終: {0}", fromNow(counts.lastRunAt, true)) : localize('paradis.githubMetrics.hbar.neverRun', "この期間内は未実行"));
			const sub = dom.append(row, $('.paradis-ghm-sub'));
			sub.textContent = facts.join(' · ');
			if (operation.lastErrorMessage) {
				dom.append(row, $('.paradis-ghm-sub.bad')).textContent = localize('paradis.githubMetrics.hbar.lastError', "直近のエラー（全期間）: {0}", operation.lastErrorMessage);
			}
		}
	}

	private renderSpaceBreakdown(panel: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const spaces = snapshot.spaces
			.slice()
			.sort((a, b) => countsForWindow(b, this.windowKey).calls - countsForWindow(a, this.windowKey).calls);

		if (spaces.length === 0) {
			dom.append(panel, $('.paradis-ghm-empty')).textContent = localize('paradis.githubMetrics.operations.empty', "Para Codeはまだ GitHub へリクエストを送信していません。");
			return;
		}

		const maxCalls = Math.max(1, ...spaces.map(space => countsForWindow(space, this.windowKey).calls));

		for (const space of spaces.slice(0, MAX_SPACE_ROWS)) {
			const counts = countsForWindow(space, this.windowKey);
			const row = dom.append(panel, $('.paradis-ghm-hbar-row'));

			const head = dom.append(row, $('.paradis-ghm-hbar-head'));
			const name = dom.append(head, $('.paradis-ghm-hbar-name'));
			name.textContent = spaceLabel(space.space);
			if (space.topCallSite) {
				dom.append(name, $('.paradis-ghm-hbar-sub')).textContent = localize('paradis.githubMetrics.hbar.topCallSite', "最多: {0}", space.topCallSite);
			}
			dom.append(head, $('.paradis-ghm-hbar-value')).textContent = counts.calls.toLocaleString();

			const track = dom.append(row, $('.paradis-ghm-hbar-track'));
			const widthPercent = Math.max(2, (counts.calls / maxCalls) * 100);
			// coreRatioも選択中の窓に対応するものを使う（数値とバーの色分けが食い違わないように）
			const coreRatio = this.windowKey === '5m' ? space.rolling5mCoreRatio : this.windowKey === '1h' ? space.rolling1hCoreRatio : space.coreRatio;
			const corePercent = Math.round(coreRatio * 100);
			dom.append(track, $('span.core')).style.width = `${widthPercent * corePercent / 100}%`;
			dom.append(track, $('span.graphql')).style.width = `${widthPercent * (100 - corePercent) / 100}%`;

			const facts: string[] = [localize('paradis.githubMetrics.hbar.avg', "平均{0}", paradisGithubFormatDuration(counts.avgDurationMs))];
			if (counts.failures > 0) {
				facts.push(localize('paradis.githubMetrics.hbar.failed', "失敗{0}件", counts.failures));
			}
			facts.push(counts.lastRunAt !== undefined ? localize('paradis.githubMetrics.hbar.last', "最終: {0}", fromNow(counts.lastRunAt, true)) : localize('paradis.githubMetrics.hbar.neverRun', "この期間内は未実行"));
			dom.append(row, $('.paradis-ghm-sub')).textContent = facts.join(' · ');
		}
	}

	private renderErrors(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		if (snapshot.lastErrors.length === 0) {
			return;
		}
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.errors', "最近のエラー");
		const panel = dom.append(container, $('.paradis-ghm-panel'));
		for (const error of snapshot.lastErrors.slice(0, MAX_ERROR_ROWS)) {
			const row = dom.append(panel, $('.paradis-ghm-error-row'));
			dom.append(row, $('.paradis-ghm-error-when')).textContent = fromNow(error.at, true);
			const detail = dom.append(row, $('.paradis-ghm-error-detail'));
			dom.append(detail, $('.paradis-ghm-mono')).textContent = error.callSite;
			dom.append(detail, $('.paradis-ghm-error-message')).textContent = error.message;
			if (error.worktreePath) {
				dom.append(detail, $('.paradis-ghm-sub')).textContent = error.worktreePath;
			}
		}
	}

	private renderDebugCopy(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.debug', "デバッグ用コピー");
		const row = dom.append(container, $('.paradis-ghm-grid.cols3'));

		this.addCopyButton(row, localize('paradis.githubMetrics.copy.summary', "サマリーをコピー"), () => buildSummary(snapshot));
		this.addCopyButton(row, localize('paradis.githubMetrics.copy.bundle', "デバッグバンドルをコピー"), () => JSON.stringify(snapshot, undefined, 2));
		this.addCopyButton(row, localize('paradis.githubMetrics.copy.report', "レポートひな形をコピー"), () => buildReportTemplate(snapshot));

		dom.append(container, $('.paradis-ghm-hint')).textContent =
			localize('paradis.githubMetrics.copy.hint', "GitHub連携の不具合を報告する際は、デバッグバンドルを添付してください。");
	}

	private addCopyButton(container: HTMLElement, label: string, build: () => string): void {
		const button = dom.append(container, $('button.paradis-ghm-button')) as HTMLButtonElement;
		dom.append(button, $(ThemeIcon.asCSSSelector(Codicon.clippy)));
		const text = dom.append(button, $('span'));
		text.textContent = label;
		this.bodyDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			this.clipboardService.writeText(build()).then(
				() => { text.textContent = localize('paradis.githubMetrics.copy.done', "コピーしました"); },
				() => { text.textContent = localize('paradis.githubMetrics.copy.failed', "コピーに失敗しました"); }
			).finally(() => {
				this.copyFeedback.value = disposableTimeout(() => {
					text.textContent = label;
				}, COPIED_FEEDBACK_MS);
			});
		}));
	}
}

/** 主要資源 → その他の順に並べるためのランク。 */
function resourceRank(entry: IParadisGithubRateLimitEntry): number {
	const index = PARADIS_GITHUB_PRIMARY_RESOURCES.indexOf(entry.resource);
	return index >= 0 ? index : PARADIS_GITHUB_PRIMARY_RESOURCES.length;
}

/**
 * サンプル間の消費量を棒グラフにする（軸なし・相対比較だけを見るためのミニチャート）。
 * 補助ウィンドウでも動くよう、要素は必ず描画先の Document から作る。
 * `resourceClass` は CSS 側の `.paradis-ghm-chart rect.<class>` で色付けする（core/graphql/search）。
 */
function createBarChart(doc: Document, series: readonly number[], resourceClass: string): SVGElement {
	const width = 100;
	const height = 32;
	const max = Math.max(1, ...series);
	const gap = 0.6;
	const barWidth = Math.max(0.5, (width - gap * (series.length - 1)) / series.length);

	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'paradis-ghm-chart');
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	svg.setAttribute('preserveAspectRatio', 'none');
	svg.setAttribute('aria-hidden', 'true');

	series.forEach((value, index) => {
		const barHeight = Math.max(0.6, (value / max) * height);
		const rect = doc.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('class', resourceClass);
		rect.setAttribute('x', `${index * (barWidth + gap)}`);
		rect.setAttribute('y', `${height - barHeight}`);
		rect.setAttribute('width', `${barWidth}`);
		rect.setAttribute('height', `${barHeight}`);
		svg.appendChild(rect);
	});
	return svg;
}

/**
 * 資源2種を積み上げた棒グラフ（core/graphqlの合算トレンド用）。系列の長さが揃っていない場合は
 * 短い方を0で埋める（片方の資源だけ十分なサンプルが無い場合でも描画は崩さない）。
 */
function createStackedBarChart(doc: Document, seriesA: readonly number[], classA: string, seriesB: readonly number[], classB: string): SVGElement {
	const width = 100;
	const height = 32;
	const length = Math.max(seriesA.length, seriesB.length);
	const at = (series: readonly number[], index: number): number => series[index - (length - series.length)] ?? 0;
	const totals = Array.from({ length }, (_, index) => at(seriesA, index) + at(seriesB, index));
	const max = Math.max(1, ...totals);
	const gap = 0.6;
	const barWidth = Math.max(0.5, (width - gap * (length - 1)) / length);

	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'paradis-ghm-chart');
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	svg.setAttribute('preserveAspectRatio', 'none');
	svg.setAttribute('aria-hidden', 'true');

	for (let index = 0; index < length; index++) {
		const x = index * (barWidth + gap);
		const valueA = at(seriesA, index);
		const valueB = at(seriesB, index);
		let y = height;

		if (valueB > 0) {
			const barHeight = (valueB / max) * height;
			y -= barHeight;
			const rect = doc.createElementNS(SVG_NS, 'rect');
			rect.setAttribute('class', classB);
			rect.setAttribute('x', `${x}`);
			rect.setAttribute('y', `${y}`);
			rect.setAttribute('width', `${barWidth}`);
			rect.setAttribute('height', `${barHeight}`);
			svg.appendChild(rect);
		}
		if (valueA > 0) {
			const barHeight = (valueA / max) * height;
			y -= barHeight;
			const rect = doc.createElementNS(SVG_NS, 'rect');
			rect.setAttribute('class', classA);
			rect.setAttribute('x', `${x}`);
			rect.setAttribute('y', `${y}`);
			rect.setAttribute('width', `${barWidth}`);
			rect.setAttribute('height', `${barHeight}`);
			svg.appendChild(rect);
		}
	}
	return svg;
}

/** callSite別・スペース別の集計から、選択中の時間窓に対応するカウントを取り出す。 */
function countsForWindow(stat: { readonly session: IParadisGithubCallCounts; readonly rolling5m: IParadisGithubCallCounts; readonly rolling1h: IParadisGithubCallCounts }, windowKey: ParadisGithubWindowKey): IParadisGithubCallCounts {
	switch (windowKey) {
		case '5m': return stat.rolling5m;
		case '1h': return stat.rolling1h;
		case 'session': return stat.session;
	}
}

/** 選択中の時間窓・資源フィルタで、呼び出し元の合計カウントを作る（概況カードの「Sent by Para Code」用）。 */
function sumOperationCounts(operations: readonly IParadisGithubOperationStat[], resourceFilter: ParadisGithubResourceFilter, windowKey: ParadisGithubWindowKey): { calls: number; failures: number; rateLimited: number } {
	let calls = 0, failures = 0, rateLimited = 0;
	for (const operation of operations) {
		if (resourceFilter !== 'all' && operation.resource !== resourceFilter) {
			continue;
		}
		const counts = countsForWindow(operation, windowKey);
		calls += counts.calls;
		failures += counts.failures;
		rateLimited += counts.rateLimited;
	}
	return { calls, failures, rateLimited };
}

/**
 * 選択中の資源フィルタ・時間窓で、レート枠消費（アカウント全体）を合算する。
 * `window` は '5m'|'1h' のみを取る（'session' に対応する消費の集計は無いため、呼び出し側で1hへ丸めてから渡す）。
 */
function sumConsumption(consumption: readonly IParadisGithubConsumption[], resourceFilter: ParadisGithubResourceFilter, window: '5m' | '1h'): number | undefined {
	const relevant = resourceFilter === 'all' ? consumption : consumption.filter(item => item.resource === resourceFilter);
	let total: number | undefined;
	for (const item of relevant) {
		const value = window === '5m' ? item.rolling5m : item.rolling1h;
		if (value === undefined) {
			continue;
		}
		total = (total ?? 0) + value;
	}
	return total;
}

/** ワークツリー等に紐付かない呼び出し（Agent Sessionsウィンドウ自身のGitHub APIクライアント経由）を分かりやすい名前にする。 */
function spaceLabel(space: string): string {
	return space === PARADIS_GITHUB_UNSCOPED_SPACE
		? localize('paradis.githubMetrics.space.unscoped', "Agent Sessionsウィンドウ（worktree外）")
		: space;
}

/** 概況カードの見出しに使う、時間窓の短い表現。 */
function windowLabel(windowKey: ParadisGithubWindowKey): string {
	switch (windowKey) {
		case '5m': return localize('paradis.githubMetrics.window.label.5m', "5分");
		case '1h': return localize('paradis.githubMetrics.window.label.1h', "1時間");
		case 'session': return localize('paradis.githubMetrics.window.label.session', "セッション");
	}
}

function buildSummary(snapshot: IParadisGithubMetricsSnapshot): string {
	const lines: string[] = [];
	lines.push(`GitHub API usage (${new Date(snapshot.generatedAt).toISOString()})`);
	for (const entry of snapshot.rateLimits) {
		lines.push(`${entry.resource}: ${entry.remaining}/${entry.limit} left, resets ${new Date(entry.resetAt).toISOString()}`);
	}
	for (const consumption of snapshot.consumption) {
		if (consumption.rolling1h !== undefined) {
			lines.push(`${consumption.resource}: ${Math.round(consumption.rolling1h)} consumed in the last hour`);
		}
	}
	lines.push(`Para Code calls: ${snapshot.totals.rolling5mCalls} in 5m, ${snapshot.totals.sessionCalls} this session, ${snapshot.totals.sessionFailures} failed`);
	const top = snapshot.operations[0];
	lines.push(top ? `Top caller: ${top.callSite} (${top.rolling5m.calls} calls / 5m, ${top.resource})` : 'Top caller: none');
	const topSpace = snapshot.spaces[0];
	lines.push(topSpace ? `Top space: ${spaceLabel(topSpace.space)} (${topSpace.rolling5m.calls} calls / 5m)` : 'Top space: none');
	return lines.join('\n');
}

function buildReportTemplate(snapshot: IParadisGithubMetricsSnapshot): string {
	const lines: string[] = [
		'# GitHub integration report',
		'',
		'## Context',
		'- What I was doing:',
		'- Expected:',
		'- Actual:',
		'',
		'## Snapshot',
		buildSummary(snapshot),
		'',
		'## Recent errors',
	];
	if (snapshot.lastErrors.length === 0) {
		lines.push('- none');
	} else {
		for (const error of snapshot.lastErrors.slice(0, MAX_ERROR_ROWS)) {
			lines.push(`- ${new Date(error.at).toISOString()} ${error.callSite}: ${error.message}`);
		}
	}
	lines.push('', '## Debug bundle', '```json', JSON.stringify(snapshot, undefined, 2), '```');
	return lines.join('\n');
}
