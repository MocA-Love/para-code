/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AivisError } from '../../node/paradisAudioScheduler.js';
import { ParadisElevenLabsClient } from '../../node/paradisElevenLabsClient.js';

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
	ensureNoDisposablesAreLeakedInTestSuite();

	function createClient(fake: FakeFetch, now: () => number = () => Date.UTC(2026, 9, 4, 12)): ParadisElevenLabsClient {
		return new ParadisElevenLabsClient(new NullLogService(), fake.fetch, now);
	}

	test('sends the synthesis request with stripped text, speed and the latest dictionary version', async () => {
		const fake = new FakeFetch()
			.on('GET', '/v1/pronunciation-dictionaries/dict1', () => json({ id: 'dict1', name: 'D', latest_version_id: 'ver9' }))
			.on('POST', '/v1/text-to-speech/voice1', () => new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'audio/mpeg' } }));
		const client = createClient(fake);

		const result = await client.synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'eleven_flash_v2_5', text: '<speak>完了<break time="1s"/>しました</speak>', speed: 1.5, dictionaryId: 'dict1', volume: 80 });

		assert.deepStrictEqual({ audio: [...result.audio], requests: fake.requests }, {
			audio: [1, 2, 3],
			requests: [
				{ method: 'GET', path: '/v1/pronunciation-dictionaries/dict1', query: {}, apiKeyHeader: TEST_KEY, body: undefined },
				{
					method: 'POST',
					path: '/v1/text-to-speech/voice1',
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

	test('reads without the dictionary when its version cannot be resolved', async () => {
		const fake = new FakeFetch()
			.on('GET', '/v1/pronunciation-dictionaries/gone', () => json({ detail: { status: 'not_found' } }, 404))
			.on('POST', '/v1/text-to-speech/voice1', () => new Response(Uint8Array.of(9)));
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
			const fake = new FakeFetch().on('POST', '/v1/text-to-speech/voice1', () => new Response(JSON.stringify(body), { status, headers }));
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

	test('falls back to remove-rules and add-rules when set-rules is not available', async () => {
		const fake = new FakeFetch()
			.on('POST', '/v1/pronunciation-dictionaries/d1/set-rules', () => json({ detail: 'Not Found' }, 404))
			.on('GET', '/v1/pronunciation-dictionaries/d1', () => json({ id: 'd1', name: 'D', latest_version_id: 'v1', rules: [{ type: 'alias', string_to_replace: 'old', alias: 'おーるど' }] }))
			.on('POST', '/v1/pronunciation-dictionaries/d1/remove-rules', () => json({ id: 'd1', version_id: 'v2' }))
			.on('POST', '/v1/pronunciation-dictionaries/d1/add-rules', () => json({ id: 'd1', version_id: 'v3' }));
		await createClient(fake).setDictionaryRules(TEST_KEY, 'd1', [{ type: 'alias', string_to_replace: 'new', alias: 'にゅー' }]);

		assert.deepStrictEqual(fake.requests.map(request => [request.method, request.path, request.body]), [
			['POST', '/v1/pronunciation-dictionaries/d1/set-rules', { rules: [{ type: 'alias', string_to_replace: 'new', alias: 'にゅー' }] }],
			['GET', '/v1/pronunciation-dictionaries/d1', undefined],
			['POST', '/v1/pronunciation-dictionaries/d1/remove-rules', { rule_strings: ['old'] }],
			['POST', '/v1/pronunciation-dictionaries/d1/add-rules', { rules: [{ type: 'alias', string_to_replace: 'new', alias: 'にゅー' }] }],
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
			.on('POST', '/v1/text-to-speech/voice1', () => new Response(Uint8Array.of(1)));
		const client = createClient(fake);
		const detail = await client.getDictionary(TEST_KEY, 'd1');
		await client.setDictionaryRules(TEST_KEY, 'd1', detail.rules);
		await client.synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'm', text: 'x', dictionaryId: 'd1' });

		assert.deepStrictEqual(fake.requests.slice(1).map(request => [request.method, request.path, request.body]), [
			['POST', '/v1/pronunciation-dictionaries/d1/set-rules', { rules: [{ type: 'alias', string_to_replace: 'PR', alias: 'ぷるりく', case_sensitive: true, word_boundaries: false }] }],
			['POST', '/v1/text-to-speech/voice1', { text: 'x', model_id: 'm', voice_settings: { speed: 1 }, pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: 'd1', version_id: 'v2' }] }],
		]);
	});

	test('reads without an applied dictionary that has been archived', async () => {
		const fake = new FakeFetch()
			.on('GET', '/v1/pronunciation-dictionaries/d1', () => json({ id: 'd1', name: 'D', latest_version_id: 'v1', archived_time_unix: 1700000100, rules: [] }))
			.on('POST', '/v1/text-to-speech/voice1', () => new Response(Uint8Array.of(1)));
		await createClient(fake).synthesize({ apiKey: TEST_KEY, voiceId: 'voice1', modelId: 'm', text: 'x', dictionaryId: 'd1' });

		assert.deepStrictEqual(fake.requests[1].body, { text: 'x', model_id: 'm', voice_settings: { speed: 1 } });
	});
});
