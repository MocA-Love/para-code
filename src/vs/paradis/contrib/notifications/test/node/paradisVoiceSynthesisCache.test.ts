/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisBufferBody, paradisCollectBody } from '../../node/paradisStreamingBody.js';
import { IParadisVoiceSynthesisCacheOptions, paradisVoiceCacheKey, ParadisVoiceCacheLookup, ParadisVoiceSynthesisCache } from '../../node/paradisVoiceSynthesisCache.js';

const DAY = 86_400_000;

/** MP3 のフレームの頭に見える、下限（1KiB）より大きい音声。`tag` で中身を見分ける。 */
function mp3(tag: number, size = 1100): Buffer {
	const audio = Buffer.alloc(size, tag);
	audio.set([0xff, 0xfb, 0x90, 0x00]);
	return audio;
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

function tagOf(found: ParadisVoiceCacheLookup): number | string {
	return found.kind === 'hit' ? found.audio[10] : found.kind;
}

/** 鍵の音声を合成したことにして置く（miss の持ち分で本文を最後まで読む）。 */
async function synthesize(cache: ParadisVoiceSynthesisCache, key: string, audio: Buffer, refresh = false): Promise<ParadisVoiceCacheLookup['kind']> {
	const found = await cache.lookup(key, { refresh });
	if (found.kind === 'miss') {
		await paradisCollectBody(found.lease.capture(paradisBufferBody(audio)), 1024 * 1024);
	}
	return found.kind;
}

let cacheDir: string;

function entries(dir = cacheDir): string[] {
	return readdirSync(dir).filter(name => name.endsWith('.mp3')).sort();
}

/** 書き込み（rename と同じ鍵の古い音の片付けまで）が終わるのを待つ。 */
async function settled(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (predicate()) {
			await new Promise(resolve => setTimeout(resolve, 20));
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error('not settled');
}

function place(key: string, createdMs: number, audio: Buffer, usedMs = createdMs): string {
	const name = `${key}.${createdMs}.mp3`;
	writeFileSync(join(cacheDir, name), audio);
	utimesSync(join(cacheDir, name), new Date(usedMs), new Date(usedMs));
	return name;
}

suite('ParadisVoiceSynthesisCache', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let now = Date.UTC(2026, 9, 9, 12);

	setup(() => {
		cacheDir = mkdtempSync(join(tmpdir(), 'paradis-voice-cache-test-'));
		now = Date.UTC(2026, 9, 9, 12);
	});
	teardown(() => rmSync(cacheDir, { recursive: true, force: true }));

	function create(options: IParadisVoiceSynthesisCacheOptions = {}, dir = cacheDir): ParadisVoiceSynthesisCache {
		return store.add(new ParadisVoiceSynthesisCache(dir, new NullLogService(), { now: () => now, ...options }));
	}

	test('makes the same key for the same request regardless of property order, and a different key when anything differs', () => {
		const a = paradisVoiceCacheKey({ provider: 'elevenlabs', voiceId: 'v', body: { text: 'x', model_id: 'm', voice_settings: { stability: 0.5, speed: 1 } } });
		const b = paradisVoiceCacheKey({ body: { voice_settings: { speed: 1, stability: 0.5 }, model_id: 'm', text: 'x' }, voiceId: 'v', provider: 'elevenlabs' });
		const c = paradisVoiceCacheKey({ provider: 'elevenlabs', voiceId: 'v', body: { text: 'x', model_id: 'm', voice_settings: { stability: 0.6, speed: 1 } } });
		assert.deepStrictEqual({ same: a === b, differs: a !== c, hex: /^[0-9a-f]{64}$/.test(a) }, { same: true, differs: true, hex: true });
	});

	test('stores a fully read synthesis with its creation time, private file modes, and returns it on the next lookup', async () => {
		const dir = join(cacheDir, 'voice');
		const cache = create({}, dir);
		const key = paradisVoiceCacheKey('hello');
		const first = await synthesize(cache, key, mp3(1));
		await settled(() => { try { return entries(dir).length === 1; } catch { return false; } });
		const second = await cache.lookup(key);

		assert.deepStrictEqual({
			first,
			second: tagOf(second),
			files: entries(dir),
			dirMode: statSync(dir).mode & 0o777,
			fileMode: statSync(join(dir, entries(dir)[0])).mode & 0o777,
		}, {
			first: 'miss',
			second: 1,
			files: [`${key}.${now}.mp3`],
			dirMode: 0o700,
			fileMode: 0o600,
		});
	});

	test('does not store a synthesis that was cut off, released, not an MP3, too short for its text or too large', async () => {
		const cache = create({ maxEntryBytes: 4096 });
		const run = async (name: string, body: () => AsyncIterable<Uint8Array> | undefined, minBytes?: number) => {
			const found = await cache.lookup(paradisVoiceCacheKey(name), { minBytes });
			if (found.kind === 'miss') {
				const source = body();
				if (source) {
					await paradisCollectBody(found.lease.capture(source), 1024 * 1024).catch(() => undefined);
				} else {
					found.lease.release();
				}
			}
		};
		await run('cut', () => failingAfter(mp3(1)));
		await run('released', () => undefined);
		await run('text', () => chunks(Buffer.alloc(2000, 0x7b)));
		await run('short', () => chunks(mp3(2, 1100)), 3000);
		await run('large', () => chunks(mp3(3, 5000)));
		await new Promise(resolve => setTimeout(resolve, 30));

		const kinds = [];
		for (const name of ['cut', 'released', 'text', 'short', 'large']) {
			const found = await cache.lookup(paradisVoiceCacheKey(name));
			kinds.push(found.kind);
			if (found.kind === 'miss') {
				found.lease.release();
			}
		}
		assert.deepStrictEqual({ kinds, files: readdirSync(cacheDir) }, { kinds: ['miss', 'miss', 'miss', 'miss', 'miss'], files: [] });
	});

	test('lets a concurrent lookup of the same key wait for the running synthesis instead of synthesizing again', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('same');
		const first = await cache.lookup(key);
		const waiting = cache.lookup(key);
		assert.strictEqual(first.kind, 'miss');
		if (first.kind === 'miss') {
			const audio = mp3(7);
			await paradisCollectBody(first.lease.capture(chunks(audio.subarray(0, 500), audio.subarray(500))), 4096);
		}
		assert.strictEqual(tagOf(await waiting), 7);
		await settled(() => entries().length === 1);
	});

	test('hands the synthesis to a waiting lookup when the first one is released', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('released');
		const first = await cache.lookup(key);
		const waiting = cache.lookup(key);
		if (first.kind === 'miss') {
			first.lease.release();
		}
		const second = await waiting;
		const third = cache.lookup(key);
		if (second.kind === 'miss') {
			await paradisCollectBody(second.lease.capture(chunks(mp3(4))), 4096);
		}
		assert.deepStrictEqual([first.kind, second.kind, tagOf(await third)], ['miss', 'miss', 4]);
		await settled(() => entries().length === 1);
	});

	test('gives the same voice to a lookup that comes while the finished synthesis is still being written', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('writing');
		await synthesize(cache, key, mp3(5));
		// 本文は読み終えたが、まだ書き込み中（rename の前）
		const filesRightAfter = entries();
		const second = await cache.lookup(key);
		await settled(() => entries().length === 1);

		assert.deepStrictEqual({ filesRightAfter, second: tagOf(second) }, { filesRightAfter: [], second: 5 });
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

	test('expires a voice a fixed time after it was made, however often it is used', async () => {
		const cache = create({ maxAgeMs: 10 * DAY });
		const key = paradisVoiceCacheKey('aging');
		place(key, now - 9 * DAY, mp3(6));
		const young = await cache.lookup(key);
		now += 2 * DAY;
		const old = await cache.lookup(key);
		if (old.kind === 'miss') {
			old.lease.release();
		}
		assert.deepStrictEqual({ young: tagOf(young), old: old.kind, files: entries() }, { young: 6, old: 'miss', files: [] });
	});

	test('drops a file of the wrong size or not an MP3, but keeps one it could not read', async () => {
		const cache = create();
		const broken = paradisVoiceCacheKey('broken');
		place(broken, now, Buffer.alloc(2000, 0x41));
		const tiny = paradisVoiceCacheKey('tiny');
		place(tiny, now, mp3(1, 100));
		const locked = paradisVoiceCacheKey('locked');
		const lockedName = place(locked, now, mp3(1));
		chmodSync(join(cacheDir, lockedName), 0o000);
		try {
			const kinds = [await cache.lookup(broken), await cache.lookup(tiny), await cache.lookup(locked)];
			for (const found of kinds) {
				if (found.kind === 'miss') {
					found.lease.release();
				}
			}
			assert.deepStrictEqual({ kinds: kinds.map(found => found.kind), files: entries() }, { kinds: ['miss', 'miss', 'miss'], files: [lockedName] });
		} finally {
			chmodSync(join(cacheDir, lockedName), 0o600);
		}
	});

	test('trims expired, replaced and least recently used entries over the limits, and old temporary files', async () => {
		const cache = create({ maxEntries: 2, maxBytes: 1024 * 1024, maxAgeMs: 10 * DAY });
		const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(paradisVoiceCacheKey);
		const aName = place(a, now - 3 * DAY, mp3(1), now - 10_000);
		place(b, now - 3 * DAY, mp3(2), now - 9_000);
		const cName = place(c, now - 3 * DAY, mp3(3), now - 8_000);
		place(c, now - 4 * DAY, mp3(3), now - 7_000); // 同じ鍵の古い音
		place(d, now - 11 * DAY, mp3(4), now); // 期限切れ
		// a を使ったので、上限で消えるのは b
		const used = await cache.lookup(a);
		const staleTemp = `${c}.0123-abcd.tmp`;
		writeFileSync(join(cacheDir, staleTemp), 'partial');
		utimesSync(join(cacheDir, staleTemp), new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000));
		const info = await cache.getInfo();

		assert.deepStrictEqual({ used: tagOf(used), files: readdirSync(cacheDir).sort(), entries: info.entries }, { used: 1, files: [aName, cName].sort(), entries: 2 });
	});

	test('re-synthesizes on refresh and replaces the stored voice of the same key', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('refresh');
		place(key, now - DAY, mp3(1));
		const kind = await synthesize(cache, key, mp3(2), true);
		await settled(() => entries().length === 1 && entries()[0] === `${key}.${now}.mp3`);
		assert.deepStrictEqual({ kind, next: tagOf(await cache.lookup(key)) }, { kind: 'miss', next: 2 });
	});

	test('keeps the newer voice when two writes of the same key finish at almost the same time', async () => {
		const cache = create({ inFlightTimeoutMs: 1 });
		const key = paradisVoiceCacheKey('twice');
		const first = await cache.lookup(key);
		await new Promise(resolve => setTimeout(resolve, 10)); // 先の合成を待つのをやめさせる
		const second = await cache.lookup(key);
		assert.deepStrictEqual([first.kind, second.kind], ['miss', 'miss']);
		const startedAt = now;
		if (first.kind === 'miss' && second.kind === 'miss') {
			await paradisCollectBody(first.lease.capture(chunks(mp3(1))), 4096);
			now += 1;
			await paradisCollectBody(second.lease.capture(chunks(mp3(2))), 4096);
		}
		await settled(() => entries().length === 1);
		assert.deepStrictEqual({ files: entries(), next: tagOf(await cache.lookup(key)) }, { files: [`${key}.${startedAt + 1}.mp3`], next: 2 });
	});

	test('does not let a synthesis that started before the test playback overwrite the re-synthesized voice', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('replay');
		const normal = await cache.lookup(key);
		const replay = await cache.lookup(key, { refresh: true });
		if (replay.kind === 'miss') {
			await paradisCollectBody(replay.lease.capture(chunks(mp3(9))), 4096);
		}
		await settled(() => entries().length === 1);
		now += 1000;
		if (normal.kind === 'miss') {
			await paradisCollectBody(normal.lease.capture(chunks(mp3(1))), 4096);
		}
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual({ files: entries(), next: tagOf(await cache.lookup(key)) }, { files: [`${key}.${now - 1000}.mp3`], next: 9 });
	});

	test('removes files from the first version without a creation time, and narrows an existing folder to the owner', async () => {
		const dir = join(cacheDir, 'voice');
		mkdirSync(dir, { mode: 0o755 });
		chmodSync(dir, 0o755);
		const legacy = paradisVoiceCacheKey('legacy');
		writeFileSync(join(dir, `${legacy}.mp3`), mp3(1));
		writeFileSync(join(dir, `${paradisVoiceCacheKey('other')}.mp3`), mp3(2));
		const cache = create({}, dir);
		await synthesize(cache, legacy, mp3(3));
		const written = `${legacy}.${now}.mp3`;
		await settled(() => entries(dir).includes(written) && !entries(dir).includes(`${legacy}.mp3`));
		const info = await cache.getInfo();
		const afterPrune = entries(dir);
		writeFileSync(join(dir, `${legacy}.mp3`), mp3(1));
		await cache.clear();

		assert.deepStrictEqual({ afterPrune, info: info.entries, afterClear: entries(dir), dirMode: statSync(dir).mode & 0o777 }, {
			afterPrune: [written],
			info: 1,
			afterClear: [],
			dirMode: 0o700,
		});
	});

	test('treats a voice made in the future (the clock went back) as expired', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('future');
		place(key, now + 3600_000, mp3(1));
		const other = paradisVoiceCacheKey('future-other');
		place(other, now + 3600_000, mp3(2));
		const found = await cache.lookup(key);
		if (found.kind === 'miss') {
			found.lease.release();
		}
		const info = await cache.getInfo();
		assert.deepStrictEqual({ found: found.kind, entries: info.entries, files: entries() }, { found: 'miss', entries: 0, files: [] });
	});

	test('does not keep a synthesis that finished while the cache was being cleared', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('cleared');
		const found = await cache.lookup(key);
		await cache.clear();
		if (found.kind === 'miss') {
			await paradisCollectBody(found.lease.capture(chunks(mp3(1))), 4096);
		}
		await new Promise(resolve => setTimeout(resolve, 50));
		const after = await cache.lookup(key);
		if (after.kind === 'miss') {
			after.lease.release();
		}
		assert.deepStrictEqual({ files: entries(), after: after.kind }, { files: [], after: 'miss' });
	});

	test('clears the stored voices, keeps the counts, and reports both', async () => {
		const cache = create();
		const key = paradisVoiceCacheKey('counted');
		await synthesize(cache, key, mp3(1));
		await settled(() => entries().length === 1);
		cache.recordCall(5);
		cache.recordHit(5);
		cache.recordHit(5);
		const before = await cache.getInfo();
		await cache.clear();
		await cache.flushStats();
		const after = await cache.getInfo();

		const day = { date: '2026-10-09', hits: 2, hitCharacters: 10, calls: 1, callCharacters: 5 };
		assert.deepStrictEqual({ before, after, saved: JSON.parse(readFileSync(join(cacheDir, 'stats.json'), 'utf8')), statsMode: statSync(join(cacheDir, 'stats.json')).mode & 0o777 }, {
			before: { entries: 1, bytes: 1100, days: [day] },
			after: { entries: 0, bytes: 0, days: [day] },
			saved: { version: 1, days: [day] },
			statsMode: 0o600,
		});
	});

	test('writes the pending counts synchronously when disposed', async () => {
		const cache = create();
		cache.recordCall(3);
		await cache.getInfo(); // 数え終える（書き出しは 2 秒後の予定のまま）
		cache.dispose();
		assert.deepStrictEqual(JSON.parse(readFileSync(join(cacheDir, 'stats.json'), 'utf8')), { version: 1, days: [{ date: '2026-10-09', hits: 0, hitCharacters: 0, calls: 1, callCharacters: 3 }] });
	});

	test('starts the counts over when the saved counts are broken', async () => {
		writeFileSync(join(cacheDir, 'stats.json'), '{broken');
		const cache = create();
		cache.recordCall(3);
		assert.deepStrictEqual((await cache.getInfo()).days, [{ date: '2026-10-09', hits: 0, hitCharacters: 0, calls: 1, callCharacters: 3 }]);
	});
});
