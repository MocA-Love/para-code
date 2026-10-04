/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisClampElevenLabsSpeed,
	paradisClassifyElevenLabsError,
	paradisElevenLabsQuota,
	paradisElevenLabsUsageRange,
	paradisEntriesFromElevenLabsRules,
	paradisFilterElevenLabsModels,
	paradisFilterElevenLabsVoices,
	paradisElevenLabsRetryAfter,
	paradisIsApiKeyLost,
	paradisIsElevenLabsDictionaryArchived,
	paradisIsElevenLabsMissingPermissions,
	paradisNameElevenLabsBreakdown,
	paradisNormalizeElevenLabsRules,
	paradisNormalizeVoiceEngine,
	paradisParseElevenLabsPls,
	paradisPlanApiKeyMigration,
	paradisRulesFromElevenLabsEntries,
	paradisStripSsmlTags,
	paradisSummarizeElevenLabsUsage,
	paradisToElevenLabsSubscription,
	paradisToElevenLabsVoice,
	paradisValidateElevenLabsEntries,
} from '../../common/paradisElevenLabs.js';

suite('Paradis ElevenLabs pure helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps Aivis as the engine unless ElevenLabs is chosen explicitly', () => {
		assert.deepStrictEqual(
			[undefined, '', 'aivis', 'elevenlabs', 'ElevenLabs', 42].map(paradisNormalizeVoiceEngine),
			['aivis', 'aivis', 'aivis', 'elevenlabs', 'aivis', 'aivis'],
		);
	});

	test('clamps the speaking speed to the API range', () => {
		assert.deepStrictEqual(
			[0.5, 0.7, 0.95, 1.2, 2, Number.NaN, '1.1', undefined, 1.0500000001].map(paradisClampElevenLabsSpeed),
			[0.7, 0.7, 0.95, 1.2, 1.2, 1, 1, 1, 1.05],
		);
	});

	test('strips SSML-like tags before sending text', () => {
		assert.deepStrictEqual([
			'<speak>作業が<break time="1s"/>完了しました</speak>',
			'a <emphasis level="strong">b</emphasis>  c',
			'タグなし',
			'<break/>',
			'1 < 2 なので',
			'<prosody rate="slow">ゆっくり</prosody><say-as interpret-as="characters">PR</say-as>',
			'Array<string> を返す <S>と<p>',
			'<pre>そのまま</pre> <speaker>',
		].map(paradisStripSsmlTags), [
			'作業が 完了しました',
			'a b c',
			'タグなし',
			'',
			'1 < 2 なので',
			'ゆっくり PR',
			'Array<string> を返す と',
			'<pre>そのまま</pre> <speaker>',
		]);
	});

	test('caps Retry-After and recognizes a key lost after migration', () => {
		assert.deepStrictEqual({
			retryAfter: ['3', '600', 'soon', null, '-1'].map(paradisElevenLabsRetryAfter),
			lost: [paradisIsApiKeyLost(true, ''), paradisIsApiKeyLost(true, 'k'), paradisIsApiKeyLost(false, '')],
		}, { retryAfter: [3, 60, undefined, undefined, undefined], lost: [true, false, false] });
	});

	test('keeps only text-to-speech models that support Japanese', () => {
		assert.deepStrictEqual(paradisFilterElevenLabsModels([
			{ model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true, languages: [{ language_id: 'en' }, { language_id: 'ja' }] },
			{ model_id: 'eleven_turbo_v2', name: 'Eleven Turbo v2', can_do_text_to_speech: true, languages: [{ language_id: 'en' }] },
			{ model_id: 'eleven_english_sts_v2', name: 'STS', can_do_text_to_speech: false, languages: [{ language_id: 'ja' }] },
			{ model_id: 'eleven_v3', name: '', can_do_text_to_speech: true, languages: [{ language_id: 'ja-JP' }] },
			{ name: 'no id', can_do_text_to_speech: true, languages: [{ language_id: 'ja' }] },
			{ model_id: 'no_languages', can_do_text_to_speech: true },
		]), [
			{ modelId: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5' },
			{ modelId: 'eleven_v3', name: 'eleven_v3' },
		]);
	});

	test('marks Japanese voices and prefers their Japanese preview', () => {
		assert.deepStrictEqual([
			paradisToElevenLabsVoice({ voice_id: 'v1', name: 'A', category: 'premade', preview_url: 'https://example.test/en.mp3', labels: { gender: 'female', accent: 'american' }, verified_languages: [{ language: 'ja', preview_url: 'https://example.test/ja.mp3' }] }),
			paradisToElevenLabsVoice({ voice_id: 'v2', name: 'B', category: 'cloned', labels: { language: 'ja' } }),
			paradisToElevenLabsVoice({ voice_id: 'v3', name: ' ', category: 'professional', fine_tuning: { language: 'en' } }),
			paradisToElevenLabsVoice({ name: 'no id' }),
		], [
			{ voiceId: 'v1', name: 'A', description: 'female · american', category: 'premade', previewUrl: 'https://example.test/ja.mp3', japanese: true },
			{ voiceId: 'v2', name: 'B', description: 'ja', category: 'cloned', previewUrl: null, japanese: true },
			{ voiceId: 'v3', name: 'v3', description: 'professional', category: 'professional', previewUrl: null, japanese: false },
			undefined,
		]);
	});

	test('lists Japanese voices first and filters by search text', () => {
		const voices = [
			{ voiceId: 'b', name: 'Bella', description: 'english', category: '', previewUrl: null, japanese: false },
			{ voiceId: 'z', name: 'Zen', description: 'calm', category: '', previewUrl: null, japanese: true },
			{ voiceId: 'a', name: 'Aoi', description: 'bright', category: '', previewUrl: null, japanese: true },
		];
		assert.deepStrictEqual({
			all: paradisFilterElevenLabsVoices(voices, '').map(voice => voice.voiceId),
			search: paradisFilterElevenLabsVoices(voices, ' CALM ').map(voice => voice.voiceId),
			byName: paradisFilterElevenLabsVoices(voices, 'BEL').map(voice => voice.voiceId),
		}, { all: ['a', 'z', 'b'], search: ['z'], byName: ['b'] });
	});

	test('classifies synthesis failures like the Aivis scheduler expects', () => {
		const body = (status: string) => JSON.stringify({ detail: { status, message: `${status} message` } });
		assert.deepStrictEqual([
			[401, body('invalid_api_key')],
			[401, body('quota_exceeded')],
			[401, body('missing_permissions')],
			[402, ''],
			[400, body('voice_not_found')],
			[404, 'not found'],
			[429, body('too_many_concurrent_requests')],
			[503, ''],
			[422, JSON.stringify({ detail: [{ msg: 'field required' }] })],
			[400, body('max_character_limit_exceeded')],
		].map(([status, text]) => paradisClassifyElevenLabsError(status as number, text as string).kind), [
			'fatal', 'fatal', 'fatal', 'fatal', 'fatal', 'fatal', 'retryable', 'retryable', 'item-specific', 'item-specific',
		]);
	});

	test('explains a 401 by its detail.status before the generic invalid-key text', () => {
		const reason = (status: string) => paradisClassifyElevenLabsError(401, JSON.stringify({ detail: { status, message: 'm' } })).reason;
		assert.deepStrictEqual({
			unusual: reason('detected_unusual_activity').includes('通常と違う利用'),
			needsAuth: reason('needs_authorization').includes('needs_authorization'),
			invalid: reason('invalid_api_key').includes('API キーが無効'),
		}, { unusual: true, needsAuth: true, invalid: true });
	});

	test('explains a 402 payment_required as a plan or balance shortage', () => {
		const result = paradisClassifyElevenLabsError(402, JSON.stringify({ detail: { status: 'payment_required', message: 'm' } }));
		assert.deepStrictEqual(result, { kind: 'fatal', reason: 'ElevenLabs のプランか残高が不足しています' });
	});

	test('recognizes the missing user_read permission only on 401', () => {
		const missing = JSON.stringify({ detail: { status: 'missing_permissions', message: 'needs user_read' } });
		assert.deepStrictEqual([
			paradisIsElevenLabsMissingPermissions(401, missing),
			paradisIsElevenLabsMissingPermissions(403, missing),
			paradisIsElevenLabsMissingPermissions(401, JSON.stringify({ detail: { status: 'invalid_api_key' } })),
			paradisIsElevenLabsMissingPermissions(401, 'not json'),
		], [true, false, false, false]);
	});

	test('summarizes daily usage, fills missing days and sorts breakdowns', () => {
		const now = Date.UTC(2026, 9, 4, 15, 30);
		const range = paradisElevenLabsUsageRange(3, now);
		const day = (offset: number) => Date.UTC(2026, 9, 2 + offset);
		const result = paradisSummarizeElevenLabsUsage(
			{ time: [day(-1), day(0), day(2)], usage: { All: [999, 120, 30] } },
			{ time: [day(0), day(2)], usage: { eleven_flash_v2_5: [100, 30], eleven_v3: [20, 0], unused: [0, 0] } },
			{ time: [day(0)], usage: { voiceB: [20], voiceA: [130] } },
			range,
		);
		assert.deepStrictEqual({ range: [range.startMs === Date.UTC(2026, 9, 2), range.endMs === now], result }, {
			range: [true, true],
			result: {
				days: [
					{ date: '2026-10-02', characterCount: 120 },
					{ date: '2026-10-03', characterCount: 0 },
					{ date: '2026-10-04', characterCount: 30 },
				],
				totalCharacters: 150,
				byModel: [{ key: 'eleven_flash_v2_5', characterCount: 130 }, { key: 'eleven_v3', characterCount: 20 }],
				byVoice: [{ key: 'voiceA', characterCount: 130 }, { key: 'voiceB', characterCount: 20 }],
			},
		});
	});

	test('names breakdown entries and computes the remaining quota', () => {
		const subscription = paradisToElevenLabsSubscription({ character_count: 38120, character_limit: 100000, next_character_count_reset_unix: 1792540800, tier: 'starter' });
		assert.deepStrictEqual({
			names: paradisNameElevenLabsBreakdown([{ key: 'm1', characterCount: 5 }, { key: 'unknown', characterCount: 1 }], new Map([['m1', 'Flash']])),
			subscription,
			quota: paradisElevenLabsQuota(subscription),
			empty: paradisElevenLabsQuota(paradisToElevenLabsSubscription({})),
			over: paradisElevenLabsQuota(paradisToElevenLabsSubscription({ character_count: 12, character_limit: 10 })),
		}, {
			names: [{ label: 'Flash', characterCount: 5 }, { label: 'unknown', characterCount: 1 }],
			subscription: { characterCount: 38120, characterLimit: 100000, nextResetAt: 1792540800000, tier: 'starter' },
			quota: { remaining: 61880, usedRatio: 0.3812 },
			empty: { remaining: 0, usedRatio: 0 },
			over: { remaining: 0, usedRatio: 1 },
		});
	});

	test('converts dictionary rules to editable rows and back', () => {
		const existing = paradisNormalizeElevenLabsRules([
			{ type: 'alias', string_to_replace: 'Para Code', alias: 'パラコード', case_sensitive: false, word_boundaries: true },
			{ type: 'phoneme', string_to_replace: 'tomato', phoneme: 'təˈmeɪtoʊ', alphabet: 'ipa', case_sensitive: true },
			{ type: 'phoneme', string_to_replace: 'API', phoneme: 'eɪ', alphabet: 'ipa' },
			{ type: 'alias', string_to_replace: 'broken' },
			'garbage',
		]);
		const rows = paradisEntriesFromElevenLabsRules(existing);
		const saved = paradisRulesFromElevenLabsEntries([
			...rows,
			{ surface: ' API ', reading: ' エーピーアイ ' },
			{ surface: 'Para Code', reading: 'ぱらこーど' },
			{ surface: '', reading: '' },
		], existing);
		assert.deepStrictEqual({ rows, saved }, {
			rows: [{ surface: 'Para Code', reading: 'パラコード' }],
			saved: [
				{ type: 'phoneme', string_to_replace: 'tomato', phoneme: 'təˈmeɪtoʊ', alphabet: 'ipa', case_sensitive: true },
				{ type: 'alias', string_to_replace: 'API', alias: 'エーピーアイ' },
				{ type: 'alias', string_to_replace: 'Para Code', alias: 'ぱらこーど', case_sensitive: false, word_boundaries: true },
			],
		});
	});

	test('treats only a numeric archived_time_unix as archived', () => {
		assert.deepStrictEqual([1700000100, null, undefined, 0, '1700000100'].map(paradisIsElevenLabsDictionaryArchived), [true, false, false, true, false]);
	});

	test('validates rows by reporting the first incomplete one', () => {
		assert.deepStrictEqual([
			paradisValidateElevenLabsEntries([{ surface: 'a', reading: 'b' }, { surface: '', reading: '' }]),
			paradisValidateElevenLabsEntries([{ surface: 'a', reading: 'b' }, { surface: ' ', reading: 'x' }]),
			paradisValidateElevenLabsEntries([{ surface: 'a', reading: '' }]),
		], [undefined, { row: 2, problem: 'surface' }, { row: 1, problem: 'reading' }]);
	});

	test('reads alias and phoneme rules from a PLS export', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon" alphabet="cmu-arpabet" xml:lang="ja">
	<lexeme><grapheme>Para &amp; Code</grapheme><alias>パラコード</alias></lexeme>
	<lexeme><grapheme>tomato</grapheme><phoneme>T AH0 M EY1 T OW2</phoneme></lexeme>
	<lexeme><alias>no grapheme</alias></lexeme>
</lexicon>`;
		assert.deepStrictEqual(paradisParseElevenLabsPls(xml), [
			{ type: 'alias', string_to_replace: 'Para & Code', alias: 'パラコード' },
			{ type: 'phoneme', string_to_replace: 'tomato', phoneme: 'T AH0 M EY1 T OW2', alphabet: 'cmu-arpabet' },
		]);
	});

	test('plans the API key migration to secret storage', () => {
		assert.deepStrictEqual({
			notPersisted: paradisPlanApiKeyMigration('aivis_plain', 'aivis_secret', false),
			notPersistedEmpty: paradisPlanApiKeyMigration(undefined, 'aivis_secret', false),
			move: paradisPlanApiKeyMigration('aivis_plain', undefined, true),
			jsonWins: paradisPlanApiKeyMigration('aivis_new', 'aivis_old', true),
			alreadyMoved: paradisPlanApiKeyMigration('aivis_same', 'aivis_same', true),
			secretOnly: paradisPlanApiKeyMigration(undefined, 'aivis_secret', true),
			emptyJsonField: paradisPlanApiKeyMigration('', 'aivis_secret', true),
			nothing: paradisPlanApiKeyMigration(undefined, undefined, true),
		}, {
			notPersisted: { use: 'aivis_plain', removeFromJson: false },
			notPersistedEmpty: { use: '', removeFromJson: false },
			move: { use: 'aivis_plain', writeSecret: 'aivis_plain', removeFromJson: true },
			jsonWins: { use: 'aivis_new', writeSecret: 'aivis_new', removeFromJson: true },
			alreadyMoved: { use: 'aivis_same', removeFromJson: true },
			secretOnly: { use: 'aivis_secret', removeFromJson: false },
			emptyJsonField: { use: 'aivis_secret', removeFromJson: true },
			nothing: { use: '', removeFromJson: false },
		});
	});
});
