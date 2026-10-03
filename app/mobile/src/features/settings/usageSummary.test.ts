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
	resetCreditRows,
	resetCreditsFacts,
	resetCreditsSummary,
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

	it('取得していない理由（PC が statusDetail に入れる）で説明を出し分け、「上限に達した」とは書かない', () => {
		const notFetched = (statusDetail?: string) => accountStatusMessage(account({ status: 'unavailable', unavailableReason: 'not_fetched', ...(statusDetail !== undefined ? { statusDetail } : {}) })) ?? '';
		expect([notFetched('shared with claude-swap'), notFetched('same lineage as the current login'), notFetched()].map(message => [
			message.includes('claude-swap'), message.includes('Claude Code に任せて'), message.includes('まだ取得していません'), message.includes('上限に達した'),
		])).toEqual([[true, false, false, false], [false, true, false, false], [false, false, true, false]]);
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
			rateLimited: '使用状況の取得回数が上限に達したため、しばらく待ってから取り直します',
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

describe('リセットの残りと期限', () => {
	const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

	it('メーターの下の1行は、次に切れる期限を今日・明日なら言葉で書く', () => {
		expect([
			resetCreditsSummary({ availableCount: 4, credits: [{ expiresAt: at(10, 11, 9) }, { expiresAt: at(9, 26, 11, 12) }, {}, { expiresAt: at(10, 25, 18, 30) }] }, NOW),
			resetCreditsSummary({ availableCount: 2, nextExpiresAt: at(9, 27, 8) }, NOW),
			resetCreditsSummary({ availableCount: 1, credits: [{ expiresAt: at(10, 20, 21, 45) }] }, NOW),
			resetCreditsSummary({ availableCount: 1, credits: [{}] }, NOW),
			resetCreditsSummary({ availableCount: 3 }, NOW),
			resetCreditsSummary({ availableCount: 0, credits: [] }, NOW),
		]).toEqual([
			{ text: 'リセット 残り 4 回 · 次は今日 11:12 に期限', listable: true, soon: true },
			// 明細の無い古い PC は最も早い期限だけ。一覧は開けない
			{ text: 'リセット 残り 2 回 · 次は明日 08:00 に期限', listable: false, soon: true },
			{ text: 'リセット 残り 1 回 · 10/20 21:45 に期限', listable: false, soon: false },
			{ text: 'リセット 残り 1 回 · 期限なし', listable: false, soon: false },
			{ text: 'リセット 残り 3 回', listable: false, soon: false },
			{ text: 'リセット 残りなし', listable: false, soon: false },
		]);
	});

	it('期限の一覧は早い順に並べ、明細の欠けは「期限は不明」で埋め、多すぎる明細は残り回数で切る', () => {
		expect({
			sorted: resetCreditRows({ availableCount: 3, credits: [{}, { expiresAt: at(10, 3, 9) }, { expiresAt: at(9, 26, 11, 12) }] }, NOW),
			fewer: resetCreditRows({ availableCount: 4, credits: [{ expiresAt: at(9, 30, 18, 30) }] }, NOW),
			noDetails: resetCreditRows({ availableCount: 2, nextExpiresAt: at(9, 27, 8) }, NOW),
			more: resetCreditRows({ availableCount: 1, credits: [{ expiresAt: at(9, 27, 8) }, { expiresAt: at(9, 25, 8) }] }, NOW),
		}).toEqual({
			sorted: [
				{ label: '9/26 11:12 まで', relative: '今日', soon: true },
				{ label: '10/3 09:00 まで', relative: '7日後', soon: false },
				{ label: '期限なし', soon: false },
			],
			fewer: [{ label: '9/30 18:30 まで', relative: '4日後', soon: false }, { label: 'ほか 3 回（期限は不明）', soon: false }],
			noDetails: [{ label: '2 回（期限は不明）', soon: false }],
			more: [{ label: '9/25 08:00 まで', relative: '期限切れ', soon: true }],
		});
	});
});

describe('リセットの1行の決まり（PC と同じ表）', () => {
	// アプリの usageSummary.test.ts と PC の paradisCodexAccounts.test.ts で同じ表（変えるときは両方を直す）。
	// 時刻は [月, 日, 時, 分]（端末の時刻）で、今は 2026-10-04 09:00。credits の null は期限の無いもの。
	interface IResetSummaryRow {
		readonly name: string;
		readonly availableCount: number;
		readonly nextExpiresAt?: readonly number[];
		readonly credits?: readonly (readonly number[] | null)[];
		readonly expected: { readonly count: number; readonly listable: boolean; readonly next?: readonly number[]; readonly nextDayOffset?: number; readonly hasNoExpiry: boolean };
	}
	const RESET_SUMMARY_TABLE: readonly IResetSummaryRow[] = [
		{ name: '残り 4 回・先頭は今日', availableCount: 4, credits: [[10, 11, 9, 0], [10, 4, 11, 12], null, [10, 25, 18, 30]], expected: { count: 4, listable: true, next: [10, 4, 11, 12], nextDayOffset: 0, hasNoExpiry: true } },
		{ name: '残り 2 回・明細なし（古い PC）', availableCount: 2, nextExpiresAt: [10, 5, 8, 0], expected: { count: 2, listable: false, next: [10, 5, 8, 0], nextDayOffset: 1, hasNoExpiry: false } },
		{ name: '残り 1 回・期限あり', availableCount: 1, credits: [[10, 20, 21, 45]], expected: { count: 1, listable: false, next: [10, 20, 21, 45], nextDayOffset: 16, hasNoExpiry: false } },
		{ name: '残り 1 回・期限なし', availableCount: 1, credits: [null], expected: { count: 1, listable: false, hasNoExpiry: true } },
		{ name: '残り 3 回・明細が足りない', availableCount: 3, credits: [[10, 9, 8, 0]], expected: { count: 3, listable: true, next: [10, 9, 8, 0], nextDayOffset: 5, hasNoExpiry: false } },
		{ name: '残り 2 回・すべて期限なし', availableCount: 2, credits: [null, null], expected: { count: 2, listable: true, hasNoExpiry: true } },
		{ name: '残りなし', availableCount: 0, credits: [], expected: { count: 0, listable: false, hasNoExpiry: false } },
	];
	const tableNow = new Date(2026, 9, 4, 9, 0).getTime();
	const tableAt = (time: readonly number[]) => new Date(2026, time[0]! - 1, time[1]!, time[2]!, time[3]!).getTime();
	const tableExpected = RESET_SUMMARY_TABLE.map(row => ({
		name: row.name,
		count: row.expected.count,
		listable: row.expected.listable,
		...(row.expected.next !== undefined ? { nextExpiresAt: tableAt(row.expected.next), nextDayOffset: row.expected.nextDayOffset } : {}),
		hasNoExpiry: row.expected.hasNoExpiry,
	}));

	it('PC の paradisCodexResetSummary と同じ表で同じ結果になる', () => {
		const actual = RESET_SUMMARY_TABLE.map(row => ({
			name: row.name,
			...resetCreditsFacts({
				availableCount: row.availableCount,
				...(row.nextExpiresAt !== undefined ? { nextExpiresAt: tableAt(row.nextExpiresAt) } : {}),
				...(row.credits !== undefined ? { credits: row.credits.map(time => (time !== null ? { expiresAt: tableAt(time) } : {})) } : {}),
			}, tableNow),
		}));
		expect(actual).toEqual(tableExpected);
	});
});
