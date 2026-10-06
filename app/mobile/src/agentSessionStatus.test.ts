// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { AgentMonitor } from './agentMonitors.js';
import type { AgentShell } from './agentShells.js';
import {
	cacheRowLabel,
	cacheTimeState,
	cacheTimeValue,
	contextValue,
	formatCacheRemaining,
	formatTokens,
	hitMissValue,
	localizeAgentSessionStatus,
	nextSessionRingChange,
	parseAgentSessionStatus,
	pullRequestValue,
	sessionRingModel,
	type AgentSessionStatus,
} from './agentSessionStatus.js';
import type { PrDetail } from './features/code/pullRequest.js';

const NOW = 1_760_000_000_000;

const claude: AgentSessionStatus = {
	agent: 'claude',
	cache: { requests: 20, hits: 17, misses: 2, expected: 0, cold: 1, hitRatio: 0.94, expiresAt: NOW + 39 * 60_000, ttlMs: 3_600_000 },
	context: { tokens: 142_800, window: 1_000_000, percent: 14, source: 'mod' },
};

function shell(id: string, status: AgentShell['status']): AgentShell {
	return { id, startedAt: NOW - 1_000, status };
}

function monitor(id: string, status: AgentMonitor['status']): AgentMonitor {
	return { id, startedAt: NOW - 1_000, status } as AgentMonitor;
}

describe('agentSessionStatus', () => {
	it('reads what the PC sends and drops what it cannot read', () => {
		expect([
			parseAgentSessionStatus({ ...claude, cache: { ...claude.cache, partial: true }, extra: 1 }),
			parseAgentSessionStatus({ agent: 'codex', cache: { requests: 3, hits: 1, misses: 0, expected: 1, cold: 1, hitRatio: 2 }, context: { window: 272_000, percent: 31.4 } }),
			parseAgentSessionStatus({ agent: 'claude', cache: { requests: 'x' }, context: { window: 0, percent: 3 } }),
			parseAgentSessionStatus({ agent: 'gemini' }),
			parseAgentSessionStatus(undefined),
		]).toEqual([
			{ ...claude, cache: { ...claude.cache, partial: true } },
			{ agent: 'codex', cache: { requests: 3, hits: 1, misses: 0, expected: 1, cold: 1 }, context: { window: 272_000, percent: 31, source: 'transcript' } },
			{ agent: 'claude' },
			undefined,
			undefined,
		]);
	});

	it('moves the expiry onto the phone clock by the difference from the send time', () => {
		expect(localizeAgentSessionStatus(claude, NOW - 5_000, NOW).cache?.expiresAt).toBe(NOW + 39 * 60_000 + 5_000);
		expect(localizeAgentSessionStatus(claude, undefined, NOW)).toBe(claude);
	});

	it('the ring: gray normally, the arc turns yellow at 70% and red at 90%, the dot warns about the cache, the number counts what runs', () => {
		const at = (percent: number): AgentSessionStatus => ({ ...claude, context: { tokens: 142_800, window: 1_000_000, percent, source: 'mod' } });
		expect([
			sessionRingModel(claude, undefined, undefined, NOW, false),
			sessionRingModel(at(70), undefined, undefined, NOW, false).arcTone,
			sessionRingModel(at(92), undefined, undefined, NOW, false).arcTone,
			sessionRingModel(claude, undefined, undefined, NOW + 39 * 60_000 - 30_000, false).dot,
			sessionRingModel(claude, undefined, undefined, NOW + 40 * 60_000, false).dot,
			// 応答中はキャッシュを使っている（点を出さない）
			sessionRingModel(claude, undefined, undefined, NOW + 40 * 60_000, true).dot,
			sessionRingModel(claude, [monitor('m1', 'running'), monitor('m2', 'completed')], [shell('b1', 'running'), shell('b2', 'running'), shell('b3', 'failed')], NOW, false).running,
			sessionRingModel(undefined, undefined, undefined, NOW, false),
		]).toEqual([
			{ percent: 14, arcTone: 'idle', dot: undefined, running: 0, accessibilityLabel: 'セッションの状態。コンテキスト 14%、キャッシュの残り 39分。押すと開きます' },
			'warn',
			'danger',
			'warn',
			'danger',
			undefined,
			3,
			{ percent: 0, arcTone: 'idle', dot: undefined, running: 0, accessibilityLabel: 'セッションの状態。押すと開きます' },
		]);
	});

	it('wakes the ring when the cache comes close to its end and when it ends', () => {
		expect([
			nextSessionRingChange(claude, NOW, false),
			nextSessionRingChange(claude, NOW + 39 * 60_000 - 10_000, false),
			nextSessionRingChange(claude, NOW + 40 * 60_000, false),
			nextSessionRingChange(claude, NOW, true),
		]).toEqual([NOW + 38 * 60_000, NOW + 39 * 60_000, undefined, undefined]);
	});

	it('the sheet rows: cache time, hit / miss, context, and gray reasons where nothing can be shown', () => {
		const codex: AgentSessionStatus = { agent: 'codex', cache: { requests: 3, hits: 1, misses: 1, expected: 0, cold: 1, hitRatio: 0.5 }, context: { tokens: 84_000, window: 272_000, percent: 31, source: 'transcript' } };
		expect({
			labels: [cacheRowLabel(claude), cacheRowLabel({ agent: 'claude', cache: { requests: 1, hits: 0, misses: 0, expected: 0, cold: 1, expiresAt: NOW, ttlMs: 300_000 } }), cacheRowLabel(codex)],
			times: [
				cacheTimeValue(cacheTimeState(claude, NOW, false)),
				cacheTimeValue(cacheTimeState(claude, NOW + 39 * 60_000 - 48_000, false)),
				cacheTimeValue(cacheTimeState(claude, NOW + 40 * 60_000, false)),
				cacheTimeValue(cacheTimeState(claude, NOW, true)),
				cacheTimeValue(cacheTimeState(codex, NOW, false)),
				cacheTimeValue(cacheTimeState({ agent: 'claude' }, NOW, false)),
			],
			hitMiss: [hitMissValue(claude), hitMissValue({ agent: 'codex', cache: { requests: 3, hits: 1, misses: 1, expected: 0, cold: 1, hitRatio: 0.5, partial: true } }), hitMissValue({ agent: 'claude' })],
			context: [contextValue(claude), contextValue({ ...claude, context: { window: 200_000, percent: 93, source: 'mod' } }), contextValue(undefined)],
		}).toEqual({
			labels: ['キャッシュ（1時間）', 'キャッシュ（5分）', 'キャッシュ'],
			times: [
				{ text: '残り 39分' },
				{ text: '残り 48秒', tone: 'warn' },
				{ text: '切れています（次の依頼は割高）', tone: 'danger' },
				{ text: '応答中は数えません', dim: true },
				{ text: 'Codex では取れません', dim: true },
				{ text: 'まだありません', dim: true },
			],
			hitMiss: [{ text: 'hit 94% · ミス 2 回' }, { text: 'hit 50% · ミス 1 回（直近の分）' }, { text: 'まだありません', dim: true }],
			context: [{ text: '14%（142.8K / 1M）' }, { text: '93%（200K）', tone: 'danger' }, { text: 'まだありません', dim: true }],
		});
	});

	it('the pull request row: the number and the review state, or why it cannot be shown', () => {
		const pr: PrDetail = { number: 258, title: 't', url: 'https://github.com/o/r/pull/258', state: 'open', repo: 'o/r', headRefName: 'b', headSha: 'abc', reviewDecision: 'APPROVED', checks: [] };
		expect([
			pullRequestValue({ kind: 'pr', pr }, true, undefined),
			pullRequestValue({ kind: 'pr', pr: { ...pr, state: 'merged' } }, true, undefined),
			pullRequestValue({ kind: 'unavailable', reason: 'no-gh', message: undefined }, true, undefined),
			pullRequestValue({ kind: 'unavailable', reason: 'no-auth', message: undefined }, true, undefined),
			pullRequestValue(undefined, true, undefined),
			pullRequestValue(undefined, true, 'timeout'),
			pullRequestValue(undefined, false, undefined),
		]).toEqual([
			{ text: '#258 承認済み' },
			{ text: '#258 マージ済み' },
			{ text: 'gh がありません', dim: true },
			{ text: 'GitHub にログインしていません', dim: true },
			{ text: '読み込んでいます', dim: true },
			{ text: '取得できませんでした', dim: true },
			{ text: 'この PC では取れません', dim: true },
		]);
	});

	it('formats the remaining time and token counts short', () => {
		expect([formatCacheRemaining(48_000), formatCacheRemaining(38 * 60_000 + 1), formatCacheRemaining(62 * 60_000), formatCacheRemaining(60 * 60_000)]).toEqual(['48秒', '39分', '1時間2分', '1時間']);
		expect([formatTokens(950), formatTokens(142_800), formatTokens(200_000), formatTokens(1_000_000), formatTokens(1_500_000)]).toEqual(['950', '142.8K', '200K', '1M', '1.5M']);
	});
});
