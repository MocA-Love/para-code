/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisBufferBody, paradisCollectBody } from '../../node/paradisStreamingBody.js';
import { IParadisVoiceSynthesisCacheOptions, paradisVoiceCacheKey, ParadisVoiceCacheLookup, ParadisVoiceSynthesisCache } from '../../node/paradisVoiceSynthesisCache.js';

/** MP3 のフレームの頭に見える音声。 */
function mp3(...rest: number[]): Buffer {
	return Buffer.from([0xff, 0xfb, 0x90, 0x00, ...rest]);
}

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
	for (const part of parts) {
		yield part;
	}
}

async function* failingAfter(part: Uint8Array): AsyncGenerator<Uint8Array> {
	yield part;
	throw new Error('cut');
}

/** 鍵の音声を合成したことにして置く（miss の持ち分で本文を最後まで読む）。 */
async function synthesize(cache: ParadisVoiceSynthesisCache, key: string, audio: Buffer): Promise<ParadisVoiceCacheLookup['kind']> {
	const found = await cache.lookup(key);
	if (found.kind === 'miss') {
		await paradisCollectBody(found.lease.capture(paradisBufferBody(audio)), 1024 * 1024);
	}
	return found.kind;
}

/** 書き込み（rename まで）が終わるのを待つ。 */
async function settled(key: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (readdirSync(cacheDir).includes(`${key}.mp3`)) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error(`not stored: ${key}`);
}

let cacheDir: string;

suite('ParadisVoiceSynthesisCache', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let now = Date.UTC(2026, 9, 9, 12);

	setup(() => {
		cacheDir = mkdtempSync(join(tmpdir(), 'paradis-voice-cache-test-'));
		now = Date.UTC(2026, 9, 9, 12);
	});
	teardown(() => rmSync(cacheDir, { recursive: true, force: true }));

	function create(options: IParadisVoiceSynthesisCacheOptions = {}): ParadisVoiceSynthesisCache {
		return store.add(new ParadisVoiceSynthesisCache(cacheDir, new NullLogService(), { now: () => now, ...options }));
	}

	test('makes the same key for the same request regardless of property order, and a different key when anything differs', () => {
		const a = paradisVoiceCacheKey({ provider: 'elevenlabs', voiceId: 'v', body: { text: 'x', model_id: 'm', voice_settings: { stability: 0.5, speed: 1 } } });
		const b = paradisVoiceCacheKey({ body: { voice_settings: { speed: 1, stability: 0.5 }, model_id: 'm', text: 'x' }, voiceId: 'v', provider: 'elevenlabs' });
		const c = paradisVoiceCacheKey({ provider: 'elevenlabs', voiceId: 'v', body: { text: 'x', model_id: 'm', voice_settings: { stability: 0.6, speed: 1 } } });
		assert.deepStrictEqual({ same: a === b, differs: a !== c, hex: /^[0-9a-f]{64}$/.test(a) }, { same: true, differs: true, hex: true });
	});

	test('stores a fully read synthesis and returns it on the next lookup', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('hello');
		const first = await synthesize(cache, key, mp3(1, 2));
		await settled(key);
		const second = await cache.lookup(key);

		assert.deepStrictEqual({ first, second: second.kind, audio: second.kind === 'hit' ? [...second.audio] : undefined }, {
			first: 'miss',
			second: 'hit',
			audio: [0xff, 0xfb, 0x90, 0x00, 1, 2],
		});
	});

	test('does not store a synthesis that was cut off, released or not an MP3', async () => {
		const cache = create();
		const cut = paradisVoiceCacheKey('cut');
		const cutLookup = await cache.lookup(cut);
		await assert.rejects(cutLookup.kind === 'miss' ? paradisCollectBody(cutLookup.lease.capture(failingAfter(mp3())), 1024) : Promise.resolve());
		const released = paradisVoiceCacheKey('released');
		const releasedLookup = await cache.lookup(released);
		if (releasedLookup.kind === 'miss') {
			releasedLookup.lease.release();
		}
		const text = paradisVoiceCacheKey('text');
		const textLookup = await cache.lookup(text);
		if (textLookup.kind === 'miss') {
			await paradisCollectBody(textLookup.lease.capture(chunks(Buffer.from('{"detail":"oops"}'))), 1024);
		}
		await new Promise(resolve => setTimeout(resolve, 20));

		assert.deepStrictEqual({
			kinds: [(await cache.lookup(cut)).kind, (await cache.lookup(released)).kind, (await cache.lookup(text)).kind],
			files: readdirSync(cacheDir),
		}, { kinds: ['miss', 'miss', 'miss'], files: [] });
	});

	test('lets a concurrent lookup of the same key wait for the running synthesis instead of synthesizing again', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('same');
		const first = await cache.lookup(key);
		const waiting = cache.lookup(key);
		assert.strictEqual(first.kind, 'miss');
		if (first.kind === 'miss') {
			await paradisCollectBody(first.lease.capture(chunks(mp3(7), Uint8Array.of(8))), 1024);
		}
		const second = await waiting;
		assert.deepStrictEqual(second.kind === 'hit' ? [...second.audio] : second.kind, [0xff, 0xfb, 0x90, 0x00, 7, 8]);
		await settled(key);
	});

	test('stops waiting for a synthesis that never finishes', async () => {
		const cache = create({ inFlightTimeoutMs: 10 });
		const key = paradisVoiceCacheKey('stuck');
		const first = await cache.lookup(key);
		const second = await cache.lookup(key);
		assert.deepStrictEqual([first.kind, second.kind], ['miss', 'miss']);
		if (second.kind === 'miss') {
			second.lease.release();
		}
	});

	test('drops a broken or expired file and synthesizes again', async () => {
		const cache = create({ maxAgeMs: 1000 });
		const broken = paradisVoiceCacheKey('broken');
		writeFileSync(join(cacheDir, `${broken}.mp3`), 'not audio');
		const expired = paradisVoiceCacheKey('expired');
		writeFileSync(join(cacheDir, `${expired}.mp3`), mp3());
		utimesSync(join(cacheDir, `${expired}.mp3`), new Date(now - 5000), new Date(now - 5000));

		const kinds = [(await cache.lookup(broken)), (await cache.lookup(expired))];
		for (const found of kinds) {
			if (found.kind === 'miss') {
				found.lease.release();
			}
		}
		assert.deepStrictEqual({ kinds: kinds.map(found => found.kind), files: readdirSync(cacheDir) }, { kinds: ['miss', 'miss'], files: [] });
	});

	test('trims the least recently used entries over the count and size limits and old temporary files', async () => {
		const cache = create({ maxEntries: 2, maxBytes: 1024 });
		const keys = ['a', 'b', 'c'].map(paradisVoiceCacheKey);
		keys.forEach((key, index) => {
			writeFileSync(join(cacheDir, `${key}.mp3`), mp3(index));
			utimesSync(join(cacheDir, `${key}.mp3`), new Date(now - (10 - index) * 1000), new Date(now - (10 - index) * 1000));
		});
		// a を使ったので、いちばん古いのは b
		const used = await cache.lookup(keys[0]);
		const staleTemp = `${keys[2]}.0123-abcd.tmp`;
		writeFileSync(join(cacheDir, staleTemp), 'partial');
		utimesSync(join(cacheDir, staleTemp), new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000));
		await cache.prune();

		assert.deepStrictEqual({ used: used.kind, files: readdirSync(cacheDir).sort() }, { used: 'hit', files: [`${keys[0]}.mp3`, `${keys[2]}.mp3`].sort() });
	});

	test('clears the stored voices, keeps the counts, and reports both', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('counted');
		await synthesize(cache, key, mp3(1));
		await settled(key);
		cache.recordCall(5);
		cache.recordHit(5);
		cache.recordHit(5);
		const before = await cache.getInfo();
		await cache.clear();
		await cache.flushStats();
		const after = await cache.getInfo();

		const day = { date: '2026-10-09', hits: 2, hitCharacters: 10, calls: 1, callCharacters: 5 };
		assert.deepStrictEqual({ before, after, saved: JSON.parse(readFileSync(join(cacheDir, 'stats.json'), 'utf8')) }, {
			before: { entries: 1, bytes: 5, days: [day] },
			after: { entries: 0, bytes: 0, days: [day] },
			saved: { version: 1, days: [day] },
		});
	});

	test('starts the counts over when the saved counts are broken', async () => {
		writeFileSync(join(cacheDir, 'stats.json'), '{broken');
		const cache = create();
		cache.recordCall(3);
		assert.deepStrictEqual((await cache.getInfo()).days, [{ date: '2026-10-09', hits: 0, hitCharacters: 0, calls: 1, callCharacters: 3 }]);
	});
});
