/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AivisError } from '../../node/paradisAudioScheduler.js';
import { ParadisElevenLabsClient } from '../../node/paradisElevenLabsClient.js';
import { ParadisVoiceSynthesisCache } from '../../node/paradisVoiceSynthesisCache.js';

interface IRecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly query: Record<string, string>;
	readonly apiKeyHeader: string | undefined;
	readonly body: unknown;
}

/** 決まった応答を順に返し、送られた要求を記録する fetch。実際の API には一切つながない。 */
class FakeFetch {
	readonly requests: IRecordedRequest[] = [];
	private readonly routes: { readonly match: (method: string, path: string) => boolean; readonly respond: () => Response }[] = [];

	on(method: string, path: string, respond: () => Response): this {
		this.routes.push({ match: (m, p) => m === method && p === path, respond });
		return this;
	}

	readonly fetch = async (input: URL, init: RequestInit): Promise<Response> => {
		const headers = init.headers as Record<string, string>;
		const method = init.method ?? 'GET';
		this.requests.push({
			method,
			path: input.pathname,
			query: Object.fromEntries(input.searchParams.entries()),
			apiKeyHeader: headers['xi-api-key'],
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		});
		const route = this.routes.find(candidate => candidate.match(method, input.pathname));
		if (!route) {
			return new Response('{"detail":"not found"}', { status: 404 });
		}
		return route.respond();
	};
}

function json(value: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const TEST_KEY = 'test-key-not-real';

suite('ParadisElevenLabsClient', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createClient(fake: FakeFetch, now: () => number = () => Date.UTC(2026, 9, 4, 12)): ParadisElevenLabsClient {
		return new ParadisElevenLabsClient(new NullLogService(), fake.fetch, now);
	}

	test('sends the synthesis request with stripped text, speed and the latest dictionary version', async () => {
		const fake = new FakeFetch()
			.on('GET', '/v1/pronunciation-dictionaries/dict1', () => json({ id: 'dict1', name: 'D', latest_version_id: 'ver9' }))
			.on('POST', '/v1/text-to-speech/voice1/stream', () => new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'audio/mpeg' } }));
		const client = createClient(fake);

		const result = await client.synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'eleven_flash_v2_5', text: '<speak>完了<break time="1s"/>しました</speak>', speed: 1.5, dictionaryId: 'dict1', volume: 80 });

		assert.deepStrictEqual({ audio: [...result.audio], requests: fake.requests }, {
			audio: [1, 2, 3],
			requests: [
				{ method: 'GET', path: '/v1/pronunciation-dictionaries/dict1', query: {}, apiKeyHeader: TEST_KEY, body: undefined },
				{
					method: 'POST',
					path: '/v1/text-to-speech/voice1/stream',
					query: { output_format: 'mp3_44100_128' },
					apiKeyHeader: TEST_KEY,
					body: {
						text: '完了 しました',
						model_id: 'eleven_flash_v2_5',
						voice_settings: { speed: 1.2 },
						pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: 'dict1', version_id: 'ver9' }],
					},
				},
			],
		});
	});

	test('sends the voice tuning of the voice and reads the saved settings of a voice', async () => {
		const fake = new FakeFetch()
			.on('POST', '/v1/text-to-speech/voice1/stream', () => new Response(Uint8Array.of(9)))
			.on('GET', '/v1/voices/voice1/settings', () => json({ stability: 0.45, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1 }));
		const client = createClient(fake);
		await client.synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'eleven_v3', text: 'x', stability: 0.7, similarityBoost: 0.6 });
		const saved = await client.getVoiceSettings(TEST_KEY, 'voice1');

		assert.deepStrictEqual({ body: fake.requests[0].body, saved, path: fake.requests[1].path }, {
			body: { text: 'x', model_id: 'eleven_v3', voice_settings: { speed: 1, stability: 0.5, similarity_boost: 0.6 } },
			saved: { stability: 0.45, similarityBoost: 0.8 },
			path: '/v1/voices/voice1/settings',
		});
	});

	test('reads without the dictionary when its version cannot be resolved', async () => {
		const fake = new FakeFetch()
			.on('GET', '/v1/pronunciation-dictionaries/gone', () => json({ detail: { status: 'not_found' } }, 404))
			.on('POST', '/v1/text-to-speech/voice1/stream', () => new Response(Uint8Array.of(9)));
		await createClient(fake).synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: '', text: 'hello', dictionaryId: 'gone' });

		assert.deepStrictEqual(fake.requests[1].body, { text: 'hello', model_id: 'eleven_flash_v2_5', voice_settings: { speed: 1 } });
	});

	test('maps HTTP failures to scheduler error kinds without leaking the key', async () => {
		const cases: [number, unknown, Record<string, string>?][] = [
			[401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }],
			[401, { detail: { status: 'quota_exceeded', message: 'quota' } }],
			[429, { detail: { status: 'too_many_concurrent_requests' } }, { 'retry-after': '3' }],
			[500, {}],
			[422, { detail: [{ msg: 'bad' }] }],
		];
		const results: { kind: string; status: number | undefined; reset: number | undefined; leaksKey: boolean }[] = [];
		for (const [status, body, headers] of cases) {
			const fake = new FakeFetch().on('POST', '/v1/text-to-speech/voice1/stream', () => new Response(JSON.stringify(body), { status, headers }));
			try {
				await createClient(fake).synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'm', text: 'x' });
				assert.fail('expected a failure');
			} catch (error) {
				assert.ok(error instanceof AivisError);
				results.push({ kind: error.kind, status: error.status, reset: error.rateLimitReset, leaksKey: error.message.includes(TEST_KEY) });
			}
		}
		assert.deepStrictEqual(results, [
			{ kind: 'fatal', status: 401, reset: undefined, leaksKey: false },
			{ kind: 'fatal', status: 401, reset: undefined, leaksKey: false },
			{ kind: 'retryable', status: 429, reset: 3, leaksKey: false },
			{ kind: 'retryable', status: 500, reset: undefined, leaksKey: false },
			{ kind: 'item-specific', status: 422, reset: undefined, leaksKey: false },
		]);
	});

	test('treats network failures as retryable and empty text as item-specific', async () => {
		const failing = new ParadisElevenLabsClient(new NullLogService(), async () => { throw new TypeError('fetch failed'); });
		const kinds: string[] = [];
		for (const text of ['hello', '<break/>']) {
			try {
				await failing.synthesize({ apiKey: TEST_KEY, voiceId: 'v', modelId: 'm', text });
			} catch (error) {
				kinds.push(error instanceof AivisError ? error.kind : 'other');
			}
		}
		assert.deepStrictEqual(kinds, ['retryable', 'item-specific']);
	});

	test('asks for daily character stats with breakdowns in milliseconds', async () => {
		const now = Date.UTC(2026, 9, 4, 12);
		const start = Date.UTC(2026, 9, 3);
		const fake = new FakeFetch().on('GET', '/v1/usage/character-stats', () => json({ time: [start, Date.UTC(2026, 9, 4)], usage: { All: [10, 5] } }));
		const usage = await createClient(fake, () => now).getUsage(TEST_KEY, 2);

		assert.deepStrictEqual({
			queries: fake.requests.map(request => request.query),
			total: usage.totalCharacters,
		}, {
			queries: [
				{ start_unix: String(start), end_unix: String(now), aggregation_interval: 'day' },
				{ start_unix: String(start), end_unix: String(now), aggregation_interval: 'day', breakdown_type: 'model' },
				{ start_unix: String(start), end_unix: String(now), aggregation_interval: 'day', breakdown_type: 'voice' },
			],
			total: 15,
		});
	});

	test('reports a missing user_read permission instead of failing the usage view', async () => {
		const missing = new FakeFetch().on('GET', '/v1/user/subscription', () => json({ detail: { status: 'missing_permissions', message: 'user_read' } }, 401));
		const invalid = new FakeFetch().on('GET', '/v1/user/subscription', () => json({ detail: { status: 'invalid_api_key' } }, 401));

		assert.deepStrictEqual(await createClient(missing).getSubscription(TEST_KEY), { kind: 'missing-permissions' });
		await assert.rejects(() => createClient(invalid).getSubscription(TEST_KEY));
	});

	test('reports a set-rules failure without trying another route', async () => {
		const fake = new FakeFetch().on('POST', '/v1/pronunciation-dictionaries/d1/set-rules', () => json({ detail: 'Not Found' }, 404));
		await assert.rejects(() => createClient(fake).setDictionaryRules(TEST_KEY, 'd1', [{ type: 'alias', string_to_replace: 'new', alias: 'にゅー' }]));

		assert.deepStrictEqual(fake.requests.map(request => request.path), ['/v1/pronunciation-dictionaries/d1/set-rules']);
	});

	test('caps a long Retry-After at 60 seconds', async () => {
		const fake = new FakeFetch().on('POST', '/v1/text-to-speech/voice1/stream', () => new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }));
		const error = await createClient(fake).synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'm', text: 'x' }).then(() => undefined, (e: unknown) => e);

		assert.deepStrictEqual(error instanceof AivisError ? [error.kind, error.rateLimitReset] : error, ['retryable', 60]);
	});

	test('remembers an archived or failing dictionary for a while instead of fetching it every time', async () => {
		let now = Date.UTC(2026, 9, 4, 12);
		const fake = new FakeFetch()
			.on('GET', '/v1/pronunciation-dictionaries/archived', () => json({ id: 'archived', latest_version_id: 'v1', archived_time_unix: 1700000100, rules: [] }))
			.on('GET', '/v1/pronunciation-dictionaries/broken', () => json({ detail: 'boom' }, 500))
			.on('POST', '/v1/text-to-speech/voice1/stream', () => new Response(Uint8Array.of(1)));
		const client = createClient(fake, () => now);
		const speak = (dictionaryId: string) => client.synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'm', text: 'x', dictionaryId });
		await speak('archived');
		await speak('broken');
		now += 4 * 60_000;
		await speak('archived');
		await speak('broken');
		now += 2 * 60_000;
		await speak('archived');

		assert.deepStrictEqual(fake.requests.filter(request => request.method === 'GET').map(request => request.path), [
			'/v1/pronunciation-dictionaries/archived',
			'/v1/pronunciation-dictionaries/broken',
			'/v1/pronunciation-dictionaries/archived',
		]);
	});

	test('archives instead of deleting and hides archived dictionaries from the list', async () => {
		const fake = new FakeFetch()
			.on('PATCH', '/v1/pronunciation-dictionaries/d1', () => json({ id: 'd1' }))
			.on('GET', '/v1/pronunciation-dictionaries', () => json({
				pronunciation_dictionaries: [
					{ id: 'd1', name: 'Kept', latest_version_id: 'v1', latest_version_rules_num: 2, creation_time_unix: 1700000000, archived_time_unix: null },
					{ id: 'd2', name: 'Archived', latest_version_id: 'v1', archived_time_unix: 1700000100 },
				],
				has_more: false,
			}));
		const client = createClient(fake);
		await client.archiveDictionary(TEST_KEY, 'd1');
		const list = await client.listDictionaries(TEST_KEY);

		assert.deepStrictEqual({ patch: fake.requests[0].body, list }, {
			patch: { archived: true },
			list: [{ id: 'd1', name: 'Kept', description: '', latestVersionId: 'v1', ruleCount: 2, createdAt: 1700000000000 }],
		});
	});

	test('reads rules from the PLS download when the detail has none', async () => {
		const fake = new FakeFetch()
			.on('GET', '/v1/pronunciation-dictionaries/d1', () => json({ id: 'd1', name: 'D', description: 'desc', latest_version_id: 'v7' }))
			.on('GET', '/v1/pronunciation-dictionaries/d1/v7/download', () => new Response('<lexicon alphabet="ipa"><lexeme><grapheme>PR</grapheme><alias>ぷるりく</alias></lexeme></lexicon>'));
		const detail = await createClient(fake).getDictionary(TEST_KEY, 'd1');

		assert.deepStrictEqual(detail, { id: 'd1', name: 'D', description: 'desc', latestVersionId: 'v7', rules: [{ type: 'alias', string_to_replace: 'PR', alias: 'ぷるりく' }], archived: false });
	});

	test('keeps rule flags from the detail and saves through set-rules', async () => {
		const fake = new FakeFetch()
			.on('GET', '/v1/pronunciation-dictionaries/d1', () => json({
				id: 'd1', name: 'D', latest_version_id: 'v1', latest_version_rules_num: 1, archived_time_unix: null,
				rules: [{ type: 'alias', string_to_replace: 'PR', alias: 'ぷるりく', case_sensitive: true, word_boundaries: false }],
			}))
			.on('POST', '/v1/pronunciation-dictionaries/d1/set-rules', () => json({ id: 'd1', version_id: 'v2', version_rules_num: 1 }))
			.on('POST', '/v1/text-to-speech/voice1/stream', () => new Response(Uint8Array.of(1)));
		const client = createClient(fake);
		const detail = await client.getDictionary(TEST_KEY, 'd1');
		await client.setDictionaryRules(TEST_KEY, 'd1', detail.rules);
		await client.synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'm', text: 'x', dictionaryId: 'd1' });

		assert.deepStrictEqual(fake.requests.slice(1).map(request => [request.method, request.path, request.body]), [
			['POST', '/v1/pronunciation-dictionaries/d1/set-rules', { rules: [{ type: 'alias', string_to_replace: 'PR', alias: 'ぷるりく', case_sensitive: true, word_boundaries: false }] }],
			['POST', '/v1/text-to-speech/voice1/stream', { text: 'x', model_id: 'm', voice_settings: { speed: 1 }, pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: 'd1', version_id: 'v2' }] }],
		]);
	});

	test('reads without an applied dictionary that has been archived', async () => {
		const fake = new FakeFetch()
			.on('GET', '/v1/pronunciation-dictionaries/d1', () => json({ id: 'd1', name: 'D', latest_version_id: 'v1', archived_time_unix: 1700000100, rules: [] }))
			.on('POST', '/v1/text-to-speech/voice1/stream', () => new Response(Uint8Array.of(1)));
		await createClient(fake).synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'm', text: 'x', dictionaryId: 'd1' });

		assert.deepStrictEqual(fake.requests[1].body, { text: 'x', model_id: 'm', voice_settings: { speed: 1 } });
	});

	suite('voice cache', () => {
		let cacheDir: string;
		setup(() => { cacheDir = mkdtempSync(join(tmpdir(), 'paradis-elevenlabs-cache-test-')); });
		teardown(() => rmSync(cacheDir, { recursive: true, force: true }));

		/** 文字数に応じた下限を超える、MP3 に見える音声。 */
		function audio(tag: number): Response {
			const bytes = new Uint8Array(4000).fill(tag);
			bytes.set([0xff, 0xfb, 0x90, 0x00]);
			return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } });
		}

		async function waitForFiles(count: number): Promise<void> {
			for (let i = 0; i < 200 && readdirSync(cacheDir).filter(name => name.endsWith('.mp3')).length < count; i++) {
				await new Promise(resolve => setTimeout(resolve, 5));
			}
			await new Promise(resolve => setTimeout(resolve, 20));
		}

		test('plays the same request from the cache, and synthesizes again when the voice, tuning, dictionary version or text differ or the cache is off', async () => {
			let version = 'ver1';
			const fake = new FakeFetch()
				.on('GET', '/v1/pronunciation-dictionaries/dict1', () => json({ id: 'dict1', name: 'D', latest_version_id: version }))
				.on('POST', '/v1/text-to-speech/voice1/stream', () => audio(5));
			let now = Date.UTC(2026, 9, 9, 12);
			const cache = store.add(new ParadisVoiceSynthesisCache(cacheDir, new NullLogService(), { now: () => now }));
			const client = new ParadisElevenLabsClient(new NullLogService(), fake.fetch, () => now, cache);
			const base = { apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'eleven_v4_turbo', text: 'Para Codeです', dictionaryId: 'dict1', volume: 80, stability: 0.5 };
			const synthesized = () => fake.requests.filter(request => request.method === 'POST').length;
			const counts: number[] = [];

			await client.synthesize(base);
			await waitForFiles(1);
			const hit = await client.synthesize({ ...base, volume: 30 }); // 音量は鳴らすときの補正なので同じ音
			counts.push(synthesized());
			await client.synthesize({ ...base, stability: 0.6 });
			counts.push(synthesized());
			await client.synthesize({ ...base, text: 'mainです' });
			counts.push(synthesized());
			await client.synthesize({ ...base, cache: false });
			counts.push(synthesized());
			// 辞書を直した（版が変わった）。覚えた版の期限が切れていて、古い版の鍵で外れたら、今の版を取り直して合成する
			version = 'ver2';
			now += 61_000;
			await client.synthesize({ ...base, text: '新しい文です' });
			counts.push(synthesized());

			const info = await cache.getInfo();
			assert.deepStrictEqual({ hit: hit.audio[10], counts, lastBody: fake.requests.at(-1)?.body, days: info.days }, {
				hit: 5,
				counts: [1, 2, 3, 4, 5],
				lastBody: { text: '新しい文です', model_id: 'eleven_v4_turbo', voice_settings: { speed: 1, stability: 0.5 }, pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: 'dict1', version_id: 'ver2' }] },
				days: [{ date: '2026-10-09', hits: 1, hitCharacters: 11, calls: 5, callCharacters: 45 }],
			});
		});

		test('plays a hit at once with the expired dictionary version and refreshes the version in the background', async () => {
			let version = 'ver1';
			let release: () => void = () => { };
			const fake = new FakeFetch()
				.on('GET', '/v1/pronunciation-dictionaries/dict1', () => json({ id: 'dict1', name: 'D', latest_version_id: version }))
				.on('POST', '/v1/text-to-speech/voice1/stream', () => audio(6));
			let now = Date.UTC(2026, 9, 9, 12);
			const cache = store.add(new ParadisVoiceSynthesisCache(cacheDir, new NullLogService(), { now: () => now }));
			// 辞書の取得だけ、手で解くまで返さない（当たりがそれを待たないことを見る）
			const slowFetch = async (input: URL, init: RequestInit): Promise<Response> => {
				if (input.pathname.startsWith('/v1/pronunciation-dictionaries/') && fake.requests.length > 0) {
					await new Promise<void>(resolve => { release = resolve; });
				}
				return fake.fetch(input, init);
			};
			const client = new ParadisElevenLabsClient(new NullLogService(), slowFetch, () => now, cache);
			const request = { apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'eleven_v4_turbo', text: 'Para Codeです', dictionaryId: 'dict1' };
			await client.synthesize(request);
			await waitForFiles(1);

			version = 'ver2';
			now += 61_000;
			const hit = await client.synthesize(request); // 辞書の取得は止まったまま
			release();
			await new Promise(resolve => setTimeout(resolve, 20));
			await client.synthesize(request); // 今の版（ver2）の鍵では外れるので合成する

			assert.deepStrictEqual({
				hit: hit.audio[10],
				requests: fake.requests.map(request => [request.method, request.path, (request.body as { pronunciation_dictionary_locators?: { version_id: string }[] } | undefined)?.pronunciation_dictionary_locators?.[0].version_id]),
			}, {
				hit: 6,
				requests: [
					['GET', '/v1/pronunciation-dictionaries/dict1', undefined],
					['POST', '/v1/text-to-speech/voice1/stream', 'ver1'],
					['GET', '/v1/pronunciation-dictionaries/dict1', undefined],
					['POST', '/v1/text-to-speech/voice1/stream', 'ver2'],
				],
			});
		});

		test('re-synthesizes the test playback and replaces the stored voice', async () => {
			let tag = 1;
			const fake = new FakeFetch().on('POST', '/v1/text-to-speech/voice1/stream', () => audio(tag++));
			const cache = store.add(new ParadisVoiceSynthesisCache(cacheDir, new NullLogService()));
			const client = new ParadisElevenLabsClient(new NullLogService(), fake.fetch, Date.now, cache);
			const request = { apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'm', text: 'x' };
			await client.synthesize(request);
			await waitForFiles(1);
			const refreshed = await client.synthesize(request, { refreshCache: true });
			await waitForFiles(1);
			const next = await client.synthesize(request);

			assert.deepStrictEqual({ refreshed: refreshed.audio[10], next: next.audio[10], posts: fake.requests.length }, { refreshed: 2, next: 2, posts: 2 });
		});

		test('does not cache a failed synthesis', async () => {
			let status = 500;
			const fake = new FakeFetch().on('POST', '/v1/text-to-speech/voice1/stream', () => status === 200 ? audio(1) : new Response('{}', { status }));
			const cache = store.add(new ParadisVoiceSynthesisCache(cacheDir, new NullLogService()));
			const client = new ParadisElevenLabsClient(new NullLogService(), fake.fetch, Date.now, cache);
			const request = { apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'm', text: 'x' };
			await assert.rejects(client.synthesize(request));
			status = 200;
			await client.synthesize(request);

			assert.strictEqual(fake.requests.length, 2);
		});
	});
});
