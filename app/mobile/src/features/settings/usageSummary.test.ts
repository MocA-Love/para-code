// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

// usageFormat → time.ts がフックのために react-native を読む（vitest は Flow 構文を読めない）。純関数だけを使うので差し替える。
vi.mock('../../hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
import type { RateLimitAccount, UsageDashboardResult } from '../../store.js';
import {
	accountHint,
	accountName,
	accountStatusMessage,
	accountWindows,
	formatUsd,
	providerEmptyMessage,
	ratioPercent,
	recentDailyAverage,
	resetInLabel,
	usageFootNote,
} from './usageSummary.js';

const NOW = new Date(2026, 8, 26, 12, 0, 0).getTime();
const MINUTE = 60_000;

function account(overrides: Partial<RateLimitAccount> = {}): RateLimitAccount {
	return { provider: 'claude', id: 'acc-1', status: 'ok', ...overrides };
}

function dashboard(days: { date: string; cost: number; agent?: 'claude' | 'codex' }[]): UsageDashboardResult {
	return {
		days: days.map(day => ({
			date: day.date,
			models: [{ model: 'm', agent: day.agent ?? 'claude', cost: day.cost, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
		})),
		sessions: [],
		projects: [],
		failedReports: [],
		fetchedAt: NOW,
	};
}

describe('resetInLabel', () => {
	it('1時間未満は分で', () => {
		expect(resetInLabel(NOW + 35 * MINUTE, NOW)).toBe('35分後にリセット');
	});

	it('1日未満は時間と分で（分が0なら時間だけ）', () => {
		expect(resetInLabel(NOW + 130 * MINUTE, NOW)).toBe('2時間10分後にリセット');
		expect(resetInLabel(NOW + 120 * MINUTE, NOW)).toBe('2時間後にリセット');
	});

	it('1日以上は日と時間で（時間が0なら日だけ）', () => {
		expect(resetInLabel(NOW + 3 * 24 * 60 * MINUTE, NOW)).toBe('3日後にリセット');
		expect(resetInLabel(NOW + (3 * 24 + 5) * 60 * MINUTE, NOW)).toBe('3日5時間後にリセット');
	});

	it('過ぎている・時刻が無いときは出さない', () => {
		expect(resetInLabel(NOW - MINUTE, NOW)).toBeUndefined();
		expect(resetInLabel(NOW, NOW)).toBeUndefined();
		expect(resetInLabel(undefined, NOW)).toBeUndefined();
		expect(resetInLabel(Number.NaN, NOW)).toBeUndefined();
	});
});

describe('recentDailyAverage', () => {
	it('今日を含む直近7日の合計を7で割る（記録の無い日は0）', () => {
		const data = dashboard([
			{ date: '2026-09-26', cost: 7 },
			{ date: '2026-09-20', cost: 7 },
			// 8日前は範囲外
			{ date: '2026-09-18', cost: 100 },
		]);
		expect(recentDailyAverage(data, NOW)).toBeCloseTo(2);
	});

	it('エージェントで絞れる', () => {
		const data = dashboard([
			{ date: '2026-09-26', cost: 7, agent: 'claude' },
			{ date: '2026-09-25', cost: 14, agent: 'codex' },
		]);
		expect(recentDailyAverage(data, NOW, 7, 'codex')).toBeCloseTo(2);
	});

	it('期間に記録が1日も無ければ undefined', () => {
		expect(recentDailyAverage(dashboard([{ date: '2026-09-01', cost: 3 }]), NOW)).toBeUndefined();
		expect(recentDailyAverage(dashboard([]), NOW)).toBeUndefined();
	});
});

describe('accountName / accountWindows', () => {
	it('メール → ホームの呼び名 → ID の順に使う', () => {
		expect(accountName(account({ email: 'a@example.com', homeLabel: 'home' }))).toBe('a@example.com');
		expect(accountName(account({ homeLabel: 'home' }))).toBe('home');
		expect(accountName(account())).toBe('acc-1');
	});

	it('5時間 → 7日 → 追加の枠の順に並べる', () => {
		const rows = accountWindows(account({
			sevenDay: { usedPercent: 30 },
			fiveHour: { usedPercent: 40 },
			scoped: [{ usedPercent: 10, label: 'Opus' }, { usedPercent: 5 }],
		}));
		expect(rows.map(row => row.label)).toEqual(['5時間', '7日', 'Opus', '追加枠']);
	});
});

describe('accountStatusMessage', () => {
	it('値が取れていれば説明を出さない', () => {
		expect(accountStatusMessage(account())).toBeUndefined();
	});

	it('取得を止めているだけのときは再ログインを促さない', () => {
		expect(accountStatusMessage(account({ status: 'refreshing' }))).not.toContain('再ログイン');
		expect(accountStatusMessage(account({ status: 'unavailable' }))).not.toContain('再ログイン');
	});

	it('認証の問題は再ログインを促す', () => {
		expect(accountStatusMessage(account({ status: 'relogin_required' }))).toContain('再ログイン');
		expect(accountStatusMessage(account({ status: 'no_credentials' }))).toContain('再ログイン');
	});

	it('PC から届いた詳細があればそれを出す', () => {
		expect(accountStatusMessage(account({ status: 'error', statusDetail: 'detail' }))).toBe('detail');
	});
});

describe('SSH の接続先の Claude のログイン', () => {
	const host = { label: 'devbox' };

	it('使用中の代わりにどの接続先のログインかを書く', () => {
		expect({
			hint: accountHint(account({ email: 'a@example.com' }), host),
			unknownHostHint: accountHint(account(), {}),
			localActiveHint: accountHint(account({ active: true }), undefined),
		}).toEqual({
			hint: '接続先 devbox でログイン中',
			unknownHostHint: '接続先でログイン中',
			localActiveHint: '使用中',
		});
	});

	it('直し方は PC の Para Code ではなく接続先を案内し、ログインが無い・取れないは中立に書く', () => {
		const messages = {
			refreshing: accountHint(account({ status: 'refreshing' }), host),
			relogin: accountHint(account({ status: 'relogin_required' }), host),
			notLoggedIn: accountHint(account({ status: 'unavailable', unavailableReason: 'host_not_logged_in' }), host),
			fetchFailed: accountHint(account({ status: 'unavailable', unavailableReason: 'host_fetch_failed', statusDetail: 'could not reach the usage API' }), host),
			keychain: accountHint(account({ status: 'unavailable', unavailableReason: 'keychain_unavailable' }), host),
			rateLimited: accountHint(account({ status: 'unavailable', unavailableReason: 'rate_limited' }), host),
		};
		expect(messages).toEqual({
			refreshing: 'アクセストークンの期限が切れています。接続先で claude を起動すると Claude Code が更新し、表示が戻ります',
			relogin: '接続先のターミナルで claude を起動し、/login でログインし直してください',
			notLoggedIn: '接続先に Claude のサブスクリプションのログインが見つかりません。接続先で使うときは、接続先のターミナルで claude を起動し /login でログインすると表示されます（API キーで使っている場合は表示できません）',
			fetchFailed: '接続先から使用量を取得できていません（could not reach the usage API）。しばらくしてから取り直します',
			keychain: '接続先では Claude のログインが macOS のキーチェーンに保存されているため、SSH 越しには読み取れません',
			rateLimited: '使用状況を一時的に取得できていません（上限に達したアカウントは、リセットまで取得を止めます）',
		});
		expect(Object.values(messages).some(message => message?.includes('PC の Para Code'))).toBe(false);
	});

	it('画面の下の注記も接続先のログインに合わせる（古い PC は印を付けないので従来の文言）', () => {
		expect(usageFootNote({ accounts: [], remoteHost: host })).toContain('接続先のターミナル');
		expect(usageFootNote({ accounts: [] })).toBe('アカウントの追加や再ログインは、PC の Para Code から行います。');
		expect(usageFootNote(undefined)).toBe('アカウントの追加や再ログインは、PC の Para Code から行います。');
	});
});

describe('providerEmptyMessage', () => {
	it('cswap が無いことを先に伝える', () => {
		expect(providerEmptyMessage({ accounts: [], cswapMissing: true, sourceError: 'x' })).toContain('cswap');
		expect(providerEmptyMessage({ accounts: [], sourceError: 'x' })).toBe('x');
		expect(providerEmptyMessage({ accounts: [] })).toBe('アカウントが見つかりません');
	});
});

describe('formatUsd / ratioPercent', () => {
	it('ドルは小数2桁', () => {
		expect(formatUsd(4.8231)).toBe('$4.82');
		expect(formatUsd(0)).toBe('$0.00');
	});

	it('上限が取れていなければ undefined、範囲外は丸める', () => {
		expect(ratioPercent(23, 100)).toBe(23);
		expect(ratioPercent(150, 100)).toBe(100);
		expect(ratioPercent(1, 0)).toBeUndefined();
	});
});
