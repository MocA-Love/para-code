/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の読み上げ（ElevenLabs）で合成した音声を、合成する手元のディスク（`~/.para-code/cache/voice/`）に置いて使い回す。
// 通知の文面は「{space}です」のように同じスペース・同じ出来事なら毎回同じなので、同じ要求を毎回合成させない。
//
// - 鍵は合成の要求そのもの（声・出力形式・要求の本文 = 文・モデル・voice_settings・発音辞書の ID と版）を並べ替えた JSON の
//   SHA-256。合成の結果を変えうるものは全部本文に入っているので、本文が同じなら同じ音になる。音量の補正は鳴らすときに
//   かけているので鍵に入れない。前の発話の文脈（previous_text / previous_request_ids）は通知では送らない
// - 1 件 1 ファイル（`<鍵>.mp3`）。書くときは一時ファイルに書いてから rename する（途中で落ちても壊れたファイルを残さない）。
//   使ったら更新時刻を今にし、件数・合計サイズ・最後に使ってからの日数の上限を超えたら古い順に消す
// - 読めない・MP3 に見えない・大きすぎるファイルは消して、合成し直す
// - 同じ鍵の合成が進行中なら、それが読み終わるのを待って同じ音を使う（同時に同じ文を 2 回合成させない）
// - キャッシュから鳴らした回数と API で合成した回数を日別に数える（設定画面の「使用量」に出す）

import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'fs/promises';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisLooksLikeMp3 } from '../common/paradisMyinstants.js';
import {
	IParadisVoiceCacheDay,
	IParadisVoiceCacheInfo,
	paradisAddVoiceCacheCount,
	paradisParseVoiceCacheDays,
	paradisStableStringify,
} from '../common/paradisVoiceCache.js';

/** 件数の上限。通知の声 1 件は数十 KB。 */
const DEFAULT_MAX_ENTRIES = 500;
/** 合計サイズの上限。 */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** 最後に使ってからこれだけ経った音声は消す。 */
const DEFAULT_MAX_AGE_MS = 30 * 86_400_000;
/** 1 件の上限（これより大きい音声は置かない・読まない）。 */
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
/** 同じ鍵の合成を待つ上限。読まれないまま捨てられた合成があっても、後の要求を止め続けない。 */
const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 20_000;
/** 書きかけの一時ファイルを掃除するまでの時間。 */
const TEMP_FILE_MAX_AGE_MS = 60 * 60_000;
/** 日別の数を書き出すまで待つ時間（続けて鳴ったときにまとめて書く）。 */
const STATS_WRITE_DELAY_MS = 2_000;

const ENTRY_PATTERN = /^[0-9a-f]{64}\.mp3$/;
const TEMP_PATTERN = /^(?:[0-9a-f]{64}|stats\.json)\.[0-9a-f-]+\.tmp$/;
const STATS_FILE = 'stats.json';

export interface IParadisVoiceSynthesisCacheOptions {
	readonly maxEntries?: number;
	readonly maxBytes?: number;
	readonly maxAgeMs?: number;
	readonly maxEntryBytes?: number;
	readonly inFlightTimeoutMs?: number;
	readonly now?: () => number;
}

/** 合成を任された要求の持ち分。合成の本文を {@link capture} で包むか、合成できなければ {@link release} する。 */
export interface IParadisVoiceCacheLease {
	/** 合成の本文を包む。最後まで読まれたら置く。途中で切れた・読まれなかったら置かない。 */
	capture(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array>;
	/** 合成できなかった。同じ鍵を待っている要求は自分で合成する。 */
	release(): void;
}

export type ParadisVoiceCacheLookup =
	| { readonly kind: 'hit'; readonly audio: Buffer }
	| { readonly kind: 'miss'; readonly lease: IParadisVoiceCacheLease };

interface IInFlight {
	readonly promise: Promise<Buffer | undefined>;
	settle(audio: Buffer | undefined): void;
}

/** 合成の要求から鍵を作る。 */
export function paradisVoiceCacheKey(parts: unknown): string {
	return createHash('sha256').update(paradisStableStringify(parts)).digest('hex');
}

export class ParadisVoiceSynthesisCache extends Disposable {

	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly maxAgeMs: number;
	private readonly maxEntryBytes: number;
	private readonly inFlightTimeoutMs: number;
	private readonly now: () => number;

	private readonly _inFlight = new Map<string, IInFlight>();
	/** clear() のたびに増やす。消す前に始めた合成は、消した後に書き込まない。 */
	private _generation = 0;
	private _pruning: Promise<void> | undefined;
	private _prunePending = false;

	private _days: IParadisVoiceCacheDay[] | undefined;
	private _statsQueue: Promise<void> = Promise.resolve();
	private _statsTimer: ReturnType<typeof setTimeout> | undefined;
	private _statsDirty = false;

	constructor(
		private readonly dir: string,
		private readonly logService: ILogService,
		options: IParadisVoiceSynthesisCacheOptions = {},
	) {
		super();
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
		this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
		this.inFlightTimeoutMs = options.inFlightTimeoutMs ?? DEFAULT_IN_FLIGHT_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
	}

	override dispose(): void {
		for (const inFlight of [...this._inFlight.values()]) {
			inFlight.settle(undefined);
		}
		if (this._statsTimer !== undefined) {
			clearTimeout(this._statsTimer);
			this._statsTimer = undefined;
		}
		if (this._statsDirty && this._days !== undefined) {
			// 終了の間際。待てないので同期で書く（書けなくても読み上げには関係ない）
			try {
				writeFileSync(join(this.dir, STATS_FILE), JSON.stringify({ version: 1, days: this._days }));
			} catch {
				// ignore
			}
		}
		super.dispose();
	}

	/**
	 * 鍵の音声を探す。同じ鍵の合成が進行中なら、その読み終わりを待つ。無ければ、この要求が合成を任される（miss）。
	 * ディスクの失敗は投げず、無かったことにする。
	 */
	async lookup(key: string): Promise<ParadisVoiceCacheLookup> {
		// 待っていた合成が失敗したら、別の待ち手が先に合成を始めているかもしれないので、もう一度だけ見る
		for (let attempt = 0; attempt < 2; attempt++) {
			const inFlight = this._inFlight.get(key);
			if (!inFlight) {
				break;
			}
			const audio = await inFlight.promise;
			if (audio) {
				return { kind: 'hit', audio };
			}
		}
		const stored = await this._read(key);
		if (stored) {
			return { kind: 'hit', audio: stored };
		}
		// 読んでいる間に、同じ鍵の合成が始まっていたらそれを待つ
		const started = this._inFlight.get(key);
		if (started) {
			const audio = await started.promise;
			if (audio) {
				return { kind: 'hit', audio };
			}
		}
		return { kind: 'miss', lease: this._claim(key) };
	}

	/** キャッシュから鳴らした（API に送らなかった）1 回を数える。 */
	recordHit(characters: number): void {
		this._count('hit', characters);
	}

	/** API で合成した 1 回を数える。 */
	recordCall(characters: number): void {
		this._count('call', characters);
	}

	/** 置いてある音声を全部消す（日別の数は残す）。 */
	async clear(): Promise<void> {
		this._generation++;
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return; // まだ何も置いていない
		}
		await Promise.all(names
			.filter(name => ENTRY_PATTERN.test(name) || TEMP_PATTERN.test(name))
			.map(name => unlink(join(this.dir, name)).catch(() => undefined)));
	}

	/** 置いてある件数・合計サイズと、日別の数。 */
	async getInfo(): Promise<IParadisVoiceCacheInfo> {
		const entries = await this._listEntries();
		const days = await this._withStats(days => days);
		return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), days };
	}

	private _path(key: string): string {
		return join(this.dir, `${key}.mp3`);
	}

	private async _read(key: string): Promise<Buffer | undefined> {
		if (!/^[0-9a-f]{64}$/.test(key)) {
			return undefined;
		}
		const path = this._path(key);
		let audio: Buffer;
		try {
			const info = await stat(path);
			if (this.now() - info.mtimeMs > this.maxAgeMs) {
				await unlink(path).catch(() => undefined);
				return undefined;
			}
			if (info.size === 0 || info.size > this.maxEntryBytes) {
				throw new Error(`unexpected size ${info.size}`);
			}
			audio = await readFile(path);
			if (!paradisLooksLikeMp3(audio)) {
				throw new Error('not an MP3');
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
				this.logService.warn(`[ParadisNotifications] dropped a broken cached voice: ${getErrorMessage(error)}`);
				await unlink(path).catch(() => undefined);
			}
			return undefined;
		}
		// 使った印（古い順に消すときの順番）
		const at = new Date(this.now());
		await utimes(path, at, at).catch(() => undefined);
		return audio;
	}

	private _claim(key: string): IParadisVoiceCacheLease {
		let resolve!: (audio: Buffer | undefined) => void;
		const promise = new Promise<Buffer | undefined>(r => { resolve = r; });
		let settled = false;
		const timer = setTimeout(() => settle(undefined), this.inFlightTimeoutMs);
		const inFlight: IInFlight = { promise, settle: audio => settle(audio) };
		const settle = (audio: Buffer | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (this._inFlight.get(key) === inFlight) {
				this._inFlight.delete(key);
			}
			resolve(audio);
		};
		this._inFlight.set(key, inFlight);
		const generation = this._generation;
		const store = (audio: Buffer) => this._write(key, audio, generation);
		const maxEntryBytes = this.maxEntryBytes;
		return {
			release: () => settle(undefined),
			capture: async function* (body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
				const chunks: Buffer[] = [];
				let size = 0;
				let completed = false;
				try {
					for await (const chunk of body) {
						if (size <= maxEntryBytes) {
							size += chunk.byteLength;
							chunks.push(Buffer.from(chunk));
						}
						yield chunk;
					}
					completed = true;
				} finally {
					const audio = completed && size > 0 && size <= maxEntryBytes ? Buffer.concat(chunks, size) : undefined;
					const usable = audio !== undefined && paradisLooksLikeMp3(audio) ? audio : undefined;
					settle(usable);
					if (usable) {
						void store(usable);
					}
				}
			},
		};
	}

	private async _write(key: string, audio: Buffer, generation: number): Promise<void> {
		if (generation !== this._generation || this._store.isDisposed) {
			return;
		}
		const temp = join(this.dir, `${key}.${generateUuid()}.tmp`);
		try {
			await mkdir(this.dir, { recursive: true });
			await writeFile(temp, audio);
			if (generation !== this._generation) {
				await unlink(temp).catch(() => undefined);
				return;
			}
			await rename(temp, this._path(key));
		} catch (error) {
			this.logService.warn(`[ParadisNotifications] could not cache the synthesized voice: ${getErrorMessage(error)}`);
			await unlink(temp).catch(() => undefined);
			return;
		}
		this._schedulePrune();
	}

	private _schedulePrune(): void {
		if (this._pruning) {
			this._prunePending = true;
			return;
		}
		this._pruning = this._prune()
			.catch(error => this.logService.warn(`[ParadisNotifications] could not trim the voice cache: ${getErrorMessage(error)}`))
			.finally(() => {
				this._pruning = undefined;
				if (this._prunePending && !this._store.isDisposed) {
					this._prunePending = false;
					this._schedulePrune();
				}
			});
	}

	/** 期限切れと上限を超えた分を、最後に使ったのが古い順に消す。書きかけの一時ファイルも掃除する。 */
	async prune(): Promise<void> {
		await this._prune();
	}

	private async _prune(): Promise<void> {
		const now = this.now();
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return;
		}
		for (const name of names.filter(candidate => TEMP_PATTERN.test(candidate))) {
			const path = join(this.dir, name);
			const info = await stat(path).catch(() => undefined);
			if (info && now - info.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
				await unlink(path).catch(() => undefined);
			}
		}
		const entries = await this._listEntries(names);
		const keep: typeof entries = [];
		const remove: typeof entries = [];
		let bytes = 0;
		for (const entry of [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
			if (now - entry.mtimeMs > this.maxAgeMs || keep.length >= this.maxEntries || bytes + entry.size > this.maxBytes) {
				remove.push(entry);
			} else {
				keep.push(entry);
				bytes += entry.size;
			}
		}
		await Promise.all(remove.map(entry => unlink(entry.path).catch(() => undefined)));
	}

	private async _listEntries(names?: readonly string[]): Promise<{ readonly path: string; readonly size: number; readonly mtimeMs: number }[]> {
		if (names === undefined) {
			try {
				names = await readdir(this.dir);
			} catch {
				return [];
			}
		}
		const entries = await Promise.all(names.filter(name => ENTRY_PATTERN.test(name)).map(async name => {
			const path = join(this.dir, name);
			const info = await stat(path).catch(() => undefined);
			return info?.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : undefined;
		}));
		return entries.filter((entry): entry is { readonly path: string; readonly size: number; readonly mtimeMs: number } => entry !== undefined);
	}

	// --- 日別の数 ---------------------------------------------------------------------------------

	private _count(kind: 'hit' | 'call', characters: number): void {
		void this._withStats(days => {
			this._days = paradisAddVoiceCacheCount(days, this.now(), kind, characters);
			this._statsDirty = true;
			this._scheduleStatsWrite();
			return this._days;
		});
	}

	/** 日別の数を（初回はファイルから読んでから）順番に触る。 */
	private _withStats<T>(use: (days: IParadisVoiceCacheDay[]) => T): Promise<T> {
		const result = this._statsQueue.then(async () => {
			if (this._days === undefined) {
				this._days = await readFile(join(this.dir, STATS_FILE), 'utf8')
					.then(text => paradisParseVoiceCacheDays((JSON.parse(text) as { days?: unknown }).days))
					.catch(() => []);
			}
			return use(this._days);
		});
		this._statsQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private _scheduleStatsWrite(): void {
		if (this._statsTimer !== undefined || this._store.isDisposed) {
			return;
		}
		this._statsTimer = setTimeout(() => {
			this._statsTimer = undefined;
			void this._flushStats();
		}, STATS_WRITE_DELAY_MS);
	}

	/** 日別の数を書き出す（テストからも呼ぶ）。 */
	async flushStats(): Promise<void> {
		if (this._statsTimer !== undefined) {
			clearTimeout(this._statsTimer);
			this._statsTimer = undefined;
		}
		await this._flushStats();
	}

	private async _flushStats(): Promise<void> {
		await this._withStats(async days => {
			if (!this._statsDirty) {
				return;
			}
			this._statsDirty = false;
			const temp = join(this.dir, `${STATS_FILE}.${generateUuid()}.tmp`);
			try {
				await mkdir(this.dir, { recursive: true });
				await writeFile(temp, JSON.stringify({ version: 1, days }));
				await rename(temp, join(this.dir, STATS_FILE));
			} catch (error) {
				this.logService.warn(`[ParadisNotifications] could not save the voice cache counts: ${getErrorMessage(error)}`);
				await unlink(temp).catch(() => undefined);
			}
		});
	}
}
