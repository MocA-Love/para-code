// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

// usageFormat → time.ts がフックのために react-native を読む（vitest は Flow 構文を読めない）。純関数だけを使うので差し替える。
vi.mock('../hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
import type { RateLimitAccount, UsageDashboardResult } from '../store.js';
import { buildUsageEntries, type UsageSourceInfo } from '../features/usage/usageAggregate.js';
import { buildWidgetSnapshot, parseWidgetSnapshot } from './snapshot.js';
import { buildWidgetUsageAll } from './usage.js';

const NOW = new Date(2026, 9, 3, 12, 0, 0).getTime();
const HOUR = 60 * 60_000;

function source(id: string, online = true): UsageSourceInfo {
	return { key: `pc:${id}`, kind: 'pc', pcId: id, pcName: id, online };
}

function account(email: string, fiveHour: number, provider: 'claude' | 'codex' = 'claude'): RateLimitAccount {
	return { provider, id: email, email, status: 'ok', fiveHour: { usedPercent: fiveHour, resetsAt: NOW + HOUR }, sevenDay: { usedPercent: 10 } };
}

function cost(value: number, agent: 'claude' | 'codex'): UsageDashboardResult {
	return {
		days: [{ date: '2026-10-03', models: [{ model: 'm', agent, cost: value, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }] }],
		sessions: [], projects: [], failedReports: [], fetchedAt: NOW,
	};
}

describe('buildWidgetUsageAll', () => {
	it('今日のコストを足し、上限は provider ごとに最も使っているアカウントを出す', () => {
		const entries = buildUsageEntries([source('a'), source('b')], {
			'pc:a': {
				limits: { value: { claude: { accounts: [account('x@a', 20)] }, codex: { accounts: [account('c@a', 5, 'codex')] }, fetchedAt: NOW }, at: NOW - HOUR, receivedAt: NOW },
				cost: { value: cost(1.234, 'claude'), at: NOW - HOUR, receivedAt: NOW },
			},
			'pc:b': {
				limits: { value: { claude: { accounts: [account('y@b', 70), account('x@a', 25)] }, codex: { accounts: [] }, fetchedAt: NOW }, at: NOW, receivedAt: NOW },
				cost: { value: cost(2, 'codex'), at: NOW, receivedAt: NOW },
			},
		});
		expect(buildWidgetUsageAll(entries, NOW)).toEqual({
			todayCost: 3.23,
			costClaude: 1.23,
			costCodex: 2,
			limits: [
				{ key: 'claude5h', label: 'Claude 5時間', usedPercent: 70, resetsAt: NOW + HOUR },
				{ key: 'claudeWeek', label: 'Claude 週', usedPercent: 10 },
				{ key: 'codex5h', label: 'Codex 5時間', usedPercent: 5, resetsAt: NOW + HOUR },
				{ key: 'codexWeek', label: 'Codex 週', usedPercent: 10 },
			],
			fetchedAt: NOW - HOUR,
		});
		expect(buildWidgetUsageAll(buildUsageEntries([source('a')], {}), NOW)).toBeUndefined();
	});

	it('要約の usageAll を書いて読み戻せる。渡さなければ前回の要約のものを残し、PC が1台も無ければ落とす', () => {
		const usageAll = { todayCost: 1, limits: [], fetchedAt: NOW, partial: true };
		const pc = { id: 'a', name: 'A', connection: 'online', pcOnline: true, waiting: 0, lastOnlineAt: NOW, battery: undefined };
		const input = { ready: true, pcs: [pc], activePcId: undefined, active: undefined, includeDetail: false, outbox: [] };
		const first = buildWidgetSnapshot({ ...input, usageAll }, undefined, NOW);
		expect(parseWidgetSnapshot(JSON.stringify(first))?.usageAll).toEqual(usageAll);
		expect(buildWidgetSnapshot(input, first, NOW).usageAll).toEqual(usageAll);
		expect(buildWidgetSnapshot({ ...input, pcs: [] }, first, NOW).usageAll).toBeUndefined();
	});

	it('オフラインの PC の最後の値・リセット時刻を過ぎた枠は上限に選ばず、取得時刻はオンラインの出どころの最も古いもの', () => {
		const expired = { ...account('e@x', 95), fiveHour: { usedPercent: 95, resetsAt: NOW - 1 } };
		const entries = buildUsageEntries([source('a'), source('b', false)], {
			'pc:a': { limits: { value: { claude: { accounts: [account('live@x', 30), expired] }, codex: { accounts: [] }, fetchedAt: NOW }, at: NOW - HOUR, receivedAt: NOW } },
			'pc:b': { limits: { value: { claude: { accounts: [account('off@x', 99)] }, codex: { accounts: [] }, fetchedAt: NOW }, at: NOW - 5 * HOUR, receivedAt: NOW } },
		});
		const usage = buildWidgetUsageAll(entries, NOW);
		expect({ limits: usage?.limits.map(limit => [limit.key, limit.usedPercent]), fetchedAt: usage?.fetchedAt, partial: usage?.partial }).toEqual({
			limits: [['claude5h', 30], ['claudeWeek', 10]],
			fetchedAt: NOW - HOUR,
			partial: true,
		});
	});
});
