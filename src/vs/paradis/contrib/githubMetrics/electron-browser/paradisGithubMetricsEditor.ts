/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub API 利用状況ダッシュボードの EditorPane（案B）。
// ステータスバーのポップオーバー(案A)の「詳細を開く」から開かれる。
// 表示は2階層に分かれている:
//  - アカウント全体のレート枠と消費ペース（gh api rate_limit 由来。他ツールの消費も含む）
//  - Para Code 自身が発行した gh 呼び出しの内訳（どの処理が枠を食っているか）
// チャートは素の SVG DOM で構築し、workbench テーマの CSS 変数で色付けする
// （ccusage ダッシュボードと同じ方針）。

import './media/paradisGithubMetrics.css';
import * as dom from '../../../../base/browser/dom.js';
import { disposableTimeout, IntervalTimer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import {
	IParadisGithubMetricsSnapshot,
	IParadisGithubRateLimitEntry,
	paradisGithubFormatCountdown,
	paradisGithubSeverity,
	PARADIS_GITHUB_PRIMARY_RESOURCES,
} from '../common/paradisGithubMetrics.js';
import { ParadisGithubMetricsClient } from './paradisGithubMetricsClient.js';
import { paradisGithubFormatDuration, paradisGithubResourceLabel, paradisGithubRoundedPercent } from './paradisGithubMetricsFormat.js';
import { PARADIS_GITHUB_METRICS_EDITOR_ID } from './paradisGithubMetricsInput.js';

const $ = dom.$;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 表示中の自動更新間隔。1回ごとに gh のプロセスが起動しうるので、
 * shared process 側の最短取得間隔(45秒)より長くして無駄打ちを避ける。
 */
const VISIBLE_REFRESH_INTERVAL_MS = 60_000;
/** コピーボタンのフィードバック表示時間。 */
const COPIED_FEEDBACK_MS = 2000;
/** 表に出す呼び出し元の最大数。 */
const MAX_OPERATION_ROWS = 12;
/** 一覧に出す直近エラーの最大数。 */
const MAX_ERROR_ROWS = 5;

export class ParadisGithubMetricsEditor extends EditorPane {

	static readonly ID = PARADIS_GITHUB_METRICS_EDITOR_ID;

	private root: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private updatedLabel: HTMLElement | undefined;
	private refreshIcon: HTMLElement | undefined;

	private readonly client: ParadisGithubMetricsClient;
	private readonly bodyDisposables = this._register(new DisposableStore());
	private readonly autoRefreshTimer = this._register(new IntervalTimer());
	/** コピー完了表示を元に戻すタイマー。連打しても1つしか持たない。 */
	private readonly copyFeedback = this._register(new MutableDisposable());

	private snapshot: IParadisGithubMetricsSnapshot | undefined;
	private lastError: string | undefined;
	private loading = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(PARADIS_GITHUB_METRICS_EDITOR_ID, group, telemetryService, themeService, storageService);
		this.client = instantiationService.createInstance(ParadisGithubMetricsClient);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.paradis-ghm'));

		const toolbar = dom.append(this.root, $('.paradis-ghm-toolbar'));
		const titles = dom.append(toolbar, $('.paradis-ghm-titles'));
		dom.append(titles, $('h2')).textContent = localize('paradis.githubMetrics.title', "GitHub API Usage");
		dom.append(titles, $('p')).textContent = localize('paradis.githubMetrics.subtitle', "Rate limits for your GitHub account, and the requests Para Code itself sends.");
		this.updatedLabel = dom.append(titles, $('.paradis-ghm-updated'));

		dom.append(toolbar, $('.paradis-ghm-toolbar-spacer'));

		const refresh = dom.append(toolbar, $('button.paradis-ghm-button')) as HTMLButtonElement;
		this.refreshIcon = dom.append(refresh, $(ThemeIcon.asCSSSelector(Codicon.refresh)));
		dom.append(refresh, $('span')).textContent = localize('paradis.githubMetrics.refresh', "Refresh");
		this._register(dom.addDisposableListener(refresh, dom.EventType.CLICK, () => void this.refresh(true)));

		this.body = dom.append(this.root, $('.paradis-ghm-body'));
		this.body.tabIndex = 0;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.snapshot && !this.loading) {
			void this.refresh(false);
		}
	}

	override layout(_dimension: dom.Dimension): void {
		// 中身は CSS のグリッド/フレックスで伸縮するため、寸法に応じた再描画は不要
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			void this.refresh(false);
			this.autoRefreshTimer.cancelAndSet(() => void this.refresh(false), VISIBLE_REFRESH_INTERVAL_MS);
		} else {
			this.autoRefreshTimer.cancel();
		}
	}

	override focus(): void {
		super.focus();
		this.body?.focus();
	}

	private async refresh(force: boolean): Promise<void> {
		if (this.loading || !this.body) {
			return;
		}
		this.loading = true;
		this.lastError = undefined;
		this.refreshIcon?.classList.add('spin');
		if (!this.snapshot) {
			dom.clearNode(this.body);
			dom.append(this.body, $('.paradis-ghm-message')).textContent = localize('paradis.githubMetrics.loading', "Loading…");
		}
		try {
			this.snapshot = await this.client.getSnapshot(force);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.refreshIcon?.classList.remove('spin');
			// 取得中にペインが破棄されていたら、破棄済みのストアに触らない
			if (!this._store.isDisposed) {
				this.renderBody();
			}
		}
	}

	// ---------- 描画 ----------

	private renderBody(): void {
		const body = this.body;
		if (!body) {
			return;
		}
		this.bodyDisposables.clear();
		dom.clearNode(body);

		const snapshot = this.snapshot;
		if (this.updatedLabel) {
			// 「更新」はレート枠の実取得時刻（shared process 側で短時間キャッシュされるため）
			this.updatedLabel.textContent = snapshot
				? localize('paradis.githubMetrics.updatedAt', "Updated {0} · session started {1}", fromNow(snapshot.rateLimitFetchedAt ?? snapshot.generatedAt, true), fromNow(snapshot.sessionStartedAt, true))
				: '';
		}

		if (!snapshot) {
			dom.append(body, $('.paradis-ghm-message')).textContent =
				this.lastError ?? localize('paradis.githubMetrics.noData', "No data yet.");
			return;
		}

		if (!snapshot.ghAvailable) {
			dom.append(body, $('.paradis-ghm-banner.error')).textContent =
				localize('paradis.githubMetrics.noGh', "The GitHub CLI (gh) was not found. Install and sign in with `gh auth login` to see rate limits.");
		} else if (snapshot.rateLimitError) {
			dom.append(body, $('.paradis-ghm-banner.warning')).textContent =
				localize('paradis.githubMetrics.rateLimitError', "Could not read rate limits: {0}", snapshot.rateLimitError);
		}

		this.renderOverview(body, snapshot);
		this.renderRateLimits(body, snapshot);
		this.renderConsumption(body, snapshot);
		this.renderOperations(body, snapshot);
		this.renderErrors(body, snapshot);
		this.renderDebugCopy(body, snapshot);
	}

	private renderOverview(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const grid = dom.append(container, $('.paradis-ghm-grid.cols4'));

		for (const resource of PARADIS_GITHUB_PRIMARY_RESOURCES) {
			const entry = snapshot.rateLimits.find(item => item.resource === resource);
			const card = dom.append(grid, $('.paradis-ghm-card'));
			dom.append(card, $('.k')).textContent = localize('paradis.githubMetrics.card.remaining', "{0} remaining", paradisGithubResourceLabel(resource));
			if (entry) {
				const ratio = entry.limit > 0 ? Math.max(0, Math.min(1, entry.remaining / entry.limit)) : 0;
				const value = dom.append(card, $('.v'));
				value.textContent = entry.remaining.toLocaleString();
				dom.append(value, $('small')).textContent = ` / ${entry.limit.toLocaleString()}`;
				const gauge = dom.append(card, $('.paradis-ghm-gauge'));
				dom.append(gauge, $(`span.${paradisGithubSeverity(ratio)}`)).style.width = `${paradisGithubRoundedPercent(ratio)}%`;
				dom.append(card, $('.s')).textContent = entry.resetAt > snapshot.generatedAt
					? localize('paradis.githubMetrics.card.resetsIn', "Resets in {0}", paradisGithubFormatCountdown(entry.resetAt - snapshot.generatedAt))
					: localize('paradis.githubMetrics.card.resetting', "Resetting");
			} else {
				dom.append(card, $('.v')).textContent = '—';
				dom.append(card, $('.s')).textContent = localize('paradis.githubMetrics.card.noValue', "Not available");
			}
		}

		const core = snapshot.consumption.find(item => item.resource === 'core');
		const consumedCard = dom.append(grid, $('.paradis-ghm-card'));
		dom.append(consumedCard, $('.k')).textContent = localize('paradis.githubMetrics.card.consumed5m', "Consumed in the last 5 min");
		dom.append(consumedCard, $('.v')).textContent = core?.rolling5m !== undefined ? Math.round(core.rolling5m).toLocaleString() : '—';
		dom.append(consumedCard, $('.s')).textContent = core?.perMinute !== undefined
			? localize('paradis.githubMetrics.card.pace', "{0} req/min · all sources", core.perMinute.toFixed(1))
			: localize('paradis.githubMetrics.card.measuring', "Measuring…");

		const callsCard = dom.append(grid, $('.paradis-ghm-card'));
		dom.append(callsCard, $('.k')).textContent = localize('paradis.githubMetrics.card.paraCalls', "Sent via the GitHub CLI (5 min)");
		dom.append(callsCard, $('.v')).textContent = snapshot.totals.rolling5mCalls.toLocaleString();
		dom.append(callsCard, $('.s')).textContent = localize(
			'paradis.githubMetrics.card.paraCallsSub',
			"{0} failed · {1} rate limited · {2} this session",
			snapshot.totals.rolling5mFailures,
			snapshot.totals.rolling5mRateLimited,
			snapshot.totals.sessionCalls
		);
	}

	private renderRateLimits(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		if (snapshot.rateLimits.length === 0) {
			return;
		}
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.limits', "Rate Limits");
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
			localize('paradis.githubMetrics.limit.percent', "{0}% left", paradisGithubRoundedPercent(ratio));

		const gauge = dom.append(row, $('.paradis-ghm-gauge'));
		dom.append(gauge, $(`span.${paradisGithubSeverity(ratio)}`)).style.width = `${paradisGithubRoundedPercent(ratio)}%`;

		const consumption = snapshot.consumption.find(item => item.resource === entry.resource);
		const facts: string[] = [];
		facts.push(entry.resetAt > snapshot.generatedAt
			? localize('paradis.githubMetrics.limit.resetsIn', "Resets in {0}", paradisGithubFormatCountdown(entry.resetAt - snapshot.generatedAt))
			: localize('paradis.githubMetrics.limit.resetting', "Resetting"));
		if (consumption?.rolling1h !== undefined) {
			facts.push(localize('paradis.githubMetrics.limit.consumed1h', "{0} used in the last hour", Math.round(consumption.rolling1h).toLocaleString()));
		}
		if (consumption?.exhaustionEtaMs !== undefined) {
			facts.push(localize('paradis.githubMetrics.limit.eta', "Runs out in {0} at this pace", paradisGithubFormatCountdown(consumption.exhaustionEtaMs)));
		}
		dom.append(row, $('.paradis-ghm-limit-facts')).textContent = facts.join(' · ');
	}

	private renderConsumption(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		const core = snapshot.consumption.find(item => item.resource === 'core');
		if (!core || core.series.length < 2) {
			return;
		}
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.trend', "REST Consumption Trend");
		const panel = dom.append(container, $('.paradis-ghm-panel.padded'));
		dom.append(panel, $('.paradis-ghm-chart-caption')).textContent =
			localize('paradis.githubMetrics.trend.caption', "Requests consumed between samples (all sources, newest on the right). Samples are only taken while this view or the status bar is active, so the bars do not cover equal time spans.");
		panel.appendChild(createBarChart(panel.ownerDocument, core.series));
	}

	private renderOperations(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.operations', "Requests Para Code Sent via the GitHub CLI");
		const panel = dom.append(container, $('.paradis-ghm-panel'));

		if (snapshot.operations.length === 0) {
			dom.append(panel, $('.paradis-ghm-empty')).textContent = localize('paradis.githubMetrics.operations.empty', "Para Code has not called the GitHub CLI yet.");
			return;
		}

		const table = dom.append(panel, $('table.paradis-ghm-table')) as HTMLTableElement;
		const headRow = dom.append(dom.append(table, $('thead')), $('tr'));
		const headers: { label: string; numeric?: boolean }[] = [
			{ label: localize('paradis.githubMetrics.table.callSite', "Caller") },
			{ label: localize('paradis.githubMetrics.table.rolling', "5 min"), numeric: true },
			{ label: localize('paradis.githubMetrics.table.session', "Session"), numeric: true },
			{ label: localize('paradis.githubMetrics.table.failures', "Failed"), numeric: true },
			{ label: localize('paradis.githubMetrics.table.avg', "Avg"), numeric: true },
			{ label: localize('paradis.githubMetrics.table.last', "Last run") },
		];
		for (const header of headers) {
			const cell = dom.append(headRow, $(header.numeric ? 'th.num' : 'th'));
			cell.textContent = header.label;
		}

		const tbody = dom.append(table, $('tbody'));
		for (const operation of snapshot.operations.slice(0, MAX_OPERATION_ROWS)) {
			const row = dom.append(tbody, $('tr'));

			const nameCell = dom.append(row, $('td'));
			dom.append(nameCell, $('.paradis-ghm-mono')).textContent = operation.callSite;
			if (operation.topWorktreePath) {
				dom.append(nameCell, $('.paradis-ghm-sub')).textContent =
					localize('paradis.githubMetrics.table.topWorktree', "Most from {0}", operation.topWorktreePath);
			}

			dom.append(row, $('td.num')).textContent = operation.rolling5m.calls.toLocaleString();
			dom.append(row, $('td.num')).textContent = operation.session.calls.toLocaleString();

			const failureCell = dom.append(row, $('td.num'));
			failureCell.textContent = operation.session.failures.toLocaleString();
			if (operation.session.failures > 0) {
				failureCell.classList.add('bad');
			}

			dom.append(row, $('td.num')).textContent = paradisGithubFormatDuration(operation.session.avgDurationMs);

			const lastCell = dom.append(row, $('td'));
			dom.append(lastCell, $('span')).textContent = operation.lastRunAt !== undefined ? fromNow(operation.lastRunAt, true) : '—';
			if (operation.lastErrorMessage) {
				dom.append(lastCell, $('.paradis-ghm-sub.bad')).textContent = operation.lastErrorMessage;
			}
		}
	}

	private renderErrors(container: HTMLElement, snapshot: IParadisGithubMetricsSnapshot): void {
		if (snapshot.lastErrors.length === 0) {
			return;
		}
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.errors', "Recent Errors");
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
		dom.append(container, $('.paradis-ghm-section-title')).textContent = localize('paradis.githubMetrics.section.debug', "Debug Copy");
		const row = dom.append(container, $('.paradis-ghm-grid.cols3'));

		this.addCopyButton(row, localize('paradis.githubMetrics.copy.summary', "Copy Summary"), () => buildSummary(snapshot));
		this.addCopyButton(row, localize('paradis.githubMetrics.copy.bundle', "Copy Debug Bundle"), () => JSON.stringify(snapshot, undefined, 2));
		this.addCopyButton(row, localize('paradis.githubMetrics.copy.report', "Copy Report Template"), () => buildReportTemplate(snapshot));

		dom.append(container, $('.paradis-ghm-hint')).textContent =
			localize('paradis.githubMetrics.copy.hint', "Attach the debug bundle when reporting a problem with GitHub integration.");
	}

	private addCopyButton(container: HTMLElement, label: string, build: () => string): void {
		const button = dom.append(container, $('button.paradis-ghm-button')) as HTMLButtonElement;
		dom.append(button, $(ThemeIcon.asCSSSelector(Codicon.clippy)));
		const text = dom.append(button, $('span'));
		text.textContent = label;
		this.bodyDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			this.clipboardService.writeText(build()).then(
				() => { text.textContent = localize('paradis.githubMetrics.copy.done', "Copied"); },
				() => { text.textContent = localize('paradis.githubMetrics.copy.failed', "Copy failed"); }
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
 */
function createBarChart(doc: Document, series: readonly number[]): SVGElement {
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
		rect.setAttribute('x', `${index * (barWidth + gap)}`);
		rect.setAttribute('y', `${height - barHeight}`);
		rect.setAttribute('width', `${barWidth}`);
		rect.setAttribute('height', `${barHeight}`);
		svg.appendChild(rect);
	});
	return svg;
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
	lines.push(top ? `Top caller: ${top.callSite} (${top.rolling5m.calls} calls / 5m)` : 'Top caller: none');
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
