import { describe, expect, it } from 'vitest';
import { CONTENT_HASH_ENCODING, ContentHashResponseCache } from './contentHashCache.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

describe('ContentHashResponseCache', () => {
	it('prepares negotiation, stores a full response, and reconstructs a matched response with the current id', () => {
		const cache = new ContentHashResponseCache();
		const first = cache.prepare('read:w:p:1');
		expect(first.fields).toEqual({ cacheEncoding: CONTENT_HASH_ENCODING });
		expect(cache.resolve('read:w:p:1', first, { id: 'r1', t: 'read', content: '日本🙂', size: 10, truncated: false, contentHash: HASH_A })).toEqual({
			ok: true, value: { id: 'r1', t: 'read', content: '日本🙂', size: 10, truncated: false },
		});

		const second = cache.prepare('read:w:p:1');
		expect(second.fields).toEqual({ cacheEncoding: CONTENT_HASH_ENCODING, ifContentHash: HASH_A });
		expect(cache.resolve('read:w:p:1', second, { id: 'r2', t: 'read', notModified: true, contentHash: HASH_A })).toEqual({
			ok: true, value: { id: 'r2', t: 'read', content: '日本🙂', size: 10, truncated: false },
		});
	});

	it('rejects a matched response without the exact pending snapshot and accepts legacy full responses', () => {
		const cache = new ContentHashResponseCache();
		const empty = cache.prepare('xlsx:w:p:0');
		expect(cache.resolve('xlsx:w:p:0', empty, { id: 'r1', t: 'xlsx', notModified: true, contentHash: HASH_A })).toEqual({ ok: false, error: 'content hash cache mismatch' });
		expect(cache.resolve('xlsx:w:p:0', empty, { id: 'r2', t: 'xlsx', html: '<table />' })).toEqual({ ok: true, value: { id: 'r2', t: 'xlsx', html: '<table />' } });
		expect(cache.prepare('xlsx:w:p:0').fields).toEqual({ cacheEncoding: CONTENT_HASH_ENCODING });
	});

	it('rejects malformed hashes and updates the cache on a changed full response', () => {
		const cache = new ContentHashResponseCache();
		const first = cache.prepare('read:w:p:0');
		expect(cache.resolve('read:w:p:0', first, { id: 'r1', t: 'read', content: 'a', contentHash: 'bad' })).toEqual({ ok: false, error: 'invalid content hash response' });
		expect(cache.resolve('read:w:p:0', first, { id: 'r2', t: 'read', content: 'a', contentHash: HASH_A }).ok).toBe(true);
		const prepared = cache.prepare('read:w:p:0');
		expect(cache.resolve('read:w:p:0', prepared, { id: 'r3', t: 'read', content: 'b', contentHash: HASH_B }).ok).toBe(true);
		expect(cache.prepare('read:w:p:0').fields.ifContentHash).toBe(HASH_B);
	});

	it('bounds memory with LRU eviction and skips oversized entries', () => {
		const cache = new ContentHashResponseCache({ maxEntries: 2, maxBytes: 2_000, maxEntryBytes: 1_000 });
		for (const [key, hash] of [['a', HASH_A], ['b', HASH_B]] as const) {
			const prepared = cache.prepare(key);
			expect(cache.resolve(key, prepared, { id: key, t: 'read', content: key, contentHash: hash }).ok).toBe(true);
		}
		cache.prepare('a');
		const third = cache.prepare('c');
		expect(cache.resolve('c', third, { id: 'c', t: 'read', content: 'c', contentHash: HASH_C }).ok).toBe(true);
		expect(cache.prepare('a').fields.ifContentHash).toBe(HASH_A);
		expect(cache.prepare('b').fields.ifContentHash).toBeUndefined();
		const pendingA = cache.prepare('a');
		for (const key of ['d', 'e']) {
			const prepared = cache.prepare(key);
			expect(cache.resolve(key, prepared, { id: key, t: 'read', content: key, contentHash: key.repeat(64) }).ok).toBe(true);
		}
		expect(cache.prepare('a').fields.ifContentHash).toBeUndefined();
		expect(cache.resolve('a', pendingA, { id: 'a-new', t: 'read', notModified: true, contentHash: HASH_A })).toEqual({ ok: true, value: { id: 'a-new', t: 'read', content: 'a' } });
		cache.clear();
		expect(cache.prepare('e').fields.ifContentHash).toBeUndefined();

		const oversized = new ContentHashResponseCache({ maxEntries: 2, maxBytes: 100, maxEntryBytes: 50 });
		const request = oversized.prepare('large');
		expect(oversized.resolve('large', request, { id: 'large', t: 'read', content: 'x'.repeat(100), contentHash: HASH_A }).ok).toBe(true);
		expect(oversized.prepare('large').fields.ifContentHash).toBeUndefined();
	});
});
