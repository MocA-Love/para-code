// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** PCにFS表示結果のSHA-256条件付き応答を明示交渉するencoding名。 */
export const CONTENT_HASH_ENCODING = 'content-hash-v1';

/** 応答待ちリクエストも参照できる不変キャッシュエントリ。 */
export interface ContentHashCacheEntry {
	readonly hash: string;
	/** 値の JSON。読み出すたびに parse して、呼び出し側が手を入れてもキャッシュが変わらないようにする。 */
	readonly json: string;
	readonly weight: number;
}

/** 送信時点の条件付きリクエストとキャッシュ値。 */
export interface PreparedContentHashRequest {
	readonly fields: { readonly cacheEncoding: typeof CONTENT_HASH_ENCODING; readonly ifContentHash?: string };
	/** 応答待ち中のLRU追い出しに影響されない不変スナップショット。 */
	readonly cached?: ContentHashCacheEntry;
}

/** 条件付き応答の復元結果。 */
export type ContentHashResolution =
	| { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
	| { readonly ok: false; readonly error: string };

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** read/xlsxのみを保持する上限付きメモリLRU。 */
export class ContentHashResponseCache {
	private readonly entries = new Map<string, ContentHashCacheEntry>();
	private totalWeight = 0;
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly maxEntryBytes: number;

	constructor(options: { readonly maxEntries?: number; readonly maxBytes?: number; readonly maxEntryBytes?: number } = {}) {
		this.maxEntries = options.maxEntries ?? 8;
		this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
		this.maxEntryBytes = options.maxEntryBytes ?? 8 * 1024 * 1024;
	}

	prepare(key: string): PreparedContentHashRequest {
		const cached = this.entries.get(key);
		if (cached !== undefined) {
			// Mapの末尾を最近使用とする。
			this.entries.delete(key);
			this.entries.set(key, cached);
		}
		return {
			fields: {
				cacheEncoding: CONTENT_HASH_ENCODING,
				...(cached !== undefined ? { ifContentHash: cached.hash } : {}),
			},
			...(cached !== undefined ? { cached } : {}),
		};
	}

	/**
	 * `sourceLength` は応答の JSON の文字数（分かれば）。入る上限を超える大きさなら、値を JSON に直さずに済ませる
	 * （大きなファイルほど直列化が重く、しかもキャッシュには入らない）。
	 */
	resolve(key: string, prepared: PreparedContentHashRequest, response: unknown, sourceLength?: number): ContentHashResolution {
		if (response === null || typeof response !== 'object' || Array.isArray(response)) {
			return { ok: false, error: 'invalid content hash response' };
		}
		const raw = response as Record<string, unknown>;
		if (raw['notModified'] === true) {
			const hash = raw['contentHash'];
			if (typeof hash !== 'string' || !SHA256_HEX.test(hash) || prepared.cached === undefined || prepared.cached.hash !== hash) {
				return { ok: false, error: 'content hash cache mismatch' };
			}
			const value = JSON.parse(prepared.cached.json) as Record<string, unknown>;
			if (typeof raw['id'] === 'string') {
				value['id'] = raw['id'];
			}
			return { ok: true, value };
		}
		const hash = raw['contentHash'];
		if (hash === undefined) {
			// 旧PCの従来応答。キャッシュは変更せずそのまま解決する。
			return { ok: true, value: raw };
		}
		if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
			return { ok: false, error: 'invalid content hash response' };
		}
		const value = { ...raw };
		delete value['contentHash'];
		this.delete(key);
		if (this.maxEntries > 0 && !this.overLimit((sourceLength ?? 0) * 2)) {
			const json = JSON.stringify(value);
			const weight = json.length * 2;
			if (!this.overLimit(weight)) {
				this.entries.set(key, { hash, json, weight });
				this.totalWeight += weight;
				this.evictToLimits();
			}
		}
		return { ok: true, value };
	}

	clear(): void {
		this.entries.clear();
		this.totalWeight = 0;
	}

	private overLimit(weight: number): boolean {
		return weight > this.maxEntryBytes || weight > this.maxBytes;
	}

	private delete(key: string): void {
		const existing = this.entries.get(key);
		if (existing !== undefined) {
			this.entries.delete(key);
			this.totalWeight -= existing.weight;
		}
	}

	private evictToLimits(): void {
		while (this.entries.size > this.maxEntries || this.totalWeight > this.maxBytes) {
			const oldestKey = this.entries.keys().next().value as string | undefined;
			if (oldestKey === undefined) {
				break;
			}
			this.delete(oldestKey);
		}
	}
}
