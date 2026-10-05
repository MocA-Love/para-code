// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// store.js の先で React Native を読むフックを差し替える（usageAggregate.test.ts と同じ）
vi.mock('../../hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
import type { UsageEntry } from './usageAggregate.js';
import { parseUsageRecord } from './usageCache.js';
import {
	aivisPeriodView,
	carryVoiceUsage,
	elevenLabsPeriodView,
	elevenLabsQuota,
	groupVoiceUsage,
	initialVoiceProvider,
	voiceDayLabel,
	voiceEmptyReason,
	voiceEnginesByPreference,
	voiceSummaryHint,
} from './voiceUsageModel.js';
import { VoiceUsageUnsupportedError, isVoiceUsageResult, parseVoiceUsageResult, type VoiceUsageResult } from './voiceUsageWire.js';

const NOW = 1_800_000_000_000;

function elevenLabs(keyId: string, fetchedAt: number, extra: Partial<NonNullable<VoiceUsageResult['elevenLabs']>> = {}): NonNullable<VoiceUsageResult['elevenLabs']> {
	return { keyId, fetchedAt, days: [], subscription: { used: 61_540, limit: 100_000, resetAt: null, tier: null }, ...extra };
}

function aivis(keyId: string, fetchedAt: number, extra: Partial<NonNullable<VoiceUsageResult['aivis']>> = {}): NonNullable<VoiceUsageResult['aivis']> {
	return { keyId, fetchedAt, days: [], creditBalance: 1000, ...extra };
}

function entry(pcId: string, label: string, online: boolean, voice: VoiceUsageResult | undefined, at = NOW - 1000): UsageEntry {
	return {
		key: `pc:${pcId}`,
		kind: 'pc',
		pcId,
		label,
		viaPcs: [],
		alsoViaSsh: false,
		sourceKeys: [`pc:${pcId}`],
		online,
		values: voice !== undefined ? { voice: { value: voice, at, receivedAt: at } } : {},
	};
}

describe('groupVoiceUsage', () => {
	it('同じキーは 1 つにまとめて新しい値を採り、違うキーは別々に出す。眠っている PC の値は古い値', () => {
		const groups = groupVoiceUsage([
			entry('a', 'MacBook Pro', true, { fetchedAt: NOW, engine: 'elevenlabs', elevenLabs: elevenLabs('k1', NOW - 5000), aivis: aivis('x1', NOW - 5000) }),
			entry('b', 'Mac mini', false, { fetchedAt: NOW, engine: 'aivis', elevenLabs: elevenLabs('k1', NOW - 1000), aivis: aivis('x2', NOW - 1000) }),
			entry('c', 'iMac', true, { fetchedAt: NOW, engine: 'aivis' }),
		], NOW);
		expect({
			elevenLabs: groups.elevenLabs.map(group => ({ key: group.key, label: group.label, from: group.fromPc, old: group.old, seen: group.seenOn.map(seen => `${seen.label}${seen.old ? '(old)' : ''}`) })),
			aivis: groups.aivis.map(group => ({ key: group.key, label: group.label, old: group.old })),
		}).toEqual({
			// オフラインの Mac mini の方が取得時刻は新しいが、古い値の印が無い MacBook Pro を採る
			elevenLabs: [{ key: 'elevenlabs:k1', label: 'MacBook Pro・Mac mini', from: 'MacBook Pro', old: false, seen: ['MacBook Pro', 'Mac mini(old)'] }],
			aivis: [{ key: 'aivis:x1', label: 'MacBook Pro', old: false }, { key: 'aivis:x2', label: 'Mac mini', old: true }],
		});
	});

	it('同じキーで片方が失敗していれば、取れている方を採る', () => {
		const groups = groupVoiceUsage([
			entry('a', 'A', true, { fetchedAt: NOW, engine: 'elevenlabs', elevenLabs: elevenLabs('k1', NOW, { error: '401' }) }),
			entry('b', 'B', true, { fetchedAt: NOW, engine: 'elevenlabs', elevenLabs: elevenLabs('k1', NOW - 60_000) }),
		], NOW);
		expect([groups.elevenLabs.length, groups.elevenLabs[0]?.fromPc, groups.elevenLabs[0]?.usage.error]).toEqual([1, 'B', undefined]);
	});
});

describe('initialVoiceProvider', () => {
	it('PC で今使っているエンジン（見ている PC を先に）を、キーがあれば選ぶ。無ければ出せる方', () => {
		const entries = [
			entry('a', 'A', true, { fetchedAt: NOW, engine: 'aivis' }, NOW - 10),
			entry('b', 'B', true, { fetchedAt: NOW, engine: 'elevenlabs' }, NOW - 5),
		];
		expect({
			preferA: voiceEnginesByPreference(entries, 'a'),
			newestFirst: voiceEnginesByPreference(entries, undefined),
			both: initialVoiceProvider(['elevenlabs', 'aivis'], voiceEnginesByPreference(entries, 'a')),
			onlyOther: initialVoiceProvider(['elevenlabs'], ['aivis']),
			noEngines: initialVoiceProvider(['aivis', 'elevenlabs'], []),
			none: initialVoiceProvider([], ['aivis']),
		}).toEqual({ preferA: ['aivis', 'elevenlabs'], newestFirst: ['elevenlabs', 'aivis'], both: 'aivis', onlyOther: 'elevenlabs', noEngines: 'elevenlabs', none: undefined });
	});
});

describe('voiceEmptyReason', () => {
	const none = { elevenLabs: [], aivis: [] };
	it('キーが無い・古い PC・取得中・未取得を見分ける', () => {
		expect({
			noKeys: voiceEmptyReason({ groups: none, anyValue: true, errors: [], loading: false }),
			updatePc: voiceEmptyReason({ groups: none, anyValue: false, errors: [new VoiceUsageUnsupportedError()], loading: false }),
			mixedFailure: voiceEmptyReason({ groups: none, anyValue: false, errors: [new VoiceUsageUnsupportedError(), new Error('x')], loading: false }),
			loading: voiceEmptyReason({ groups: none, anyValue: false, errors: [], loading: true }),
			notFetched: voiceEmptyReason({ groups: none, anyValue: false, errors: [], loading: false }),
		}).toEqual({ noKeys: 'no-keys', updatePc: 'update-pc', mixedFailure: 'failed', loading: 'loading', notFetched: 'not-fetched' });
	});
});

describe('期間の切り出しと表示', () => {
	it('7 日は 30 日の末尾から切り出し、内訳は PC が送った 7 日のものを使う', () => {
		const days = Array.from({ length: 30 }, (_, index) => ({ date: `d${index}`, requests: 1, chars: 10, credits: 0.5 }));
		const usage = aivis('x', NOW, { days, byApiKey7: [{ name: 'short', requests: 7, chars: 70, credits: 3.5 }], byApiKey30: [{ name: 'long', requests: 30, chars: 300, credits: 15 }] });
		const short = aivisPeriodView(usage, 7);
		const el = elevenLabsPeriodView(elevenLabs('k', NOW, { days: days.map(day => ({ date: day.date, chars: day.chars })), byModel30: [{ label: 'v4', chars: 300 }] }), 30);
		expect({
			short: [short.days.length, short.days[0]?.date, short.requests, short.chars, short.credits, short.byApiKey[0]?.name],
			el: [el.days.length, el.chars, el.byModel, el.byVoice],
			quota: [elevenLabsQuota({ used: 61_540, limit: 100_000 }), elevenLabsQuota({ used: 5, limit: 0 })],
			day: [voiceDayLabel('2026-10-02'), voiceDayLabel('bad')],
		}).toEqual({
			short: [7, 'd23', 7, 70, 3.5, 'short'],
			el: [30, 300, [{ label: 'v4', chars: 300 }], []],
			quota: [{ remaining: 38_460, usedRatio: 0.6154 }, { remaining: 0, usedRatio: 0 }],
			day: ['10/2（金）', 'bad'],
		});
	});

	it('通知と音声の行の補足は、残りと残高をまとめる', () => {
		const groups = groupVoiceUsage([entry('a', 'A', true, { fetchedAt: NOW, engine: 'elevenlabs', elevenLabs: elevenLabs('k', NOW), aivis: aivis('x', NOW) })], NOW);
		expect(voiceSummaryHint(groups)).toBe(`ElevenLabs 残り ${(38_460).toLocaleString()} 文字・Aivis 残高 ${(1000).toLocaleString()}`);
	});
});

describe('形の検査と控え', () => {
	it('形の合わない応答は捨て、控えには読み上げの値も残る', () => {
		const value: VoiceUsageResult = { fetchedAt: NOW, engine: 'aivis', aivis: aivis('x', NOW) };
		const record = parseUsageRecord({ kind: 'pc', pcId: 'a', pcName: 'A', values: { voice: { value, at: NOW } } }, NOW);
		expect({
			valid: isVoiceUsageResult(value),
			badEngine: isVoiceUsageResult({ ...value, engine: 'other' }),
			// 読めないエンジンの部分は捨てるだけで、全体は読む
			badPart: parseVoiceUsageResult({ ...value, aivis: { keyId: 1 } })?.aivis,
			cached: record?.values.voice?.value.aivis?.keyId,
			dropped: parseUsageRecord({ kind: 'pc', pcId: 'a', pcName: 'A', values: { voice: { value: { fetchedAt: NOW }, at: NOW } } }, NOW),
		}).toEqual({ valid: true, badEngine: false, badPart: undefined, cached: 'x', dropped: undefined });
	});
});

describe('7 日の内訳が無いとき', () => {
	it('7 日を見ていても、7 日の内訳が届いていなければ 30 日の内訳を出す', () => {
		const el = elevenLabsPeriodView(elevenLabs('k', NOW, { days: [], byModel30: [{ label: 'v4', chars: 300 }], byVoice30: [] }), 7);
		const av = aivisPeriodView(aivis('x', NOW, { byApiKey30: [{ name: 'long', requests: 1, chars: 1, credits: 0 }] }), 7);
		expect([el.breakdownDays, el.byModel, av.breakdownDays, av.byApiKey[0]?.name]).toEqual([30, [{ label: 'v4', chars: 300 }], 30, 'long']);
	});
});

describe('carryVoiceUsage', () => {
	it('失敗だけが届いた部分は、同じキーの前回の値に理由を添える。キーが違う・前回が無いときはそのまま', () => {
		const previous: VoiceUsageResult = { fetchedAt: 1, engine: 'aivis', aivis: aivis('x', 1, { days: [{ date: 'd', requests: 1, chars: 1, credits: 0 }] }), elevenLabs: elevenLabs('k', 1, { days: [] }) };
		const next: VoiceUsageResult = { fetchedAt: 2, engine: 'aivis', aivis: { keyId: 'x', fetchedAt: 2, error: '503' }, elevenLabs: { keyId: 'other', fetchedAt: 2, error: '401' } };
		const carried = carryVoiceUsage(previous, next);
		expect({
			aivis: [carried.aivis?.fetchedAt, carried.aivis?.days?.length, carried.aivis?.error],
			elevenLabs: carried.elevenLabs,
			noPrevious: carryVoiceUsage(undefined, next),
		}).toEqual({ aivis: [1, 1, '503'], elevenLabs: { keyId: 'other', fetchedAt: 2, error: '401' }, noPrevious: next });
	});
});

describe('parseVoiceUsageResult', () => {
	it('壊れた要素・項目は捨て、読めない部分は部分ごと捨てる', () => {
		const parsed = parseVoiceUsageResult({
			fetchedAt: NOW,
			engine: 'elevenlabs',
			aivis: { keyId: 'x', fetchedAt: NOW, days: [{ date: 'd1', requests: 1, chars: 2, credits: 0 }, { date: 'd2', requests: 'x', chars: 2, credits: 0 }, null, { date: 'd3', requests: Number.NaN, chars: 1, credits: 1 }], creditBalance: 'lots', byApiKey7: 'nope' },
			elevenLabs: { keyId: 5, fetchedAt: NOW },
		});
		const badSubscription = parseVoiceUsageResult({ fetchedAt: NOW, engine: 'elevenlabs', elevenLabs: { keyId: 'k', fetchedAt: NOW, subscription: { used: 'a', limit: 1 }, subscriptionUnavailable: 'weird', error: 7 } });
		expect({ parsed, badSubscription, top: parseVoiceUsageResult({ fetchedAt: Number.POSITIVE_INFINITY, engine: 'aivis' }) }).toEqual({
			parsed: { fetchedAt: NOW, engine: 'elevenlabs', aivis: { keyId: 'x', fetchedAt: NOW, days: [{ date: 'd1', requests: 1, chars: 2, credits: 0 }] } },
			badSubscription: { fetchedAt: NOW, engine: 'elevenlabs', elevenLabs: { keyId: 'k', fetchedAt: NOW } },
			top: undefined,
		});
	});

	it('PC のゴールデン（voice-usage.json）を何も落とさずに読む（PC とアプリの形の一致）', () => {
		const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../protocol/test/golden/voice-usage.json', import.meta.url)), 'utf8')) as { current: unknown; failed: unknown };
		expect([parseVoiceUsageResult(golden.current), parseVoiceUsageResult(golden.failed)]).toEqual([golden.current, golden.failed]);
	});
});
