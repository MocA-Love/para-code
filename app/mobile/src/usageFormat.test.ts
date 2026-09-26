// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test, vi } from 'vitest';

// time.ts はフック（useNow）のために react-native を読む。ここで使うのは純粋な formatRelativeTime だけなので、
// react-native（Flow構文で vitest が読めない）を引かないようにフックの読み込み先だけ差し替える。
vi.mock('./hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
import {
	dayCost, formatLimitCountdown, localDateKey, pickRateLimitAccount, resourceLevelColor, staleValueLabel,
	todayCost, updatedAtLabel, usedRatio,
} from './usageFormat.js';
import { colors } from './theme.js';
import type { RateLimitAccount, UsageDashboardResult } from './store.js';

const NOW = new Date(2026, 8, 26, 14, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('updatedAtLabel / staleValueLabel', () => {
	test('1分未満は「今に」と繋がないよう「たった今」にする', () => {
		expect(updatedAtLabel(NOW - 20_000, NOW)).toBe('たった今更新');
		expect(staleValueLabel(NOW - 20_000, NOW).startsWith('たった今の値')).toBe(true);
	});

	test('それ以降は相対時刻で書く', () => {
		expect(updatedAtLabel(NOW - 5 * MIN, NOW)).toBe('5分前に更新');
		expect(staleValueLabel(NOW - 12 * HOUR, NOW).startsWith('12時間前の値')).toBe(true);
	});

	test('古い値には、なぜ更新されないかも書く', () => {
		expect(staleValueLabel(NOW - 12 * HOUR, NOW)).toContain('更新されません');
	});
});

describe('formatLimitCountdown', () => {
	test('日・時間・分の粒度を残り時間で切り替える', () => {
		expect(formatLimitCountdown(NOW + 3 * 24 * HOUR + 12 * HOUR, NOW)).toBe('3d 12h');
		expect(formatLimitCountdown(NOW + 2 * HOUR + 27 * MIN, NOW)).toBe('2h 27m');
		expect(formatLimitCountdown(NOW + 41 * MIN, NOW)).toBe('41m');
	});

	test('過ぎた・無いリセット時刻は出さない', () => {
		expect(formatLimitCountdown(NOW - 1, NOW)).toBeUndefined();
		expect(formatLimitCountdown(undefined, NOW)).toBeUndefined();
	});
});

describe('今日のコスト', () => {
	const slice = (agent: 'claude' | 'codex', cost: number) => ({
		model: `${agent}-model`, agent, cost, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
	});
	const today = { date: localDateKey(new Date(NOW)), models: [slice('claude', 1.5), slice('codex', 0.25)] };
	const data: UsageDashboardResult = {
		days: [
			today,
			{ date: localDateKey(new Date(NOW - 24 * HOUR)), models: [slice('claude', 9)] },
		],
		sessions: [], projects: [], failedReports: [], fetchedAt: NOW,
	};

	test('今日の行だけを合計する（前日は含めない）', () => {
		expect(todayCost(data, NOW)).toBeCloseTo(1.75);
		expect(todayCost(data, NOW, 'codex')).toBeCloseTo(0.25);
	});

	test('今日の記録が無ければ 0', () => {
		expect(todayCost({ ...data, days: [] }, NOW)).toBe(0);
	});

	test('dayCost はエージェントで絞れる', () => {
		expect(dayCost(today, 'claude')).toBeCloseTo(1.5);
		expect(dayCost(today, 'all')).toBeCloseTo(1.75);
	});
});

describe('pickRateLimitAccount', () => {
	const account = (id: string, overrides: Partial<RateLimitAccount> = {}): RateLimitAccount => ({ provider: 'claude', id, status: 'ok', ...overrides });

	test('使用中で値の取れているアカウントを優先する', () => {
		const picked = pickRateLimitAccount({ accounts: [account('a'), account('b', { active: true })] });
		expect(picked?.id).toBe('b');
	});

	test('使用中の値が取れていなければ、値の取れている別のアカウントを出す', () => {
		const picked = pickRateLimitAccount({ accounts: [account('a', { active: true, status: 'relogin_required' }), account('b')] });
		expect(picked?.id).toBe('b');
	});

	test('どれも取れていなければ使用中のものを返し、空なら undefined', () => {
		expect(pickRateLimitAccount({ accounts: [account('a', { status: 'error' }), account('b', { active: true, status: 'error' })] })?.id).toBe('b');
		expect(pickRateLimitAccount({ accounts: [] })).toBeUndefined();
	});
});

describe('usedRatio / resourceLevelColor', () => {
	test('使用率は 0〜1 に丸め、上限が取れていなければ 0', () => {
		expect(usedRatio(1_250, 5_000)).toBeCloseTo(0.25);
		expect(usedRatio(6_000, 5_000)).toBe(1);
		expect(usedRatio(10, 0)).toBe(0);
	});

	test('平常時は警告の黄と区別できる緑にする', () => {
		expect(resourceLevelColor('normal')).toBe(colors.green);
		expect(resourceLevelColor('normal')).not.toBe(resourceLevelColor('warn'));
		expect(resourceLevelColor('critical')).toBe(colors.red);
	});
});
