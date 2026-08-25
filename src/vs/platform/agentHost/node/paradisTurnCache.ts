/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../base/common/buffer.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { IFileService } from '../../files/common/files.js';
import { ISessionDataService } from '../common/sessionDataService.js';
import type { Turn } from '../common/state/sessionState.js';

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILENAME = 'paradisTurns.json';
/** Entries larger than this are not worth caching: the write cost eats into the read savings. */
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

/** Identifies which provider-side transcript a cache entry belongs to. */
export interface IParadisTurnCacheKey {
	readonly id: string;
	readonly routing: string;
}

/**
 * Cheap-to-obtain fingerprint of the on-disk transcript a cached entry was
 * built from. A cache hit requires an exact match on both fields, so the
 * caller only needs a `stat`-grade fingerprint — never a full read — to
 * validate a cache lookup.
 */
export interface IParadisTurnCacheStamp {
	readonly size: number;
	readonly mtimeMs: number;
}

interface IParadisTurnCacheFile {
	readonly v: number;
	readonly fmt: string;
	readonly key: IParadisTurnCacheKey;
	readonly stamp: IParadisTurnCacheStamp;
	readonly turns: readonly Turn[];
}

/**
 * Disk-backed cache of reconstructed {@link Turn} transcripts, keyed by
 * provider session/thread id + routing chat. Exists to skip the SDK/app-server
 * round trip (and its full-transcript read) when re-opening a chat whose
 * backing file has not changed since it was last reconstructed.
 *
 * Deliberately disk-only — never held in memory beyond a single read/write —
 * so it cannot grow the process's steady-state RAM footprint. Every failure
 * mode (missing file, corrupt JSON, schema drift, stamp mismatch) resolves to
 * a plain cache miss; callers always have the full reconstruction path as a
 * fallback and must use it on a miss.
 *
 * Plain `JSON.stringify`/`JSON.parse` round-trip the entry: every `URI` field
 * on the protocol {@link Turn} type (see `protocol/common/state.ts`) is a
 * plain string, not a `URI` class instance, so there is nothing to revive.
 */
export class ParadisTurnCache {

	private readonly _writeQueue = new Map<string, Promise<void>>();

	constructor(
		/** Bump whenever the replay mapper's output shape changes, so stale entries miss instead of rendering a malformed transcript. */
		private readonly _formatVersion: string,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async read(routingUri: URI, key: IParadisTurnCacheKey, stamp: IParadisTurnCacheStamp): Promise<readonly Turn[] | undefined> {
		try {
			const content = await this._fileService.readFile(this._cacheFile(routingUri), { limits: { size: MAX_CACHE_BYTES } });
			const parsed = JSON.parse(content.value.toString()) as Partial<IParadisTurnCacheFile>;
			if (!this._isValidEntry(parsed, key, stamp)) {
				return undefined;
			}
			return parsed.turns;
		} catch {
			// Missing file, unreadable JSON, oversized file, or a shape we
			// don't recognize — all equally "no usable cache", never a hard failure.
			return undefined;
		}
	}

	/** Fire-and-forget; per-routing writes are serialized so a slow write can't race a newer one. */
	write(routingUri: URI, key: IParadisTurnCacheKey, stamp: IParadisTurnCacheStamp, turns: readonly Turn[]): void {
		const dirKey = routingUri.toString();
		const previous = this._writeQueue.get(dirKey) ?? Promise.resolve();
		const next = previous
			.then(() => this._doWrite(routingUri, key, stamp, turns))
			.catch(err => this._logService.warn(`[ParadisTurnCache] write failed for ${dirKey}`, err));
		this._writeQueue.set(dirKey, next);
		void next.finally(() => {
			if (this._writeQueue.get(dirKey) === next) {
				this._writeQueue.delete(dirKey);
			}
		});
	}

	/** Resolves once every write queued so far has landed (or failed). Lets shutdown drain, and tests assert deterministically instead of sleeping. */
	async whenIdle(): Promise<void> {
		while (this._writeQueue.size > 0) {
			await Promise.all(this._writeQueue.values());
		}
	}

	private async _doWrite(routingUri: URI, key: IParadisTurnCacheKey, stamp: IParadisTurnCacheStamp, turns: readonly Turn[]): Promise<void> {
		// Filter on the known transcript size first: building the JSON for an
		// entry we're about to discard would burn a full extra copy of it.
		if (stamp.size > MAX_CACHE_BYTES) {
			this._logService.trace(`[ParadisTurnCache] skipping write for ${key.id}: transcript is ${stamp.size} bytes`);
			return;
		}
		const entry: IParadisTurnCacheFile = { v: CACHE_SCHEMA_VERSION, fmt: this._formatVersion, key, stamp, turns };
		const json = JSON.stringify(entry);
		if (json.length > MAX_CACHE_BYTES) {
			this._logService.trace(`[ParadisTurnCache] skipping write for ${key.id}: serialized entry is ${json.length} bytes`);
			return;
		}
		await this._fileService.createFolder(this._sessionDataService.getSessionDataDir(routingUri));
		// Not atomic: this is a best-effort cache, and a torn write just fails
		// JSON.parse on the next read, which `read()` already treats as a miss.
		await this._fileService.writeFile(this._cacheFile(routingUri), VSBuffer.fromString(json));
	}

	private _cacheFile(routingUri: URI): URI {
		return URI.joinPath(this._sessionDataService.getSessionDataDir(routingUri), CACHE_FILENAME);
	}

	private _isValidEntry(parsed: Partial<IParadisTurnCacheFile>, key: IParadisTurnCacheKey, stamp: IParadisTurnCacheStamp): parsed is IParadisTurnCacheFile {
		return parsed.v === CACHE_SCHEMA_VERSION
			&& parsed.fmt === this._formatVersion
			&& !!parsed.key && parsed.key.id === key.id && parsed.key.routing === key.routing
			&& !!parsed.stamp && parsed.stamp.size === stamp.size && parsed.stamp.mtimeMs === stamp.mtimeMs
			&& Array.isArray(parsed.turns);
	}
}
