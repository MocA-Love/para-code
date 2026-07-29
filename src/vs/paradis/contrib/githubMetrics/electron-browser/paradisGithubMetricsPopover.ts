/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ステータスバーの GitHub 項目をクリックしたときに出るポップオーバー（案A）。
// 「今このマシンが GitHub の枠をどれだけ食っているか」を数秒で確認することだけに絞り、
// 表や履歴は「詳細を開く」でダッシュボード(EditorPane)へ送る。
// 実体は status bar entry の tooltip(HTMLElement) なので、ShowTooltipCommand によって
// クリックで開く。upstream の Copilot ステータス(chatStatusEntry.ts)と同じ仕組み。

import * as dom from '../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import {
	IParadisGithubMetricsSnapshot,
	IParadisGithubRateLimitEntry,
	paradisGithubFormatCountdown,
	paradisGithubSeverity,
	PARADIS_GITHUB_PRIMARY_RESOURCES,
} from '../common/paradisGithubMetrics.js';
import { paradisGithubResourceLabel, paradisGithubRoundedPercent } from './paradisGithubMetricsFormat.js';

const $ = dom.$;

/** 開いている間のカウントダウン更新間隔。 */
const COUNTDOWN_TICK_MS = 1000;

export interface IParadisGithubMetricsPopoverOptions {
	/** スナップショットの取得（ポップオーバーを開くたびに1回、更新ボタンで再取得）。 */
	readonly fetch: (force: boolean) => Promise<IParadisGithubMetricsSnapshot>;
	/** 「詳細を開く」。ダッシュボードを開いてポップオーバーを閉じる。 */
	readonly openDashboard: () => void;
}

/**
 * ポップオーバー本体。`element` を status bar entry の tooltip として返す。
 * 破棄は tooltip 側の CancellationToken に紐づけて呼び出し元が行う。
 */
export class ParadisGithubMetricsPopover extends Disposable {

	readonly element = $('.paradis-ghm-popover');

	private readonly bodyElement: HTMLElement;
	private readonly updatedElement: HTMLElement;
	private readonly refreshIcon: HTMLElement;
	private readonly countdownTimer = this._register(new IntervalTimer());

	/**
	 * 毎秒書き換える残り時間の表示。構造ごと作り直すとテキスト選択が毎秒消えるので、
	 * 対象の要素と期限だけを覚えておき、テキストノードの差し替えに留める。
	 */
	private readonly countdowns: { element: HTMLElement; deadline: number; format: (remainingMs: number) => string; expired: string }[] = [];

	private snapshot: IParadisGithubMetricsSnapshot | undefined;
	private loading = false;
	private error: string | undefined;

	constructor(private readonly options: IParadisGithubMetricsPopoverOptions) {
		super();

		const header = dom.append(this.element, $('.paradis-ghm-popover-header'));
		const title = dom.append(header, $('.paradis-ghm-popover-title'));
		dom.append(title, $(ThemeIcon.asCSSSelector(Codicon.github)));
		dom.append(title, $('span')).textContent = localize('paradis.githubMetrics.popover.title', "GitHub API Usage");
		this.updatedElement = dom.append(header, $('.paradis-ghm-popover-updated'));

		this.bodyElement = dom.append(this.element, $('.paradis-ghm-popover-body'));

		const footer = dom.append(this.element, $('.paradis-ghm-popover-footer'));
		const refreshButton = dom.append(footer, $('button.paradis-ghm-button')) as HTMLButtonElement;
		this.refreshIcon = dom.append(refreshButton, $(ThemeIcon.asCSSSelector(Codicon.refresh)));
		dom.append(refreshButton, $('span')).textContent = localize('paradis.githubMetrics.popover.refresh', "Refresh");
		this._register(dom.addDisposableListener(refreshButton, dom.EventType.CLICK, () => void this.load(true)));

		const detailsButton = dom.append(footer, $('button.paradis-ghm-button.primary')) as HTMLButtonElement;
		detailsButton.textContent = localize('paradis.githubMetrics.popover.details', "Open Details");
		this._register(dom.addDisposableListener(detailsButton, dom.EventType.CLICK, () => this.options.openDashboard()));

		this.render();
		void this.load(false);

		this.countdownTimer.cancelAndSet(() => this.tickCountdowns(), COUNTDOWN_TICK_MS);
	}

	private async load(force: boolean): Promise<void> {
		if (this.loading) {
			return;
		}
		this.loading = true;
		this.error = undefined;
		this.refreshIcon.classList.add('spin');
		this.render();
		try {
			this.snapshot = await this.options.fetch(force);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.refreshIcon.classList.remove('spin');
			// 初回はホバーへ挿入される前に解決することがあるので、接続状態に関わらず描画する
			// （閉じられている場合はこのインスタンスごと破棄されるため、描画しても害はない）
			this.render();
		}
	}

	private render(): void {
		const snapshot = this.snapshot;
		// レート枠は shared process 側で短時間キャッシュされるので、取得時刻はその実測値を出す
		this.updatedElement.textContent = snapshot
			? localize('paradis.githubMetrics.popover.updated', "Updated {0}", fromNow(snapshot.rateLimitFetchedAt ?? snapshot.generatedAt, true))
			: '';

		dom.clearNode(this.bodyElement);
		this.countdowns.length = 0;

		if (!snapshot) {
			const message = dom.append(this.bodyElement, $('.paradis-ghm-popover-message'));
			message.textContent = this.error
				?? localize('paradis.githubMetrics.popover.loading', "Loading…");
			return;
		}

		if (!snapshot.ghAvailable) {
			const message = dom.append(this.bodyElement, $('.paradis-ghm-popover-message'));
			message.textContent = localize('paradis.githubMetrics.popover.noGh', "The GitHub CLI (gh) was not found, so rate limits cannot be read.");
			return;
		}

		const primary = PARADIS_GITHUB_PRIMARY_RESOURCES
			.map(resource => snapshot.rateLimits.find(entry => entry.resource === resource))
			.filter((entry): entry is IParadisGithubRateLimitEntry => !!entry);

		if (primary.length === 0) {
			const message = dom.append(this.bodyElement, $('.paradis-ghm-popover-message'));
			message.textContent = snapshot.rateLimitError
				?? localize('paradis.githubMetrics.popover.noData', "No rate limit data yet.");
		}

		for (const entry of primary) {
			this.renderLimitRow(entry);
		}

		dom.append(this.bodyElement, $('.paradis-ghm-popover-divider'));

		const coreConsumption = snapshot.consumption.find(item => item.resource === 'core');
		this.renderKeyValue(
			localize('paradis.githubMetrics.popover.consumed5m', "Consumed in the last 5 min"),
			coreConsumption?.rolling5m !== undefined
				? localize('paradis.githubMetrics.popover.requests', "{0} requests", Math.round(coreConsumption.rolling5m))
				: localize('paradis.githubMetrics.popover.notEnoughSamples', "Measuring…")
		);
		this.renderKeyValue(
			localize('paradis.githubMetrics.popover.paraCalls', "Sent via the GitHub CLI (5 min)"),
			snapshot.totals.rolling5mFailures > 0
				? localize('paradis.githubMetrics.popover.callsWithFailures', "{0} ({1} failed)", snapshot.totals.rolling5mCalls, snapshot.totals.rolling5mFailures)
				: `${snapshot.totals.rolling5mCalls}`
		);
		if (coreConsumption?.perMinute !== undefined) {
			this.renderKeyValue(
				localize('paradis.githubMetrics.popover.pace', "Pace"),
				localize('paradis.githubMetrics.popover.perMinute', "{0} req/min", coreConsumption.perMinute.toFixed(1))
			);
		}
		if (coreConsumption?.exhaustionEtaMs !== undefined) {
			const valueElement = this.renderKeyValue(localize('paradis.githubMetrics.popover.eta', "Budget runs out in"), '', 'warning');
			this.addCountdown(
				valueElement,
				snapshot.generatedAt + coreConsumption.exhaustionEtaMs,
				remainingMs => paradisGithubFormatCountdown(remainingMs),
				localize('paradis.githubMetrics.popover.etaNow', "now")
			);
		}

		const lastError = snapshot.lastErrors[0];
		if (lastError) {
			const box = dom.append(this.bodyElement, $('.paradis-ghm-popover-error'));
			dom.append(box, $('.paradis-ghm-popover-error-title')).textContent =
				localize('paradis.githubMetrics.popover.lastError', "Last error · {0}", fromNow(lastError.at, true));
			dom.append(box, $('.paradis-ghm-popover-error-body')).textContent = `${lastError.callSite} — ${lastError.message}`;
		}
	}

	private renderLimitRow(entry: IParadisGithubRateLimitEntry): void {
		const ratio = entry.limit > 0 ? Math.max(0, Math.min(1, entry.remaining / entry.limit)) : 0;
		const severity = paradisGithubSeverity(ratio);

		const row = dom.append(this.bodyElement, $('.paradis-ghm-limit'));
		const top = dom.append(row, $('.paradis-ghm-limit-top'));
		const name = dom.append(top, $('.paradis-ghm-limit-name'));
		const badge = dom.append(name, $('.paradis-ghm-badge'));
		badge.classList.add(entry.resource);
		badge.textContent = paradisGithubResourceLabel(entry.resource);
		dom.append(name, $('span')).textContent = localize('paradis.githubMetrics.popover.remaining', "remaining");
		dom.append(top, $('.paradis-ghm-limit-value')).textContent = `${entry.remaining.toLocaleString()} / ${entry.limit.toLocaleString()}`;

		const gauge = dom.append(row, $('.paradis-ghm-gauge'));
		const fill = dom.append(gauge, $(`span.${severity}`));
		fill.style.width = `${ratio * 100}%`;

		const sub = dom.append(row, $('.paradis-ghm-limit-sub'));
		dom.append(sub, $('span')).textContent = localize('paradis.githubMetrics.popover.percentLeft', "{0}% left", paradisGithubRoundedPercent(ratio));
		this.addCountdown(
			dom.append(sub, $('span')),
			entry.resetAt,
			remainingMs => localize('paradis.githubMetrics.popover.resetsIn', "resets in {0}", paradisGithubFormatCountdown(remainingMs)),
			localize('paradis.githubMetrics.popover.resetSoon', "resetting")
		);
	}

	/** 期限つきの表示を登録し、その場で1回描画する。以降は毎秒 tickCountdowns が書き換える。 */
	private addCountdown(element: HTMLElement, deadline: number, format: (remainingMs: number) => string, expired: string): void {
		this.countdowns.push({ element, deadline, format, expired });
		const remaining = deadline - Date.now();
		element.textContent = remaining > 0 ? format(remaining) : expired;
	}

	private tickCountdowns(): void {
		const now = Date.now();
		for (const countdown of this.countdowns) {
			const remaining = countdown.deadline - now;
			countdown.element.textContent = remaining > 0 ? countdown.format(remaining) : countdown.expired;
		}
	}

	private renderKeyValue(key: string, value: string, tone?: 'warning'): HTMLElement {
		const row = dom.append(this.bodyElement, $('.paradis-ghm-kv'));
		dom.append(row, $('span.k')).textContent = key;
		const valueElement = dom.append(row, $('span.v'));
		valueElement.textContent = value;
		if (tone) {
			valueElement.classList.add(tone);
		}
		return valueElement;
	}
}
