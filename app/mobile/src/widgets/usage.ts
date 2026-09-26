// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { RateLimitProviderSnapshot, RateLimitsResult, UsageDashboardResult } from '../store.js';
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
		...providerLimits(limits?.claude, 'Claude', 'claude5h', 'claudeWeek'),
		...providerLimits(limits?.codex, 'Codex', 'codex5h', 'codexWeek'),
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

function providerLimits(snapshot: RateLimitProviderSnapshot | undefined, name: string, fiveHourKey: WidgetLimit['key'], weekKey: WidgetLimit['key']): WidgetLimit[] {
	if (snapshot === undefined) {
		return [];
	}
	const account = pickRateLimitAccount(snapshot);
	if (account === undefined || account.status !== 'ok') {
		return [];
	}
	const result: WidgetLimit[] = [];
	const push = (key: WidgetLimit['key'], label: string, window: { usedPercent: number; resetsAt?: number } | undefined) => {
		if (window === undefined || !Number.isFinite(window.usedPercent)) {
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
