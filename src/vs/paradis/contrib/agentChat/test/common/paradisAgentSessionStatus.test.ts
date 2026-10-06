/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisPromptCacheRequest,
	ParadisAgentSessionStatusTracker,
	ParadisPromptCacheLedger,
	paradisClaudeCacheTtl,
	paradisClaudeContextWindow,
	paradisCodexContextPercent,
} from '../../common/paradisAgentSessionStatus.js';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');

function at(seconds: number): string {
	return new Date(T0 + seconds * 1000).toISOString();
}

function request(seconds: number, inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, ttl: '5m' | '1h' | undefined = cacheCreationTokens > 0 ? '5m' : undefined): IParadisPromptCacheRequest {
	return { at: T0 + seconds * 1000, inputTokens, cacheReadTokens, cacheCreationTokens, ttl };
}

function claudeLine(id: string, seconds: number, input: number, read: number, creation: number, extra: Record<string, unknown> = {}, ttl: '5m' | '1h' = '5m'): Record<string, unknown> {
	return {
		type: 'assistant', sessionId: 'session-1', timestamp: at(seconds), ...extra,
		message: { id, model: 'claude-opus-4-7', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: creation, cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? creation : 0, ephemeral_1h_input_tokens: ttl === '1h' ? creation : 0 } } },
	};
}

function codexTokenCount(seconds: number, cumulative: number, input: number, cached: number, total: number, window = 272_000): Record<string, unknown> {
	return {
		type: 'event_msg', timestamp: at(seconds),
		payload: { type: 'token_count', info: { total_token_usage: { total_tokens: cumulative }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: total - input, total_tokens: total }, model_context_window: window } },
	};
}

suite('ParadisAgentSessionStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies each request the way Claude Code 2.1.291 cn.record does', () => {
		const ledger = new ParadisPromptCacheLedger();
		const outcomes = [
			ledger.record(request(0, 10, 0, 20_000)),
			// 読めた量が小さい方の 95% 以上 → hit
			ledger.record(request(10, 5, 19_010, 1_000)),
			// 95% 未満だが減りが 2000 未満 → hit
			ledger.record(request(20, 1_500, 18_600, 0)),
			// 95% 未満で 2000 以上減った → miss
			ledger.record(request(30, 2_000, 10_000, 8_000)),
		];
		// 予告の後、直前から TTL（5 分）以内の減り → expected
		ledger.expectDrop(T0 + 35_000);
		outcomes.push(ledger.record(request(40, 100, 1_000, 5_000)));
		// 予告の後でも、直前から TTL を過ぎていれば miss
		ledger.expectDrop(T0 + 45_000);
		outcomes.push(ledger.record(request(40 + 301, 100, 0, 6_000)));
		assert.deepStrictEqual({ outcomes, summary: ledger.summary() }, {
			outcomes: ['cold', 'hit', 'hit', 'miss', 'expected', 'miss'],
			summary: { requests: 6, hits: 2, misses: 2, expected: 1, cold: 1, hitRatio: (19_010 + 18_600 + 10_000 + 1_000) / (19_010 + 18_600 + 10_000 + 1_000 + 20_000 + 1_000 + 8_000 + 5_000 + 6_000 + 10 + 5 + 1_500 + 2_000 + 100 + 100) },
		});
	});

	test('counts cold after a request without cache, uncached while no cache was ever used, and inherits the TTL of reads', () => {
		const ledger = new ParadisPromptCacheLedger();
		const outcomes = [
			ledger.record(request(0, 3_000, 0, 0)),
			ledger.record(request(10, 3_500, 0, 0)),
			ledger.record(request(20, 10, 0, 4_000, '1h')),
			// 読むだけのリクエストは 1 時間を引き継ぐ。予告の後 10 分たっても 1 時間以内なので expected
			ledger.record(request(30, 10, 4_000, 0)),
		];
		ledger.expectDrop(T0 + 31_000);
		outcomes.push(ledger.record(request(30 + 600, 10, 0, 4_100, '1h')));
		assert.deepStrictEqual(outcomes, ['cold', 'uncached', 'cold', 'hit', 'expected']);
	});

	test('reads the TTL like Claude Code: 1 hour wins when both were written', () => {
		assert.deepStrictEqual([
			paradisClaudeCacheTtl({ cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 900 } }),
			paradisClaudeCacheTtl({ cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } }),
			paradisClaudeCacheTtl({ cache_creation_input_tokens: 10 }),
		], ['1h', '5m', undefined]);
	});

	test('counts the blocks of one message once, and redoes the count when a later block carries other numbers', () => {
		const tracker = new ParadisAgentSessionStatusTracker('claude');
		tracker.observe(claudeLine('m1', 0, 10, 0, 20_000));
		tracker.observe(claudeLine('m2', 10, 5, 0, 30_000));
		tracker.observe(claudeLine('m2', 10, 5, 0, 30_000));
		// 同じ id の後の行で数が直った（読めていた）→ miss を取り消して hit
		tracker.observe(claudeLine('m2', 10, 5, 20_000, 10_000));
		// 中断の行（<synthetic>）とサブエージェントの行は数えない
		tracker.observe({ ...claudeLine('m3', 20, 0, 0, 0), message: { id: 'm3', model: '<synthetic>', usage: { input_tokens: 0 } } });
		tracker.observe(claudeLine('m4', 30, 10, 0, 40_000, { isSidechain: true }));
		assert.deepStrictEqual(tracker.snapshot().cache, { requests: 2, hits: 1, misses: 0, expected: 0, cold: 1, hitRatio: Math.round(20_000 / 50_015 * 1000) / 1000 });
	});

	test('treats a compaction boundary as the notice of the drop that follows', () => {
		const tracker = new ParadisAgentSessionStatusTracker('claude');
		tracker.observe(claudeLine('m1', 0, 10, 0, 100_000));
		tracker.observe(claudeLine('m2', 10, 10, 100_000, 500));
		tracker.observe({ type: 'system', subtype: 'compact_boundary', sessionId: 'session-1', timestamp: at(20) });
		tracker.observe(claudeLine('m3', 30, 10, 3_000, 9_000));
		assert.deepStrictEqual(tracker.snapshot().cache, { requests: 3, hits: 1, misses: 0, expected: 1, cold: 1, hitRatio: 0.485 });
	});

	test('counts again from a resumed session: a new sessionId in the lines or a SessionStart time', () => {
		const tracker = new ParadisAgentSessionStatusTracker('claude');
		tracker.observe(claudeLine('m1', 0, 10, 0, 20_000));
		tracker.observe(claudeLine('m2', 10, 10, 0, 20_000));
		tracker.observe({ ...claudeLine('m3', 20, 10, 0, 20_000), sessionId: 'session-2' });
		const afterSessionId = tracker.snapshot().cache;
		tracker.markRestart(T0 + 25_000);
		tracker.observe({ ...claudeLine('m4', 30, 10, 20_000, 0), sessionId: 'session-2' });
		// 読み直し（clear）しても、開き直しの時刻は残るので同じ数になる
		const replayed = new ParadisAgentSessionStatusTracker('claude');
		replayed.markRestart(T0 + 25_000);
		for (const line of [claudeLine('m1', 0, 10, 0, 20_000), { ...claudeLine('m4', 30, 10, 20_000, 0), sessionId: 'session-1' }]) {
			replayed.observe(line);
		}
		assert.deepStrictEqual([afterSessionId?.requests, afterSessionId?.cold, tracker.snapshot().cache?.requests, tracker.snapshot().cache?.cold, replayed.snapshot().cache?.requests], [1, 1, 1, 1, 1]);
	});

	test('the context comes from Claude Mod when it measured, else from the last request and the model window', () => {
		const tracker = new ParadisAgentSessionStatusTracker('claude');
		const empty = tracker.snapshot();
		tracker.observe(claudeLine('m1', 0, 10, 0, 140_000));
		const fromTranscript = tracker.snapshot({ model: 'claude-opus-4-7' }).context;
		const oneMillion = tracker.snapshot({ model: 'claude-opus-4-7[1m]' }).context;
		const changed = tracker.applyMeasure({ tokens: 142_800, window: 1_000_000, percent: 14 });
		const unchanged = tracker.applyMeasure({ tokens: 142_800, window: 1_000_000, percent: 14 });
		assert.deepStrictEqual({ empty, fromTranscript, oneMillion, changed, unchanged, fromMod: tracker.snapshot().context, windows: [paradisClaudeContextWindow(undefined, 150_000), paradisClaudeContextWindow(undefined, 250_000)] }, {
			empty: { agent: 'claude' },
			fromTranscript: { tokens: 140_010, window: 200_000, percent: 70, source: 'transcript' },
			oneMillion: { tokens: 140_010, window: 1_000_000, percent: 14, source: 'transcript' },
			changed: true,
			unchanged: false,
			fromMod: { tokens: 142_800, window: 1_000_000, percent: 14, source: 'mod' },
			windows: [200_000, 1_000_000],
		});
	});

	test('reads Codex token_count: repeated counts once, the TUI context percent, no cache expiry, compaction expected at any time', () => {
		const tracker = new ParadisAgentSessionStatusTracker('codex');
		tracker.observe({ type: 'session_meta', sessionId: 'x', timestamp: at(0), payload: {} });
		tracker.observe(codexTokenCount(10, 30_000, 29_000, 0, 30_000));
		tracker.observe(codexTokenCount(11, 30_000, 29_000, 0, 30_000));
		tracker.observe(codexTokenCount(20, 70_000, 39_000, 28_000, 40_000));
		tracker.observe({ type: 'compacted', timestamp: at(30), payload: { message: '' } });
		// 時間がたっていても（有効期限の根拠が無い）、圧縮の後の減りは expected
		tracker.observe(codexTokenCount(3_600, 90_000, 19_000, 1_000, 20_000));
		tracker.observe(codexTokenCount(3_610, 110_000, 20_000, 19_000, 21_000));
		assert.deepStrictEqual(tracker.snapshot({ promptCache: { lastUsedAt: T0, ttlMs: 300_000 } }), {
			agent: 'codex',
			// 2 つ目は「直前がキャッシュ無しで今回は使った」ので cold（Claude Code と同じ）
			cache: { requests: 4, hits: 1, misses: 0, expected: 1, cold: 2, hitRatio: Math.round(48_000 / 107_000 * 1000) / 1000 },
			context: { tokens: 21_000, window: 272_000, percent: paradisCodexContextPercent(21_000, 272_000), source: 'transcript' },
		});
		assert.strictEqual(paradisCodexContextPercent(140_000, 272_000), 49);
	});

	test('a Codex session whose running total goes down started over', () => {
		const tracker = new ParadisAgentSessionStatusTracker('codex');
		tracker.observe(codexTokenCount(10, 30_000, 29_000, 0, 30_000));
		tracker.observe(codexTokenCount(20, 70_000, 39_000, 28_000, 40_000));
		tracker.observe(codexTokenCount(30, 5_000, 4_000, 0, 5_000));
		tracker.clear();
		tracker.observe(codexTokenCount(10, 30_000, 29_000, 0, 30_000));
		assert.deepStrictEqual(tracker.snapshot().cache?.requests, 1);
	});
});
