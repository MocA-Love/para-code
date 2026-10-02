// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { RateLimitAccount, RateLimitProviderSnapshot, RateLimitsResult, UsageDashboardResult } from '../store.js';
import { aggregateAccounts, isWindowExpired, summarizeCost, widgetAccount, type UsageEntry } from '../features/usage/usageAggregate.js';
import { pickRateLimitAccount, todayCost } from '../usageFormat.js';
import type { WidgetLimit, WidgetUsage } from './snapshot.js';

/**
 * ウィジェット C（PC の状態）に載せる今日のコストと利用上限を、既存の使用量の応答
 * （`rateLimits` / `usageDashboard`）から作る。アカウントの選び方と今日の範囲は、ホームや使用量の画面と
 * 同じ関数（`pickRateLimitAccount` / `todayCost`）を通す。
 */
export function buildWidgetUsage(limits: RateLimitsResult | undefined, dashboard: UsageDashboardResult | undefined, now: number): WidgetUsage | undefined {
	if (limits === undefined && dashboard === undefined) {
		return undefined;
	}
	const list: WidgetLimit[] = [
		...providerLimits(limits?.claude, 'Claude', 'claude5h', 'claudeWeek', now),
		...providerLimits(limits?.codex, 'Codex', 'codex5h', 'codexWeek', now),
	];
	const fetchedAt = Math.min(limits?.fetchedAt ?? now, dashboard?.fetchedAt ?? now);
	if (dashboard === undefined) {
		return { limits: list, fetchedAt };
	}
	return {
		todayCost: roundCost(todayCost(dashboard, now)),
		costClaude: roundCost(todayCost(dashboard, now, 'claude')),
		costCodex: roundCost(todayCost(dashboard, now, 'codex')),
		limits: list,
		fetchedAt,
	};
}

function roundCost(value: number): number {
	return Math.round(value * 100) / 100;
}

function providerLimits(snapshot: RateLimitProviderSnapshot | undefined, name: string, fiveHourKey: WidgetLimit['key'], weekKey: WidgetLimit['key'], now: number): WidgetLimit[] {
	if (snapshot === undefined) {
		return [];
	}
	return accountLimits(pickRateLimitAccount(snapshot), name, fiveHourKey, weekKey, now);
}

function accountLimits(account: RateLimitAccount | undefined, name: string, fiveHourKey: WidgetLimit['key'], weekKey: WidgetLimit['key'], now: number): WidgetLimit[] {
	if (account === undefined || account.status !== 'ok') {
		return [];
	}
	const result: WidgetLimit[] = [];
	const push = (key: WidgetLimit['key'], label: string, window: { usedPercent: number; resetsAt?: number } | undefined) => {
		// リセット時刻を過ぎた枠の使用率はもう確かでない（ウィジェットは次にアプリが取るまで描き直されない）ので出さない。
		if (window === undefined || !Number.isFinite(window.usedPercent) || isWindowExpired(window, now)) {
			return;
		}
		result.push({
			key,
			label,
			usedPercent: Math.round(Math.min(100, Math.max(0, window.usedPercent))),
			...(window.resetsAt !== undefined && Number.isFinite(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
		});
	};
	push(fiveHourKey, `${name} 5時間`, account.fiveHour);
	push(weekKey, `${name} 週`, account.sevenDay);
	return result;
}

/**
 * 全 PC の合計（ウィジェット C の「コストと利用上限」を「全 PC の合計」にしたとき）。今日のコストは今日取れた PC の
 * 分だけ足し、上限はアカウントで束ねて、provider ごとに 5 時間の使用率が最も高いアカウントを出す（オフラインの PC の
 * 最後の値・リセット時刻を過ぎた枠は選ばない。`widgetAccount`）。
 *
 * 取得時刻はオンラインの出どころのうち最も古いもの。オフラインの出どころがあれば `partial` を立てる（フッターで
 * 「一部オフライン」と分ける）。どこからも何も取れていなければ undefined。
 */
export function buildWidgetUsageAll(entries: readonly UsageEntry[], now: number): WidgetUsage | undefined {
	const timesOf = (list: readonly UsageEntry[]) => list.flatMap(entry => [entry.values.limits?.at, entry.values.cost?.at]).filter((at): at is number => at !== undefined);
	const all = timesOf(entries);
	if (all.length === 0) {
		return undefined;
	}
	const online = timesOf(entries.filter(entry => entry.online));
	const cost = summarizeCost(entries, now);
	const list: WidgetLimit[] = [
		...accountLimits(widgetAccount(aggregateAccounts(entries, 'claude', now), now), 'Claude', 'claude5h', 'claudeWeek', now),
		...accountLimits(widgetAccount(aggregateAccounts(entries, 'codex', now), now), 'Codex', 'codex5h', 'codexWeek', now),
	];
	const fetchedAt = Math.min(...(online.length > 0 ? online : all));
	const partial = entries.some(entry => !entry.online);
	const base = { limits: list, fetchedAt, ...(partial ? { partial: true } : {}) };
	if (cost.today === undefined) {
		return base;
	}
	return {
		todayCost: roundCost(cost.today),
		costClaude: roundCost(summarizeCost(entries, now, 'claude').today ?? 0),
		costCodex: roundCost(summarizeCost(entries, now, 'codex').today ?? 0),
		...base,
	};
}
