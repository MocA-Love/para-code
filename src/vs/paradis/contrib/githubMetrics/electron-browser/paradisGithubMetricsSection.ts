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
	IParadisGithubMetricsSnapshot,
	IParadisGithubRateLimitEntry,
	paradisGithubFormatCountdown,
	paradisGithubOtherConsumption,
	paradisGithubSeverity,
	PARADIS_GITHUB_PRIMARY_RESOURCES,
	PARADIS_GITHUB_MONITOR_SPACE,
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
/** 表に出す呼び出し元の最大数。 */
const MAX_OPERATION_ROWS = 12;
/** 一覧に出す直近エラーの最大数。 */
const MAX_ERROR_ROWS = 5;
/** ホストから幅を教えてもらう前に仮定しておく幅。 */
const DEFAULT_SECTION_WIDTH = 900;


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
		for (const pause of snapshot.rateLimitPauses ?? []) {
			dom.append(body, $('.paradis-ghm-banner.warning')).textContent = localize(
				'paradis.githubMetrics.paused',
				"GitHub の上限（{0}）に達したため、プルリクエストと Issue の更新を {1} 分後まで止めています。",
				paradisGithubResourceLabel(pause.resource),
				Math.max(1, Math.ceil((pause.until - snapshot.generatedAt) / 60_000)),
			);
		}

		// 「枠は足りるか」と「誰が使っているか」の 2 つに絞る（Q537 の 14 A）。GitHub の枠は 1 時間の窓なので、どれも直近 1 時間で見る
		this.renderLimitsAndUsers(body, snapshot);
		this.renderRemainingTrend(body, snapshot);
		this.renderParaCodeBreakdown(body, snapshot);
		this.renderErrors(body, snapshot);
		this.renderDebugCopy(body, snapshot);
	}

	/** 左に「枠は足りるか」（資源ごとの残量・リセット・このペースでの見込み・止めている取得）、右に「誰が使っているか」。 */
	private renderLimitsAndUsers(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const grid = dom.append(container, $('.paradis-ghm-grid.cols2'));

		const limitsColumn = dom.append(grid, $('div'));
		dom.append(limitsColumn, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.enough', "枠は足りるか（アカウント全体）");
		const limitsPanel = dom.append(limitsColumn, $('.paradis-ghm-panel'));
		if (snapshot.rateLimits.length === 0) {
			dom.append(limitsPanel, $('.paradis-ghm-empty')).textContent = localize('paradis.githubMetrics.limits.none', "まだ枠の残りを取得できていません。");
		}
		// 主要資源を先に、それ以外は元の順で続ける（見る頻度の高い順に並べる）
		for (const entry of [...snapshot.rateLimits].sort((a, b) => resourceRank(a) - resourceRank(b))) {
			this.renderRateLimitRow(limitsPanel, entry, snapshot);
		}
		const pauses = snapshot.rateLimitPauses ?? [];
		dom.append(limitsPanel, $('.paradis-ghm-hint')).textContent = pauses.length === 0
			? localize('paradis.githubMetrics.pauses.none', "止めている取得: なし（枠を使い切ると、プルリクエストと Issue の更新をリセットまで止めます）")
			: localize('paradis.githubMetrics.pauses.some', "止めている取得: {0}", pauses.map(pause => localize('paradis.githubMetrics.pauses.entry', "{0} の枠でプルリクエストと Issue の更新を {1} 分後まで", paradisGithubResourceLabel(pause.resource), Math.max(1, Math.ceil((pause.until - snapshot.generatedAt) / 60_000)))).join('、'));

		const usersColumn = dom.append(grid, $('div'));
		dom.append(usersColumn, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.who', "誰が使っているか（直近1時間）");
		const usersPanel = dom.append(usersColumn, $('.paradis-ghm-panel'));
		this.renderUsers(usersPanel, snapshot);
	}

	/** Para Code が送ったものと、それ以外（枠の消費から Para Code の分を引いた推定）。 */
	private renderUsers(panel: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const paraCode = { core: 0, graphql: 0 };
		for (const operation of snapshot.operations) {
			const counts = operation.rolling1h;
			paraCode[operation.resource] += counts.calls - counts.rateLimited;
		}
		const paraTotal = paraCode.core + paraCode.graphql;
		const other = paradisGithubOtherConsumption(snapshot.consumption, snapshot.operations, 'all', '1h');
		const maxCalls = Math.max(1, paraTotal, Math.round(other ?? 0));

		const paraRow = dom.append(panel, $('.paradis-ghm-hbar-row'));
		const paraHead = dom.append(paraRow, $('.paradis-ghm-hbar-head'));
		dom.append(paraHead, $('.paradis-ghm-hbar-name')).textContent = localize('paradis.githubMetrics.who.paraCode', "Para Code");
		dom.append(paraHead, $('.paradis-ghm-hbar-value')).textContent = paraTotal.toLocaleString();
		const paraTrack = dom.append(paraRow, $('.paradis-ghm-hbar-track'));
		dom.append(paraTrack, $('span.core')).style.width = `${(paraCode.core / maxCalls) * 100}%`;
		dom.append(paraTrack, $('span.graphql')).style.width = `${(paraCode.graphql / maxCalls) * 100}%`;
		const top = snapshot.operations
			.filter(operation => operation.rolling1h.calls > 0 && operation.topWorktreePath !== PARADIS_GITHUB_MONITOR_SPACE)
			.sort((a, b) => b.rolling1h.calls - a.rolling1h.calls)
			.slice(0, 3)
			.map(operation => `${operation.callSite} ${operation.rolling1h.calls}`);
		// 残量を取る呼び出し（GET /user と GraphQL の viewer）も枠を使うので、帯の数に含めたまま、内訳にもそう書く
		// （/rate_limit と違って枠に数えられる）。下の「Para Code の内訳」には出さないので、ここで数を合わせる
		const probes = snapshot.operations
			.filter(operation => operation.topWorktreePath === PARADIS_GITHUB_MONITOR_SPACE)
			.reduce((sum, operation) => sum + operation.rolling1h.calls - operation.rolling1h.rateLimited, 0);
		if (probes > 0) {
			top.push(localize('paradis.githubMetrics.who.probes', "残量の取得 {0}", probes));
		}
		dom.append(paraRow, $('.paradis-ghm-sub')).textContent = top.length > 0
			? localize('paradis.githubMetrics.who.paraCodeTop', "REST {0}・GraphQL {1} · {2}", paraCode.core, paraCode.graphql, top.join('・'))
			: localize('paradis.githubMetrics.who.paraCodeCounts', "REST {0}・GraphQL {1}", paraCode.core, paraCode.graphql);

		const otherRow = dom.append(panel, $('.paradis-ghm-hbar-row'));
		const otherHead = dom.append(otherRow, $('.paradis-ghm-hbar-head'));
		dom.append(otherHead, $('.paradis-ghm-hbar-name')).textContent = localize('paradis.githubMetrics.who.other', "Para Code 以外");
		dom.append(otherHead, $('.paradis-ghm-hbar-value')).textContent = other !== undefined ? Math.round(other).toLocaleString() : '—';
		const otherTrack = dom.append(otherRow, $('.paradis-ghm-hbar-track'));
		dom.append(otherTrack, $('span.other')).style.width = `${((other ?? 0) / maxCalls) * 100}%`;
		dom.append(otherRow, $('.paradis-ghm-sub')).textContent = other !== undefined
			? localize('paradis.githubMetrics.who.otherSub', "エージェントがターミナルで打った gh、拡張機能、ブラウザなど。枠の消費から Para Code の送信を引いた推定で、中身は GitHub から分かりません")
			: localize('paradis.githubMetrics.who.measuring', "枠の消費を計測中です（この画面かステータスバーが出ている間に残量を取ります）");
	}

	/** 直近 60 分の残量の推移。サンプルの間隔に関係なく、時刻の軸をそろえて線で描く。 */
	private renderRemainingTrend(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const series = PARADIS_GITHUB_PRIMARY_RESOURCES
			.map(resource => ({ resource, points: snapshot.consumption.find(item => item.resource === resource)?.history ?? [] }))
			.filter(entry => entry.points.length >= 2);
		if (series.length === 0) {
			return;
		}
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.remainingTrend', "残量の推移（直近60分）");
		const panel = dom.append(container, $('.paradis-ghm-panel.padded'));
		const legend = dom.append(panel, $('.paradis-ghm-legend'));
		for (const { resource } of series) {
			const item = dom.append(legend, $('span'));
			dom.append(item, $('i')).style.background = resource === 'graphql' ? 'var(--vscode-charts-purple)' : 'var(--vscode-charts-blue)';
			dom.append(item, $('span')).textContent = paradisGithubResourceLabel(resource);
		}
		panel.appendChild(createRemainingChart(panel.ownerDocument, series, snapshot.generatedAt));
		const axis = dom.append(panel, $('.paradis-ghm-chart-axis'));
		dom.append(axis, $('span')).textContent = localize('paradis.githubMetrics.trend.start', "60分前");
		dom.append(axis, $('span')).textContent = localize('paradis.githubMetrics.trend.now', "現在");
		dom.append(panel, $('.paradis-ghm-chart-caption')).textContent = localize('paradis.githubMetrics.trend.remainingCaption', "縦軸は残りの割合。点線は枠のリセット。残量はこの画面かステータスバーが出ている間だけ取ります。");
	}

	/** Para Code が送ったものの内訳（直近 1 時間。0 件の行と、残量を取るための呼び出しは出さない）。 */
	private renderParaCodeBreakdown(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.paraCode', "Para Code の内訳（直近1時間）");
		const panel = dom.append(container, $('.paradis-ghm-panel'));
		const operations = snapshot.operations
			.filter(operation => operation.rolling1h.calls > 0 && operation.topWorktreePath !== PARADIS_GITHUB_MONITOR_SPACE)
			.sort((a, b) => b.rolling1h.calls - a.rolling1h.calls);
		if (operations.length === 0) {
			dom.append(panel, $('.paradis-ghm-empty')).textContent = localize('paradis.githubMetrics.paraCode.none', "直近1時間に Para Code が送ったものはありません。");
			return;
		}
		const maxCalls = Math.max(1, ...operations.map(operation => operation.rolling1h.calls));
		for (const operation of operations.slice(0, MAX_OPERATION_ROWS)) {
			const counts = operation.rolling1h;
			const row = dom.append(panel, $('.paradis-ghm-hbar-row'));
			const head = dom.append(row, $('.paradis-ghm-hbar-head'));
			const name = dom.append(head, $('.paradis-ghm-hbar-name.paradis-ghm-mono'));
			name.textContent = operation.callSite;
			if (operation.topWorktreePath) {
				dom.append(name, $('.paradis-ghm-hbar-sub')).textContent = localize('paradis.githubMetrics.table.topWorktree', "最多: {0}", spaceLabel(operation.topWorktreePath));
			}
			dom.append(head, $('.paradis-ghm-hbar-value')).textContent = counts.calls.toLocaleString();
			const track = dom.append(row, $('.paradis-ghm-hbar-track'));
			dom.append(track, $(`span.${operation.resource}`)).style.width = `${Math.max(2, (counts.calls / maxCalls) * 100)}%`;
			const facts: string[] = [localize('paradis.githubMetrics.hbar.avg', "平均{0}", paradisGithubFormatDuration(counts.avgDurationMs))];
			if (counts.failures > 0) {
				facts.push(localize('paradis.githubMetrics.hbar.failed', "失敗{0}件", counts.failures));
			}
			if (counts.lastRunAt !== undefined) {
				facts.push(localize('paradis.githubMetrics.hbar.last', "最終: {0}", fromNow(counts.lastRunAt, true)));
			}
			dom.append(row, $('.paradis-ghm-sub')).textContent = facts.join(' · ');
			if (operation.lastErrorMessage) {
				dom.append(row, $('.paradis-ghm-sub.bad')).textContent = localize('paradis.githubMetrics.hbar.lastError', "直近のエラー（全期間）: {0}", operation.lastErrorMessage);
			}
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
		} else if (consumption?.perMinute !== undefined && entry.resetAt > snapshot.generatedAt) {
			facts.push(localize('paradis.githubMetrics.limit.enough', "このペースならリセットまでもつ"));
		}
		dom.append(row, $('.paradis-ghm-limit-facts')).textContent = facts.join(' · ');
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

/** ワークツリー等に紐付かない呼び出し（Agent Sessionsウィンドウ自身のGitHub APIクライアント経由、レート枠の取得）を分かりやすい名前にする。 */
function spaceLabel(space: string): string {
	switch (space) {
		case PARADIS_GITHUB_UNSCOPED_SPACE:
			return localize('paradis.githubMetrics.space.unscoped', "Agent Sessionsウィンドウ（worktree外）");
		case PARADIS_GITHUB_MONITOR_SPACE:
			return localize('paradis.githubMetrics.space.monitor', "残量の取得（自動監視）");
		default:
			return space;
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

/**
 * 直近 60 分の残量（残りの割合）の推移を、資源ごとの線で描く。横軸は時刻（左端が 60 分前、右端が今）。
 * サンプルの間隔に関係なく時刻の位置に点を置き、枠がリセットされた所（リセット時刻が進んだ所）に点線を引く。
 * 補助ウィンドウでも動くよう、要素は必ず描画先の Document から作る。
 */
function createRemainingChart(doc: Document, series: readonly { readonly resource: string; readonly points: readonly { readonly at: number; readonly remaining: number; readonly limit: number; readonly resetAt: number }[] }[], now: number): SVGElement {
	const width = 600;
	const height = 80;
	const start = now - 60 * 60 * 1000;
	const x = (at: number) => Math.max(0, Math.min(width, ((at - start) / (now - start)) * width));
	const y = (ratio: number) => height - 2 - Math.max(0, Math.min(1, ratio)) * (height - 4);
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'paradis-ghm-chart remaining');
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	svg.setAttribute('preserveAspectRatio', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const { resource, points } of series) {
		let previousReset: number | undefined;
		for (const point of points) {
			// リセット時刻が 1 分より大きく進んだら、その時刻に枠がリセットされた
			if (previousReset !== undefined && point.resetAt - previousReset > 60_000) {
				const line = doc.createElementNS(SVG_NS, 'line');
				line.setAttribute('class', 'reset');
				line.setAttribute('x1', `${x(point.at)}`);
				line.setAttribute('x2', `${x(point.at)}`);
				line.setAttribute('y1', '0');
				line.setAttribute('y2', `${height}`);
				svg.appendChild(line);
			}
			previousReset = point.resetAt;
		}
		const polyline = doc.createElementNS(SVG_NS, 'polyline');
		polyline.setAttribute('class', resource);
		polyline.setAttribute('points', points.filter(point => point.at >= start).map(point => `${x(point.at)},${y(point.limit > 0 ? point.remaining / point.limit : 0)}`).join(' '));
		svg.appendChild(polyline);
	}
	return svg;
}
