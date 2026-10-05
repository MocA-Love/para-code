/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisElevenLabsUsageResult } from '../../../notifications/common/paradisElevenLabs.js';
import { IParadisAivisUsageResult } from '../../../notifications/common/paradisNotifications.js';
import {
	ParadisMobileVoiceUsageCache,
	paradisBuildMobileAivisUsage,
	paradisBuildMobileElevenLabsUsage,
	paradisMobileAivisUsageRange,
	paradisMobileVoiceKeyId,
	paradisMobileVoiceUsageFailure,
	paradisRedactVoiceUsageError,
} from '../../common/paradisMobileVoiceUsage.js';

suite('ParadisMobileVoiceUsage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('キーの印: 同じキーは同じ印、エンジンやキーが違えば別の印で、キーそのものを含まない', () => {
		const key = 'fake-voice-api-key-for-tests-0123456789';
		const id = paradisMobileVoiceKeyId('elevenlabs', key);
		assert.deepStrictEqual({
			length: id.length,
			hex: /^[0-9a-f]+$/.test(id),
			stable: paradisMobileVoiceKeyId('elevenlabs', key) === id,
			otherEngine: paradisMobileVoiceKeyId('aivis', key) === id,
			otherKey: paradisMobileVoiceKeyId('elevenlabs', `${key}x`) === id,
			containsKey: key.includes(id) || id.includes(key.slice(0, 6)),
		}, { length: 12, hex: true, stable: true, otherEngine: false, otherKey: false, containsKey: false });
	});

	test('エラーの文からキーを伏せ、長すぎる文は切る', () => {
		assert.deepStrictEqual({
			redacted: paradisRedactVoiceUsageError(new Error('401 for key sk_123 (sk_123)'), ['sk_123', '']),
			long: paradisRedactVoiceUsageError('x'.repeat(400), []).length,
		}, { redacted: '401 for key *** (***)', long: 301 });
	});

	test('Aivis: 30 日を欠けなく埋め、API キー別を 7 日と 30 日で別に合計する', () => {
		const now = new Date(2026, 9, 5, 12, 0, 0).getTime();
		const range = paradisMobileAivisUsageRange(now);
		const usage: IParadisAivisUsageResult = {
			days: [
				{ date: '2026-09-06', requestCount: 10, characterCount: 100, creditConsumed: 1, byApiKey: { a: { name: 'para-code', requestCount: 10, characterCount: 100, creditConsumed: 1 } } },
				{ date: '2026-10-04', requestCount: 3, characterCount: 30, creditConsumed: 0.5, byApiKey: { a: { name: 'para-code', requestCount: 1, characterCount: 10, creditConsumed: 0 }, b: { name: 'aivis-mcp', requestCount: 2, characterCount: 20, creditConsumed: 0.5 } } },
			],
			total: { requestCount: 13, characterCount: 130, creditConsumed: 1.5 },
		};
		const built = paradisBuildMobileAivisUsage('k1', usage, { handle: null, name: null, creditBalance: 1000 }, range, 99);
		assert.deepStrictEqual({
			range,
			count: built.days?.length,
			first: built.days?.[0],
			last: built.days?.[29],
			short: built.byApiKey7,
			long: built.byApiKey30,
			balance: built.creditBalance,
		}, {
			range: { start: '2026-09-06', end: '2026-10-05' },
			count: 30,
			first: { date: '2026-09-06', requests: 10, chars: 100, credits: 1 },
			last: { date: '2026-10-05', requests: 0, chars: 0, credits: 0 },
			short: [{ name: 'aivis-mcp', requests: 2, chars: 20, credits: 0.5 }, { name: 'para-code', requests: 1, chars: 10, credits: 0 }],
			long: [{ name: 'para-code', requests: 11, chars: 110, credits: 1 }, { name: 'aivis-mcp', requests: 2, chars: 20, credits: 0.5 }],
			balance: 1000,
		});
	});

	test('ElevenLabs: モデル名を引き当て、7 日の内訳は同じ取得の recent から作る。無ければ省き、プランが取れなければ理由だけを送る', () => {
		const usage = (recent: boolean): IParadisElevenLabsUsageResult => ({
			days: Array.from({ length: 30 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`, characterCount: index })),
			totalCharacters: 0,
			byModel: [{ key: 'eleven_v4_turbo', characterCount: 300 }, { key: 'unknown_model', characterCount: 1 }],
			byVoice: [{ key: 'シーツー', characterCount: 30 }],
			...(recent ? { recent: { days: 7, byModel: [{ key: 'eleven_v4_turbo', characterCount: 70 }], byVoice: [{ key: 'シーツー', characterCount: 7 }] } } : {}),
		});
		const names = new Map([['eleven_v4_turbo', 'Eleven v4 Turbo']]);
		const ok = paradisBuildMobileElevenLabsUsage('k2', usage(true), { kind: 'ok', subscription: { characterCount: 61540, characterLimit: 100000, nextResetAt: 1, tier: 'creator' } }, names, 5);
		const missing = paradisBuildMobileElevenLabsUsage('k2', usage(false), { kind: 'missing-permissions' }, names, 5);
		assert.deepStrictEqual({
			days: ok.days?.length,
			byModel7: ok.byModel7,
			byVoice7: ok.byVoice7,
			byModel30: ok.byModel30,
			subscription: ok.subscription,
			missing: [missing.subscription, missing.subscriptionUnavailable, Object.keys(missing).includes('byModel7'), Object.keys(missing).includes('byVoice7')],
		}, {
			days: 30,
			byModel7: [{ label: 'Eleven v4 Turbo', chars: 70 }],
			byVoice7: [{ label: 'シーツー', chars: 7 }],
			byModel30: [{ label: 'Eleven v4 Turbo', chars: 300 }, { label: 'unknown_model', chars: 1 }],
			subscription: { used: 61540, limit: 100000, resetAt: 1, tier: 'creator' },
			missing: [undefined, 'missing-permissions', false, false],
		});
	});

	test('失敗: 前に取れた値があれば、それに理由を添えて返す。キーが違えば理由だけ', () => {
		const lastGood = { keyId: 'k', fetchedAt: 10, days: [{ date: 'd', chars: 1 }] };
		assert.deepStrictEqual([
			paradisMobileVoiceUsageFailure(lastGood, 'k', 'boom', 99),
			paradisMobileVoiceUsageFailure(lastGood, 'other', 'boom', 99),
			paradisMobileVoiceUsageFailure(undefined, 'k', 'boom', 99),
		], [
			{ keyId: 'k', fetchedAt: 10, days: [{ date: 'd', chars: 1 }], error: 'boom' },
			{ keyId: 'other', fetchedAt: 99, error: 'boom' },
			{ keyId: 'k', fetchedAt: 99, error: 'boom' },
		]);
	});

	test('キャッシュ: 期限内は取り直さず、同時の要求は 1 回にまとめ、引っ張って更新でも直後は使い回す', async () => {
		let now = 0;
		let loads = 0;
		const cache = new ParadisMobileVoiceUsageCache<number>(() => now, 1000, 100);
		const load = async () => ++loads;
		const concurrent = await Promise.all([cache.get('a', false, load), cache.get('a', false, load)]);
		now = 50;
		const withinMinRefresh = await cache.get('a', true, load);
		now = 500;
		const withinTtl = await cache.get('a', false, load);
		const bypassAfterMin = await cache.get('a', true, load);
		now = 2000;
		const expired = await cache.get('a', false, load);
		let failed = false;
		now = 2500;
		await cache.get('a', true, () => Promise.reject(new Error('boom'))).catch(() => { failed = true; });
		// 失敗しても最後に取れた値は残る（期限切れでも）
		const lastGoodAfterFailure = cache.lastGood('a');
		await cache.get('b', false, () => Promise.reject(new Error('boom'))).catch(() => undefined);
		const afterFailure = await cache.get('b', false, load);
		cache.prune(new Set(['b']));
		assert.deepStrictEqual({ concurrent, withinMinRefresh, withinTtl, bypassAfterMin, expired, failed, lastGoodAfterFailure, afterFailure, size: cache.size, prunedLastGood: cache.lastGood('a') }, {
			concurrent: [1, 1], withinMinRefresh: 1, withinTtl: 1, bypassAfterMin: 2, expired: 3, failed: true, lastGoodAfterFailure: 3, afterFailure: 4, size: 1, prunedLastGood: undefined,
		});
	});

	test('キャッシュ: 取得中に prune で外したキーの結果は、終わっても覚えない', async () => {
		const cache = new ParadisMobileVoiceUsageCache<number>(() => 0);
		let finish: (value: number) => void = () => { };
		const running = cache.get('old', false, () => new Promise<number>(resolve => { finish = resolve; }));
		cache.prune(new Set(['new']));
		finish(1);
		assert.deepStrictEqual({ value: await running, size: cache.size, lastGood: cache.lastGood('old') }, { value: 1, size: 0, lastGood: undefined });
	});
});
