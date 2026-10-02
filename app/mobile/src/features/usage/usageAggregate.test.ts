// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

// usageFormat → time.ts がフックのために react-native を読む（vitest は Flow 構文を読めない）。純関数だけを使うので差し替える。
vi.mock('../../hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
import { PcReplyError, type GithubUsageResult, type RateLimitAccount, type RateLimitsResult, type RtkSavingsResult, type UsageDashboardResult } from '../../store.js';
import {
	accountFetchedAt,
	accountMergeKey,
	aggregateAccounts,
	aggregateGithubAccounts,
	buildUsageEntries,
	entryKindLabel,
	entryTitle,
	homeAccounts,
	isNoResponseError,
	isOldValue,
	todayCostTotal,
	isWindowExpired,
	scopeCountLabel,
	USAGE_MACHINE_ID_CAPABILITY,
	widgetAccount,
	windowPercent,
	mergeGithub,
	mergeRtk,
	mergeUsageDashboards,
	summarizeCost,
	summarizeGithub,
	summarizeRtk,
	usageErrorText,
	type SourceUsageValues,
	type UsageEntry,
	type UsageSourceInfo,
} from './usageAggregate.js';
import { USAGE_CACHE_TTL_MS, openUsageRecord, parseUsageRecord, pruneUsageRecord, sealUsageRecord, usageRecordSignature } from './usageCache.js';
import { buildUsageSources, buildUsageTargets } from './usageSources.js';

const NOW = new Date(2026, 9, 3, 12, 0, 0).getTime();
const HOUR = 60 * 60_000;
const TODAY = '2026-10-03';
const YESTERDAY = '2026-10-02';

function pc(id: string, overrides: Partial<UsageSourceInfo> = {}): UsageSourceInfo {
	return { key: `pc:${id}`, kind: 'pc', pcId: id, pcName: id.toUpperCase(), online: true, ...overrides };
}

function ssh(pcId: string, hostId: string, overrides: Partial<UsageSourceInfo> = {}): UsageSourceInfo {
	return { key: `ssh:${pcId}:${hostId}`, kind: 'ssh', pcId, pcName: pcId.toUpperCase(), hostLabel: hostId, online: true, ...overrides };
}

function account(overrides: Partial<RateLimitAccount> = {}): RateLimitAccount {
	return { provider: 'claude', id: 'local-id', status: 'ok', ...overrides };
}

function limits(claude: RateLimitAccount[], codex: RateLimitAccount[] = [], extra: Partial<RateLimitsResult> = {}): RateLimitsResult {
	return { claude: { accounts: claude }, codex: { accounts: codex }, fetchedAt: NOW, ...extra };
}

function dashboard(days: { date: string; cost: number; model?: string; agent?: 'claude' | 'codex' }[], extra: Partial<UsageDashboardResult> = {}): UsageDashboardResult {
	return {
		days: days.map(day => ({
			date: day.date,
			models: [{ model: day.model ?? 'sonnet', agent: day.agent ?? 'claude', cost: day.cost, inputTokens: 10, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }],
		})),
		sessions: [],
		projects: [],
		failedReports: [],
		fetchedAt: NOW,
		...extra,
	};
}

function rtk(days: { date: string; saved: number }[], total: number, extra: Partial<RtkSavingsResult> = {}): RtkSavingsResult {
	return {
		days: days.map(day => ({ date: day.date, commands: 1, inputTokens: day.saved * 2, savedTokens: day.saved })),
		totals: { commands: days.length, inputTokens: total * 2, savedTokens: total },
		commands: [],
		history: [],
		failedReports: [],
		fetchedAt: NOW,
		...extra,
	};
}

const COUNTS = { calls: 0, failures: 0, rateLimited: 0, avgDurationMs: 0, maxDurationMs: 0 };

function github(overrides: Partial<GithubUsageResult> = {}): GithubUsageResult {
	return {
		generatedAt: NOW,
		sessionStartedAt: NOW - HOUR,
		ghAvailable: true,
		rateLimits: [{ resource: 'core', limit: 5000, used: 100, remaining: 4900, resetAt: NOW + HOUR }],
		consumption: [],
		operations: [],
		spaces: [],
		totals: { sessionCalls: 10, sessionFailures: 1, rolling5mCalls: 2, rolling5mFailures: 0, rolling5mRateLimited: 0 },
		lastErrors: [],
		...overrides,
	};
}

function entries(sources: UsageSourceInfo[], values: Record<string, SourceUsageValues>): UsageEntry[] {
	return buildUsageEntries(sources, values);
}

describe('buildUsageEntries', () => {
	it('同じ機械の SSH の接続先はペアリング済みの PC にまとめ、ハッシュの無い出どころは別の機械にする', () => {
		const result = entries(
			[pc('a', { machineIdHash: 'm-a' }), pc('b'), ssh('b', 'server', { machineIdHash: 'm-s' }), ssh('b', 'mac-a', { machineIdHash: 'm-a' }), ssh('a', 'unknown')],
			{},
		);
		expect(result.map(entry => ({ key: entry.key, title: entryTitle(entry), kind: entryKindLabel(entry), sources: entry.sourceKeys }))).toEqual([
			{ key: 'pc:a', title: 'A（SSH でも接続中）', kind: undefined, sources: ['pc:a', 'ssh:b:mac-a'] },
			{ key: 'pc:b', title: 'B', kind: undefined, sources: ['pc:b'] },
			{ key: 'ssh:b:server', title: 'server', kind: 'B から SSH', sources: ['ssh:b:server'] },
			{ key: 'ssh:a:unknown', title: 'unknown', kind: 'A から SSH', sources: ['ssh:a:unknown'] },
		]);
	});

	it('2台の PC から同じ接続先へ繋いでいれば1つにまとめ、どの PC から繋いでいるかを並べる', () => {
		const result = entries([pc('a'), pc('b'), ssh('a', 'srv', { machineIdHash: 'm-s' }), ssh('b', 'srv', { machineIdHash: 'm-s' })], {
			'ssh:a:srv': { rtk: { value: rtk([], 1), at: NOW - HOUR, receivedAt: NOW } },
			'ssh:b:srv': { rtk: { value: rtk([], 2), at: NOW, receivedAt: NOW } },
		});
		expect(result).toHaveLength(3);
		expect(entryKindLabel(result[2]!)).toBe('A・B から SSH');
		// 指標ごとに新しい方を採る
		expect(result[2]!.values.rtk?.value.totals.savedTokens).toBe(2);
	});

	it('PC がオフラインでも、同じ機械の SSH が繋がっていればオンラインとして新しい値を採る', () => {
		const [entry] = entries([pc('a', { online: false, machineIdHash: 'm' }), ssh('b', 'a-host', { machineIdHash: 'm' })], {
			'pc:a': { cost: { value: dashboard([{ date: TODAY, cost: 1 }]), at: NOW - 3 * HOUR, receivedAt: NOW } },
			'ssh:b:a-host': { cost: { value: dashboard([{ date: TODAY, cost: 2 }]), at: NOW, receivedAt: NOW } },
		});
		expect(entry!.online).toBe(true);
		expect(entry!.values.cost?.at).toBe(NOW);
	});
});

describe('accountMergeKey', () => {
	it('Claude はメール（大文字小文字を区別しない）と組織名、Codex は accountId を優先しメールに落とす', () => {
		expect([
			accountMergeKey(account({ email: 'User@Example.com' }), 'pc:a'),
			accountMergeKey(account({ email: 'user@example.com', organizationName: 'Acme' }), 'pc:a'),
			accountMergeKey(account({ provider: 'codex', email: 'user@example.com', accountId: 'acct-1' }), 'pc:a'),
			accountMergeKey(account({ provider: 'codex', email: 'user@example.com' }), 'pc:a'),
			accountMergeKey(account({ provider: 'codex', id: '/home/x/.codex' }), 'pc:a'),
		]).toEqual([
			'claude|email:user@example.com|org:',
			'claude|email:user@example.com|org:Acme',
			'codex|id:acct-1',
			// accountId が無い Codex は束ねない（同じメールで別のワークスペースを持つ人を潰さない）
			'codex|source:pc:a|local-id',
			'codex|source:pc:a|/home/x/.codex',
		]);
	});
});

describe('aggregateAccounts', () => {
	it('同じアカウントは足さずに1つにし、値の取れた新しい方を採って、見えている PC をチップで添える', () => {
		const result = entries([pc('a'), pc('b'), pc('c', { online: false })], {
			'pc:a': { limits: { value: limits([account({ email: 'u@x', fiveHour: { usedPercent: 10 } })]), at: NOW - HOUR, receivedAt: NOW } },
			'pc:b': { limits: { value: limits([account({ email: 'u@x', fiveHour: { usedPercent: 30 } }), account({ id: 'k', status: 'unavailable', unavailableReason: 'api_key' })]), at: NOW, receivedAt: NOW } },
			'pc:c': { limits: { value: limits([account({ email: 'u@x', fiveHour: { usedPercent: 99 } })]), at: NOW + HOUR, receivedAt: NOW } },
		});
		const claude = aggregateAccounts(result, 'claude', NOW);
		expect(claude.map(item => ({ key: item.key, used: item.account.fiveHour?.usedPercent, old: item.old, chips: item.seenOn }))).toEqual([
			{
				key: 'claude|email:u@x|org:',
				// オフラインの PC の値は新しくても採らない
				used: 30,
				old: false,
				chips: [{ key: 'pc:a', label: 'A', old: false }, { key: 'pc:b', label: 'B', old: false }, { key: 'pc:c', label: 'C', old: true }],
			},
			{ key: 'claude|source:pc:b|k', used: undefined, old: false, chips: [{ key: 'pc:b', label: 'B', old: false }] },
		]);
	});

	it('値の取れたアカウントを、取れていないものより先に採る。接続先にログインの無いものは数えない', () => {
		const result = entries([pc('a'), ssh('a', 'srv')], {
			'pc:a': { limits: { value: limits([account({ email: 'u@x', status: 'error' })]), at: NOW, receivedAt: NOW } },
			'ssh:a:srv': {
				limits: {
					value: { claude: { accounts: [account({ email: 'u@x', fiveHour: { usedPercent: 5 } }), account({ id: 'none', status: 'unavailable', unavailableReason: 'host_not_logged_in' })], remoteHost: { label: 'srv' } }, codex: { accounts: [] }, fetchedAt: NOW - HOUR },
					at: NOW - HOUR,
				},
			},
		});
		const claude = aggregateAccounts(result, 'claude', NOW);
		expect(claude).toHaveLength(1);
		expect(claude[0]!.account.status).toBe('ok');
		expect(claude[0]!.remoteHost).toEqual({ label: 'srv' });
	});

	it('新しさはアカウントごとの取得時刻で比べ、無ければ応答の時刻を使う', () => {
		const result = entries([pc('a'), pc('b'), pc('c')], {
			// 応答は新しいが、このアカウントの値は古い
			'pc:a': { limits: { value: limits([account({ email: 'u@x', fetchedAt: NOW - 5 * HOUR, fiveHour: { usedPercent: 1 } })]), at: NOW, receivedAt: NOW } },
			'pc:b': { limits: { value: limits([account({ email: 'u@x', fetchedAt: NOW - HOUR, fiveHour: { usedPercent: 2 } })]), at: NOW - 2 * HOUR, receivedAt: NOW } },
			// アカウントの時刻が無いので応答の時刻（b より古い）
			'pc:c': { limits: { value: limits([account({ email: 'u@x', fiveHour: { usedPercent: 3 } })]), at: NOW - 3 * HOUR, receivedAt: NOW } },
		});
		const [item] = aggregateAccounts(result, 'claude', NOW);
		expect([item!.account.fiveHour?.usedPercent, item!.at]).toEqual([2, NOW - HOUR]);
		expect(accountFetchedAt(account({ fetchedAt: Number.NaN }), 7)).toBe(7);
	});

	it('PC が前回の値を返した（stale）ものは古い値として扱う', () => {
		const result = entries([pc('a')], { 'pc:a': { limits: { value: limits([account({ email: 'u@x' })], [], { stale: true }), at: NOW, receivedAt: NOW } } });
		expect(aggregateAccounts(result, 'claude', NOW)[0]!.old).toBe(true);
	});
});

describe('homeAccounts', () => {
	it('値の取れたものを、使用中 → 5時間の使用率の高い順に並べ、1つも無ければ先頭だけ出す', () => {
		const make = (email: string, used: number | undefined, extra: Partial<RateLimitAccount> = {}) => ({
			key: email, provider: 'claude' as const, at: NOW, old: false, remoteHost: undefined, seenOn: [],
			account: account({ email, ...(used !== undefined ? { fiveHour: { usedPercent: used } } : {}), ...extra }),
		});
		expect(homeAccounts([make('a', 10), make('b', 50), make('c', 5, { active: true }), make('d', 80, { status: 'error' })], NOW).map(item => item.key)).toEqual(['c', 'b', 'a']);
		expect(homeAccounts([make('x', undefined, { status: 'error' }), make('y', undefined, { status: 'error' })], NOW).map(item => item.key)).toEqual(['x']);
	});

	it('リセット時刻を過ぎた枠の使用率は並べ替えに使わない', () => {
		const make = (email: string, used: number, resetsAt: number) => ({
			key: email, provider: 'claude' as const, at: NOW, old: false, remoteHost: undefined, seenOn: [],
			account: account({ email, fiveHour: { usedPercent: used, resetsAt } }),
		});
		expect(homeAccounts([make('expired', 99, NOW - 1), make('live', 10, NOW + HOUR)], NOW).map(item => item.key)).toEqual(['live', 'expired']);
	});
});

describe('期限切れの枠とウィジェットのアカウント', () => {
	it('リセット時刻を過ぎた枠は使用率を未確定にし、古い値・期限切れの枠はウィジェットで選ばない', () => {
		expect([
			windowPercent({ usedPercent: 50, resetsAt: NOW - 1 }, NOW),
			windowPercent({ usedPercent: 50, resetsAt: NOW + 1 }, NOW),
			windowPercent({ usedPercent: 50 }, NOW),
			isWindowExpired({ usedPercent: 1, resetsAt: NOW }, NOW),
		]).toEqual([undefined, 50, 50, true]);
		const make = (key: string, used: number, resetsAt: number, old: boolean) => ({
			key, provider: 'claude' as const, at: NOW, old, remoteHost: undefined, seenOn: [],
			account: account({ email: key, fiveHour: { usedPercent: used, resetsAt } }),
		});
		expect(widgetAccount([make('old', 90, NOW + HOUR, true), make('expired', 80, NOW - 1, false), make('live', 20, NOW + HOUR, false)], NOW)?.email).toBe('live');
		expect(widgetAccount([make('old', 90, NOW + HOUR, true)], NOW)).toBeUndefined();
	});

	it('受け取ってから 15 分を過ぎた値（取りに行かない出どころの保存済みの値）は、オンラインでも古い値として選ばない', () => {
		const limitsOf = (email: string, used: number) => ({ claude: { accounts: [account({ email, fiveHour: { usedPercent: used, resetsAt: NOW + HOUR } })] }, codex: { accounts: [] }, fetchedAt: NOW });
		const result = entries([pc('a'), ssh('a', 'srv')], {
			'pc:a': { limits: { value: limitsOf('pc@x', 10), at: NOW - HOUR, receivedAt: NOW - 14 * 60_000 } },
			'ssh:a:srv': { limits: { value: limitsOf('srv@x', 90), at: NOW - HOUR, receivedAt: NOW - 16 * 60_000 } },
		});
		const claude = aggregateAccounts(result, 'claude', NOW);
		expect(claude.map(item => [item.account.email, item.old])).toEqual([['pc@x', false], ['srv@x', true]]);
		expect(widgetAccount(claude, NOW)?.email).toBe('pc@x');
		// 受け取った時刻が無い（古い版の控え）なら、PC の取得時刻で測る
		expect(isOldValue(result[1]!, { value: {}, at: NOW - 16 * 60_000 }, NOW)).toBe(true);
	});

	it('今日のコストだけの軽い合計は、今日取れた出どころだけを足す', () => {
		const result = entries([pc('a'), pc('b'), pc('c')], {
			'pc:a': { cost: { value: dashboard([{ date: TODAY, cost: 1.5 }]), at: NOW, receivedAt: NOW } },
			'pc:b': { cost: { value: dashboard([{ date: YESTERDAY, cost: 3 }]), at: NOW, receivedAt: NOW } },
			'pc:c': { cost: { value: dashboard([{ date: YESTERDAY, cost: 7 }]), at: NOW - 20 * HOUR, receivedAt: NOW } },
		});
		expect([todayCostTotal(result, NOW), todayCostTotal(entries([pc('a')], {}), NOW)]).toEqual([1.5, undefined]);
		expect(todayCostTotal(result, NOW)).toBe(summarizeCost(result, NOW).today);
	});

	it('出どころの数を「PC N 台・接続先 M」で書く', () => {
		expect([
			scopeCountLabel(entries([pc('a'), pc('b'), ssh('a', 'srv')], {})),
			scopeCountLabel(entries([pc('a'), pc('b')], {})),
		]).toEqual(['PC 2 台・接続先 1', 'PC 2 台']);
	});
});

describe('summarizeCost', () => {
	it('今日のコストは今日取れた分だけを足し、今日まだ取れていない PC を書き出す', () => {
		const result = entries([pc('a'), pc('b'), pc('c', { online: false })], {
			'pc:a': { cost: { value: dashboard([{ date: YESTERDAY, cost: 2 }, { date: TODAY, cost: 1.5 }]), at: NOW, receivedAt: NOW } },
			'pc:b': { cost: { value: dashboard([{ date: TODAY, cost: 0.5, agent: 'codex' }]), at: NOW - HOUR, receivedAt: NOW } },
			'pc:c': { cost: { value: dashboard([{ date: YESTERDAY, cost: 7 }]), at: NOW - 20 * HOUR, receivedAt: NOW } },
		});
		const summary = summarizeCost(result, NOW);
		expect({ today: summary.today, missing: summary.missingToday, rows: summary.rows.map(row => [row.label, row.today, row.old]) }).toEqual({
			today: 2,
			missing: ['C'],
			rows: [['A', 1.5, false], ['B', 0.5, false], ['C', undefined, true]],
		});
		// 合計のダッシュボードには古い PC の昨日までの値も入る
		expect(summary.merged?.days.map(day => [day.date, day.models.reduce((sum, model) => sum + model.cost, 0)])).toEqual([[YESTERDAY, 9], [TODAY, 2]]);
		expect(summarizeCost(result, NOW, 'codex').today).toBe(0.5);
	});

	it('どの PC からも取れていなければ今日のコストは undefined', () => {
		expect(summarizeCost(entries([pc('a')], {}), NOW).today).toBeUndefined();
	});
});

describe('mergeUsageDashboards', () => {
	it('日付とモデルで足し、プロジェクトは名前で、セッションは新しい順にし、昨日以前に取った値の今日の行は入れない', () => {
		const a = dashboard([{ date: TODAY, cost: 1, model: 'opus' }], {
			projects: [{ name: 'app', rawName: '/a/app', dailyCosts: [{ date: YESTERDAY, cost: 1 }] }],
			sessions: [{ project: 'app', rawProject: '/a/app', lastActivity: NOW - HOUR, models: ['opus'], totalTokens: 1, totalCost: 1 }],
			block: { startTime: NOW - HOUR, endTime: NOW + HOUR, costUSD: 1, costPerHour: 1 },
			failedReports: ['daily'],
		});
		const b = dashboard([{ date: TODAY, cost: 2, model: 'opus' }, { date: YESTERDAY, cost: 3, model: 'gpt', agent: 'codex' }], {
			projects: [{ name: 'app', rawName: '/b/app', dailyCosts: [{ date: YESTERDAY, cost: 2 }, { date: TODAY, cost: 5 }] }],
			sessions: [{ project: 'app', rawProject: '/b/app', lastActivity: NOW, models: ['gpt'], totalTokens: 1, totalCost: 2 }],
			block: { startTime: NOW - 6 * HOUR, endTime: NOW - HOUR, costUSD: 9 },
			failedReports: ['daily'],
		});
		const merged = mergeUsageDashboards([{ value: a, at: NOW, receivedAt: NOW }, { value: b, at: NOW - 24 * HOUR, receivedAt: NOW }], NOW)!;
		expect({
			days: merged.days.map(day => [day.date, day.models.map(model => [model.model, model.cost, model.inputTokens])]),
			projects: merged.projects,
			sessions: merged.sessions.map(session => session.rawProject),
			block: merged.block,
			failed: merged.failedReports,
			fetchedAt: merged.fetchedAt,
		}).toEqual({
			days: [[YESTERDAY, [['gpt', 3, 10]]], [TODAY, [['opus', 1, 10]]]],
			projects: [{ name: 'app', rawName: '/a/app', dailyCosts: [{ date: YESTERDAY, cost: 3 }] }],
			sessions: ['/b/app', '/a/app'],
			block: { startTime: NOW - HOUR, endTime: NOW + HOUR, costUSD: 1, costPerHour: 1 },
			failed: ['daily'],
			fetchedAt: NOW - 24 * HOUR,
		});
		expect(mergeUsageDashboards([], NOW)).toBeUndefined();
	});
});

describe('RTK', () => {
	it('日別・累計を足し、コマンドは名前で束ねて回数で重み付けし、直近のコマンドに出どころを添える', () => {
		const a = rtk([{ date: TODAY, saved: 100 }], 1000, { commands: [{ command: 'git status', count: 1, savedTokens: 10, avgSavingsPct: 90 }], history: [{ timestampLabel: '10-03 09:00', command: 'ls', savingsPct: 50, tokens: 5 }] });
		const b = rtk([{ date: TODAY, saved: 50 }, { date: YESTERDAY, saved: 20 }], 500, { commands: [{ command: 'git status', count: 3, savedTokens: 30, avgSavingsPct: 50 }, { command: 'cargo', count: 1, savedTokens: 100, avgSavingsPct: 80 }] });
		const merged = mergeRtk([{ label: 'A', value: a, at: NOW }, { label: 'B', value: b, at: NOW }])!;
		expect({ days: merged.days, totals: merged.totals, commands: merged.commands, history: merged.history.map(entry => entry.timestampLabel) }).toEqual({
			days: [{ date: YESTERDAY, commands: 1, inputTokens: 40, savedTokens: 20 }, { date: TODAY, commands: 2, inputTokens: 300, savedTokens: 150 }],
			totals: { commands: 3, inputTokens: 3000, savedTokens: 1500 },
			commands: [{ command: 'cargo', count: 1, savedTokens: 100, avgSavingsPct: 80 }, { command: 'git status', count: 4, savedTokens: 40, avgSavingsPct: 60 }],
			history: ['A · 10-03 09:00'],
		});
		const summary = summarizeRtk(entries([pc('a'), pc('b', { online: false })], { 'pc:a': { rtk: { value: a, at: NOW, receivedAt: NOW } } }), NOW);
		expect(summary.rows.map(row => [row.label, row.today, row.total])).toEqual([['A', 100, 1000], ['B', undefined, undefined]]);
		// 1つだけなら出どころを添えない
		expect(summary.merged?.history[0]?.timestampLabel).toBe('10-03 09:00');
	});
});

describe('GitHub', () => {
	it('レート枠は login で束ね、login の届かない古い PC は PC ごとに並べる。呼び出し件数は足す', () => {
		const op = (calls: number, avg: number) => ({ callSite: 'pr.list', resource: 'core' as const, session: { ...COUNTS, calls, avgDurationMs: avg, maxDurationMs: avg }, rolling5m: COUNTS, rolling1h: COUNTS });
		const result = entries([pc('a'), pc('b'), pc('c'), ssh('a', 'srv')], {
			'pc:a': { github: { value: github({ account: { login: 'octo' }, operations: [op(1, 100)] }), at: NOW - HOUR, receivedAt: NOW } },
			'pc:b': { github: { value: github({ account: { login: 'Octo' }, operations: [op(3, 200)], rateLimits: [{ resource: 'core', limit: 5000, used: 300, remaining: 4700, resetAt: NOW }] }), at: NOW, receivedAt: NOW } },
			'pc:c': { github: { value: github({ rateLimits: [] }), at: NOW, receivedAt: NOW } },
		});
		const summary = summarizeGithub(result, NOW);
		expect(summary.accounts.map(item => ({ key: item.key, label: item.label, used: item.rateLimits[0]?.used, chips: item.seenOn.map(chip => chip.key) }))).toEqual([
			{ key: 'login:octo', label: 'Octo', used: 300, chips: ['pc:a', 'pc:b'] },
			{ key: 'source:pc:c', label: 'C', used: undefined, chips: ['pc:c'] },
		]);
		expect(summary.merged?.operations).toEqual([{ ...op(4, 175), session: { ...COUNTS, calls: 4, avgDurationMs: 175, maxDurationMs: 200 } }]);
		expect(summary.merged?.totals.sessionCalls).toBe(30);
		expect(summary.merged?.rateLimits).toEqual([]);
		// SSH の接続先は GitHub の行に出さない
		expect(summary.rows.map(row => row.key)).toEqual(['pc:a', 'pc:b', 'pc:c']);
	});

	it('オフラインの PC の直近（5分・1時間）の呼び出しは合計に入れず、セッションの累計は入れる', () => {
		const counts = { ...COUNTS, calls: 5 };
		const op = { callSite: 'pr.list', resource: 'core' as const, session: counts, rolling5m: counts, rolling1h: counts };
		const result = entries([pc('a'), pc('b', { online: false })], {
			'pc:a': { github: { value: github({ operations: [op] }), at: NOW, receivedAt: NOW } },
			'pc:b': { github: { value: github({ operations: [op] }), at: NOW - HOUR, receivedAt: NOW } },
		});
		const summary = summarizeGithub(result, NOW);
		expect({
			session: summary.merged?.operations[0]?.session.calls,
			rolling5m: summary.merged?.operations[0]?.rolling5m.calls,
			rolling1h: summary.merged?.operations[0]?.rolling1h.calls,
			totals5m: summary.merged?.totals.rolling5mCalls,
			rows: summary.rows.map(row => row.rolling5mCalls),
		}).toEqual({ session: 10, rolling5m: 5, rolling1h: 5, totals5m: 2, rows: [2, undefined] });
	});

	it('レート枠の取れていない値より、取れている値を採る', () => {
		const result = entries([pc('a'), pc('b')], {
			'pc:a': { github: { value: github({ account: { login: 'o' } }), at: NOW - HOUR, receivedAt: NOW } },
			'pc:b': { github: { value: github({ account: { login: 'o' }, rateLimits: [], rateLimitError: 'x' }), at: NOW, receivedAt: NOW } },
		});
		expect(aggregateGithubAccounts(result, NOW)[0]!.rateLimits).toHaveLength(1);
		expect(mergeGithub([])).toBeUndefined();
	});

	it('空間（スペース）の割合は呼び出し件数で重み付けする', () => {
		const space = (calls: number, ratio: number) => ({ space: 's', session: { ...COUNTS, calls }, rolling5m: COUNTS, rolling1h: COUNTS, coreRatio: ratio, rolling5mCoreRatio: 0, rolling1hCoreRatio: 0 });
		const merged = mergeGithub([github({ spaces: [space(1, 1)] }), github({ spaces: [space(3, 0)] })])!;
		expect(merged.spaces[0]?.coreRatio).toBe(0.25);
	});
});

describe('取得の失敗', () => {
	it('時間切れはエラー文を出さず、前回の値を残していることを書く', () => {
		expect(isNoResponseError(new PcReplyError('timed out', 'no-response'))).toBe(true);
		expect(isNoResponseError(new Error('request timeout'))).toBe(true);
		expect(isNoResponseError(new Error('boom'))).toBe(false);
		expect(usageErrorText(new Error('request timeout'), true)).toBe('PC の集計に時間がかかっています。前回の値を表示しています');
		expect(usageErrorText(new PcReplyError('x', 'no-response'), false)).toBe('PC の集計に時間がかかっています。しばらくしてから取り直してください');
		expect(usageErrorText(new Error('boom'), true)).toBe('boom');
	});
});

describe('usageCache', () => {
	const KEY = new Uint8Array(32).fill(7);

	it('7日を過ぎた値を落とし、値が残らなければ出どころごと落とす', () => {
		const record = { kind: 'pc' as const, pcId: 'a', pcName: 'A', values: { cost: { value: dashboard([{ date: TODAY, cost: 1 }]), at: NOW - HOUR, receivedAt: NOW }, rtk: { value: rtk([], 1), at: NOW - USAGE_CACHE_TTL_MS - 1 } } };
		expect(Object.entries(pruneUsageRecord(record, NOW)!.values).filter(([, value]) => value !== undefined).map(([kind]) => kind)).toEqual(['cost']);
		expect(pruneUsageRecord({ ...record, values: { rtk: record.values.rtk } }, NOW)).toBeUndefined();
	});

	it('封緘して読み戻せる。PC の絶対パスは落とし、日別・直近の一覧は表示に要る範囲に切り詰める', () => {
		const sessions = Array.from({ length: 30 }, (_, index) => ({ project: 'p', rawProject: '/Users/example/p', models: [], totalTokens: index, totalCost: 0 }));
		const value = dashboard([{ date: '2026-01-01', cost: 9 }, { date: TODAY, cost: 1 }], {
			sessions,
			projects: [{ name: 'p', rawName: '/Users/example/p', dailyCosts: [{ date: '2026-01-01', cost: 9 }, { date: TODAY, cost: 1 }] }, { name: 'old', rawName: '/x', dailyCosts: [{ date: '2026-01-01', cost: 1 }] }],
		});
		const record = { kind: 'ssh' as const, pcId: 'a', pcName: 'A', hostLabel: 'srv', machineIdHash: 'm', values: { cost: { value, at: NOW, receivedAt: NOW } } };
		const sealed = sealUsageRecord(KEY, 'ssh:a:srv', record, NOW);
		expect(sealed.includes('Users')).toBe(false);
		const opened = openUsageRecord(KEY, sealed, 'a', NOW);
		const cost = opened?.record.values.cost?.value;
		expect({
			sourceKey: opened?.sourceKey,
			machineIdHash: opened?.record.machineIdHash,
			sessions: cost?.sessions.length,
			rawProject: cost?.sessions[0]?.rawProject,
			days: cost?.days.map(day => day.date),
			projects: cost?.projects,
		}).toEqual({
			sourceKey: 'ssh:a:srv',
			machineIdHash: 'm',
			sessions: 20,
			rawProject: '',
			days: [TODAY],
			projects: [{ name: 'p', rawName: '', dailyCosts: [{ date: TODAY, cost: 1 }] }],
		});
	});

	it('鍵が違う・別の PC のもの・壊れたものは開かない。取得時刻が同じなら書き直さない印になる', () => {
		const record = { kind: 'pc' as const, pcId: 'a', pcName: 'A', values: { limits: { value: limits([]), at: NOW, receivedAt: NOW } } };
		const sealed = sealUsageRecord(KEY, 'pc:a', record, NOW);
		expect([
			openUsageRecord(new Uint8Array(32).fill(8), sealed, 'a', NOW),
			openUsageRecord(KEY, sealed, 'b', NOW),
			openUsageRecord(KEY, 'broken', 'a', NOW),
			openUsageRecord(KEY, sealUsageRecord(KEY, 'pc:other', record, NOW), 'a', NOW),
			parseUsageRecord({ kind: 'pc', pcId: 'x', values: { cost: { at: NOW, value: { days: 'no' } } } }, NOW),
		]).toEqual([undefined, undefined, undefined, undefined, undefined]);
		expect(usageRecordSignature(record)).toBe(usageRecordSignature({ ...record, values: { limits: { value: limits([account()]), at: NOW, receivedAt: NOW } } }));
		expect(usageRecordSignature(record)).not.toBe(usageRecordSignature({ ...record, values: { limits: { value: limits([]), at: NOW + 1 } } }));
	});
});

describe('buildUsageTargets', () => {
	it('機械のハッシュを広告しない PC の接続先にはハッシュを持たせない（別の機械として扱う）', () => {
		const renderers = [
			{ windowId: 1, ready: true, host: { kind: 'local' as const, id: 'local', machineIdHash: 'm-pc' } },
			{ windowId: 2, ready: true, host: { kind: 'remote' as const, id: 'srv', label: 'srv', machineIdHash: 'm-srv' } },
		];
		const targets = buildUsageTargets([
			{ pcId: 'new', workspace: { capabilities: [USAGE_MACHINE_ID_CAPABILITY], renderers } },
			{ pcId: 'old', workspace: { renderers } },
			{ pcId: 'none', workspace: undefined },
		]);
		expect(targets.map(target => [target.pcId, target.localWindowId, target.remotes.map(host => host.machineIdHash)])).toEqual([
			['new', 1, ['m-srv']],
			['old', 1, [undefined]],
			['none', undefined, []],
		]);
	});
});

describe('buildUsageSources', () => {
	it('PC と、いま開いている SSH の接続先と、控えにだけある接続先をオフラインとして並べる。オフラインの PC の接続先もオフライン', () => {
		const { sources, routes } = buildUsageSources(
			[
				{ id: 'a', name: 'A', connection: 'online', pcOnline: true, machineIdHash: 'm' },
				{ id: 'b', name: 'B', connection: 'offline', pcOnline: false },
			],
			[
				{ pcId: 'a', localWindowId: 1, remotes: [{ id: 'srv', kind: 'remote', label: 'srv', windowId: 2, ready: true, machineIdHash: 'm-srv' }] },
				{ pcId: 'b', localWindowId: undefined, remotes: [{ id: 'x', kind: 'remote', label: 'x', windowId: 3, ready: true }] },
			],
			{ 'ssh:a:old': { kind: 'ssh', pcId: 'a', pcName: 'A', hostLabel: 'old', machineIdHash: 'm-old', values: {} } },
		);
		expect(sources.map(source => [source.key, source.online, source.machineIdHash])).toEqual([
			['pc:a', true, 'm'], ['ssh:a:srv', true, 'm-srv'], ['ssh:a:old', false, 'm-old'], ['pc:b', false, undefined], ['ssh:b:x', false, undefined],
		]);
		expect(routes.get('pc:a')).toEqual({ pcId: 'a', windowId: 1, remote: false });
		expect(routes.get('ssh:a:srv')).toEqual({ pcId: 'a', windowId: 2, remote: true });
	});
});
