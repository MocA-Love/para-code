// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

// usageFormat → time.ts がフックのために react-native を読む（vitest は Flow 構文を読めない）。純関数だけを使うので差し替える。
vi.mock('../../hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));

import { GITHUB_MONITOR_SPACE, GITHUB_UNSCOPED_SPACE, MobileWarmLeaseLifecycle, type GithubCallCounts, type RtkSavingsResult, type UsageDashboardResult } from '../../store.js';
import {
	agentsInData,
	aggregateModels,
	aggregateProjects,
	barPercent,
	formatCompactTokens,
	formatTokens,
	githubCallerRows,
	githubResetLabel,
	githubSpaceLabel,
	githubSpaceRows,
	recentDailyCosts,
	recentRtkDays,
	savingsPercent,
	unsupportedRequestMessage,
	updateCostWarmLeaseLifecycle,
	updateSystemSpaceDiskWarmLeaseLifecycle,
} from './usageDetailModel.js';

const NOW = new Date(2026, 8, 26, 12, 0, 0).getTime();

function slice(model: string, agent: 'claude' | 'codex', cost: number) {
	return { model, agent, cost, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

const DASHBOARD: UsageDashboardResult = {
	days: [
		{ date: '2026-09-26', models: [slice('opus', 'claude', 3), slice('gpt', 'codex', 1)] },
		{ date: '2026-09-24', models: [slice('opus', 'claude', 2)] },
		// 30日より前
		{ date: '2026-08-01', models: [slice('old', 'claude', 99)] },
	],
	sessions: [],
	projects: [
		{ name: 'a', rawName: 'a', dailyCosts: [{ date: '2026-09-26', cost: 1 }, { date: '2026-08-01', cost: 50 }] },
		{ name: 'b', rawName: 'b', dailyCosts: [{ date: '2026-09-25', cost: 4 }] },
		{ name: 'zero', rawName: 'zero', dailyCosts: [] },
	],
	failedReports: [],
	fetchedAt: NOW,
};

function counts(calls: number): GithubCallCounts {
	return { calls, failures: 0, rateLimited: 0, avgDurationMs: 100, maxDurationMs: 200 };
}

describe('コスト', () => {
	it('データに出てくるエージェントだけを決まった順に返す', () => {
		expect(agentsInData(DASHBOARD)).toEqual(['claude', 'codex']);
	});

	it('モデル別は期間内だけをコストの多い順に合計する', () => {
		const rows = aggregateModels(DASHBOARD, 30, 'all', NOW);
		expect(rows.map(row => [row.model, row.cost])).toEqual([['opus', 5], ['gpt', 1]]);
		expect(rows[0]?.tokens).toBe(30);
		expect(aggregateModels(DASHBOARD, 30, 'codex', NOW).map(row => row.model)).toEqual(['gpt']);
	});

	it('プロジェクト別は期間内の合計で、0 円は除く', () => {
		expect(aggregateProjects(DASHBOARD, 30, NOW)).toEqual([{ name: 'b', cost: 4 }, { name: 'a', cost: 1 }]);
	});

	it('日別は新しい日から並べ、記録の無い日は 0', () => {
		const days = recentDailyCosts(DASHBOARD, 3, 'all', NOW);
		expect(days).toEqual([{ date: '2026-09-26', cost: 4 }, { date: '2026-09-25', cost: 0 }, { date: '2026-09-24', cost: 2 }]);
	});

	it('トークン数を短く書く', () => {
		expect(formatCompactTokens(999)).toBe('999');
		expect(formatCompactTokens(1_500)).toBe('1.5K');
		expect(formatCompactTokens(2_500_000)).toBe('2.5M');
	});
});

describe('RTK の節約', () => {
	it('節約量を B まで短く書く', () => {
		expect(formatTokens(12.4)).toBe('12');
		expect(formatTokens(3_200_000_000)).toBe('3.2B');
		expect(formatTokens(Number.NaN)).toBe('0');
	});

	it('節約率は入力に対する割合（入力 0 なら 0）', () => {
		expect(savingsPercent(25, 100)).toBe(25);
		expect(savingsPercent(25, 0)).toBe(0);
	});

	it('日別は新しい日から並べ、記録の無い日は 0', () => {
		const data: RtkSavingsResult = {
			days: [{ date: '2026-09-25', commands: 2, inputTokens: 10, savedTokens: 7 }],
			totals: { commands: 2, inputTokens: 10, savedTokens: 7 },
			commands: [],
			history: [],
			failedReports: [],
			fetchedAt: NOW,
		};
		expect(recentRtkDays(data, 2, NOW)).toEqual([{ date: '2026-09-26', savedTokens: 0 }, { date: '2026-09-25', savedTokens: 7 }]);
	});
});

describe('GitHub API', () => {
	it('仮想スペースに名前を付ける', () => {
		expect(githubSpaceLabel(GITHUB_UNSCOPED_SPACE)).toContain('Agent Sessions');
		expect(githubSpaceLabel(GITHUB_MONITOR_SPACE)).toBe('残量の取得（自動監視）');
		expect(githubSpaceLabel('repo/wt')).toBe('repo/wt');
	});

	it('呼び出し元の行は選んだ期間の呼び出し数で並べ、資源で棒を塗り分ける', () => {
		const rows = githubCallerRows([
			{ callSite: 'pr', resource: 'graphql', session: counts(9), rolling5m: counts(1), rolling1h: counts(5) },
			{ callSite: 'ci', resource: 'core', session: counts(1), rolling5m: counts(3), rolling1h: counts(2), topWorktreePath: GITHUB_UNSCOPED_SPACE },
		], '5m');
		expect(rows.map(row => [row.key, row.value, row.coreRatio])).toEqual([['ci', 3, 1], ['pr', 1, 0]]);
		expect(rows[0]?.sub).toContain('most:');
		expect(rows[1]?.sub).toBe('GraphQL');
	});

	it('スペースの行は期間に対応した Core の割合を使う', () => {
		const rows = githubSpaceRows([
			{ space: 's', session: counts(1), rolling5m: counts(1), rolling1h: counts(1), coreRatio: 0.1, rolling5mCoreRatio: 0.5, rolling1hCoreRatio: 0.9 },
		], '1h');
		expect(rows[0]?.coreRatio).toBe(0.9);
		expect(rows[0]?.sub).toBe('—');
	});

	it('リセットまでを分・時間で書く', () => {
		expect(githubResetLabel(NOW - 1, NOW)).toBe('まもなくリセット');
		expect(githubResetLabel(NOW + 12 * 60_000, NOW)).toBe('12分後リセット');
		expect(githubResetLabel(NOW + 65 * 60_000, NOW)).toBe('1時間5分後リセット');
	});
});

describe('共通', () => {
	it('棒の長さは最大値に対する割合で、下限を持つ', () => {
		expect(barPercent(50, 100)).toBe(50);
		expect(barPercent(0, 100)).toBe(2);
		expect(barPercent(1, 0)).toBe(2);
		expect(barPercent(200, 100)).toBe(100);
	});

	it('旧い PC の「知らない要求」だけを案内に置き換える', () => {
		expect(unsupportedRequestMessage(new Error('unsupported request: sysres'), '更新してください')).toBe('更新してください');
		expect(unsupportedRequestMessage(new Error('timeout'), '更新してください')).toBe('timeout');
	});
});

describe('warm lease', () => {
	function tracker() {
		const events: string[] = [];
		const acquire = (name: string) => () => {
			events.push(`acquire:${name}`);
			return { dispose: () => events.push(`dispose:${name}`) };
		};
		return { events, acquire };
	}

	it('コスト画面は前面・アプリ前景・接続中の間だけ持ち、PC が替わると取り直す', () => {
		const lifecycle = new MobileWarmLeaseLifecycle();
		const { events, acquire } = tracker();
		const base = { focused: true, appActive: true, online: true, activePcId: 'pc-a', controllerRevision: 1 };
		updateCostWarmLeaseLifecycle(lifecycle, base, acquire('a'));
		updateCostWarmLeaseLifecycle(lifecycle, base, acquire('same'));
		updateCostWarmLeaseLifecycle(lifecycle, { ...base, activePcId: 'pc-b' }, acquire('b'));
		updateCostWarmLeaseLifecycle(lifecycle, { ...base, focused: false }, acquire('none'));
		expect(events).toEqual(['acquire:a', 'dispose:a', 'acquire:b', 'dispose:b']);
	});

	it('システム画面はボリュームの内訳を開いている間だけ持つ', () => {
		const lifecycle = new MobileWarmLeaseLifecycle();
		const { events, acquire } = tracker();
		const base = { focused: true, appActive: true, online: true, volumeAxis: false, activePcId: 'pc-a', controllerRevision: 1 };
		updateSystemSpaceDiskWarmLeaseLifecycle(lifecycle, base, acquire('off'));
		updateSystemSpaceDiskWarmLeaseLifecycle(lifecycle, { ...base, volumeAxis: true }, acquire('on'));
		updateSystemSpaceDiskWarmLeaseLifecycle(lifecycle, base, acquire('off2'));
		expect(events).toEqual(['acquire:on', 'dispose:on']);
	});
});
