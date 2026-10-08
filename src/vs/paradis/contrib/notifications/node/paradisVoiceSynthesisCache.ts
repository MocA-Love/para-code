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
//   SHA-256。音量の補正は鳴らすときにかけているので鍵に入れない。前の発話の文脈（previous_text / previous_request_ids）は
//   通知では送らない
// - 1 件 1 ファイル（`<鍵>.<作った時刻 ms>.mp3`）。一時ファイルに書いてから rename する（途中で落ちても壊れたファイルを残さない）
// - 期限は作ってから {@link DEFAULT_MAX_AGE_MS}（使っても延びない）。鍵に表れない ElevenLabs 側の変化（声に保存した設定・声の
//   作り直し・同じ model_id の中身の更新）や、たまたま崩れた 1 回の音を固定し続けないため。上限（件数・合計サイズ）を超えたら、
//   最後に使ったのが古い順（更新時刻。使うたびに今にする）に消す
// - 大きさがおかしい・MP3 に見えないファイルは消して合成し直す。読み取りの I/O の失敗は消さずに外れとして扱う
// - 同じ鍵の合成が進行中なら、それが読み終わるのを待って同じ音を使う（同時に同じ文を 2 回合成させない）。書き終わるまでは
//   進行中の印を残し、その間に来た同じ文にも同じ音を渡す
// - キャッシュから鳴らした回数と API で合成した回数を日別に数える（設定画面の「使用量」に出す）
//
// 既知の制限: 日別の数（stats.json）は Para Code を 2 つ同時に動かすと、後から書いた方の数で上書きされる。

import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'fs/promises';
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
/**
 * 作ってからの期限（使っても延びない）。ElevenLabs 側で声を直したり、同じ model_id の中身が更新されたりしても、この日数で
 * 合成し直す。毎日鳴る通知でも 10 日に 1 回の合成で済むので、節約はほとんど減らない。
 */
const DEFAULT_MAX_AGE_MS = 10 * 86_400_000;
/** 1 件の上限（これより大きい音声は置かない・読まない）。 */
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
/** どの文でもこれより小さい音声は壊れているとみなす（MP3 の頭だけ・空に近い応答を置かない）。 */
export const PARADIS_VOICE_CACHE_MIN_ENTRY_BYTES = 1024;
/**
 * 同じ鍵の合成を待つ上限。合成を任された時点（claim）から数える（読み始めからではない）。読まれないまま捨てられた合成が
 * あっても、後の要求を止め続けない。
 */
const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 20_000;
/** 書きかけの一時ファイルを掃除するまでの時間。 */
const TEMP_FILE_MAX_AGE_MS = 60 * 60_000;
/** 日別の数を書き出すまで待つ時間（続けて鳴ったときにまとめて書く）。 */
const STATS_WRITE_DELAY_MS = 2_000;
/** 起動してから最初の掃除までの時間（起動の邪魔をしない）。 */
const STARTUP_PRUNE_DELAY_MS = 60_000;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const ENTRY_PATTERN = /^(?<key>[0-9a-f]{64})\.(?<created>\d{1,15})\.mp3$/;
/** 作った時刻を名前に持たなかった頃（最初の版）のファイル。読まずに掃除で消す。 */
const LEGACY_ENTRY_PATTERN = /^[0-9a-f]{64}\.mp3$/;
/** 作った時刻がこれより先（時計が戻った）なら期限切れとみなす。少しの時計の揺れでは消さない。 */
const FUTURE_TOLERANCE_MS = 60_000;
const TEMP_PATTERN = /^(?:[0-9a-f]{64}|stats\.json)\.[0-9a-f-]+\.tmp$/;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const STATS_FILE = 'stats.json';

export interface IParadisVoiceSynthesisCacheOptions {
	readonly maxEntries?: number;
	readonly maxBytes?: number;
	readonly maxAgeMs?: number;
	readonly maxEntryBytes?: number;
	readonly inFlightTimeoutMs?: number;
	readonly startupPruneDelayMs?: number;
	readonly now?: () => number;
}

export interface IParadisVoiceCacheLookupOptions {
	/** これより小さい音声は壊れているとみなす（文字数に応じた下限。{@link PARADIS_VOICE_CACHE_MIN_ENTRY_BYTES} より小さくはしない）。 */
	readonly minBytes?: number;
	/** 置いてある音を読まずに合成し直して置き換える（設定のテスト再生。外れの音を引き直せるように）。 */
	readonly refresh?: boolean;
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

interface IEntry {
	readonly name: string;
	readonly path: string;
	readonly key: string;
	readonly createdMs: number;
	readonly size: number;
	readonly mtimeMs: number;
}

/** 合成の要求から鍵を作る。 */
export function paradisVoiceCacheKey(parts: unknown): string {
	return createHash('sha256').update(paradisStableStringify(parts)).digest('hex');
}

/** 文字数に応じた音声の下限（128kbps で 1 文字に 1/64 秒も無い音は、読み上げとして短すぎる）。 */
export function paradisVoiceCacheMinBytes(characters: number): number {
	return Math.max(PARADIS_VOICE_CACHE_MIN_ENTRY_BYTES, Math.floor(characters) * 256);
}

/** 作った時刻から見て期限切れか。時計が戻って作った時刻が先になったものも期限切れにする（いつまでも期限を迎えないため）。 */
function isExpired(createdMs: number, now: number, maxAgeMs: number): boolean {
	return createdMs > now + FUTURE_TOLERANCE_MS || now - createdMs > maxAgeMs;
}

function parseEntryName(name: string): { readonly key: string; readonly createdMs: number } | undefined {
	const match = ENTRY_PATTERN.exec(name);
	return match?.groups ? { key: match.groups.key, createdMs: Number(match.groups.created) } : undefined;
}

export class ParadisVoiceSynthesisCache extends Disposable {

	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly maxAgeMs: number;
	private readonly maxEntryBytes: number;
	private readonly inFlightTimeoutMs: number;
	private readonly now: () => number;

	private readonly _inFlight = new Map<string, IInFlight>();
	/** clear() のたびに増やす。消す前に始めた合成は、消した後に残さない。 */
	private _generation = 0;
	/** 鍵ごとの世代。テスト再生（refresh）のたびに増やし、それより前に始めた同じ鍵の合成には書かせない。 */
	private readonly _keyGenerations = new Map<string, number>();
	/** 前からあったディレクトリの権限を確かめたか。 */
	private _dirModeChecked = false;
	private _pruning: Promise<void> | undefined;
	private _prunePending = false;
	private _startupPruneTimer: ReturnType<typeof setTimeout> | undefined;

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
		// 書き込みが無くても、期限切れは起動から少し後に 1 回掃除する
		this._startupPruneTimer = setTimeout(() => {
			this._startupPruneTimer = undefined;
			this._schedulePrune();
		}, options.startupPruneDelayMs ?? STARTUP_PRUNE_DELAY_MS);
	}

	override dispose(): void {
		if (this._startupPruneTimer !== undefined) {
			clearTimeout(this._startupPruneTimer);
			this._startupPruneTimer = undefined;
		}
		for (const inFlight of [...this._inFlight.values()]) {
			inFlight.settle(undefined);
		}
		this._inFlight.clear();
		if (this._statsTimer !== undefined) {
			clearTimeout(this._statsTimer);
			this._statsTimer = undefined;
		}
		if (this._statsDirty && this._days !== undefined) {
			// 終了の間際。待てないので同期で書く（書けなくても読み上げには関係ない）
			try {
				mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
				writeFileSync(join(this.dir, STATS_FILE), JSON.stringify({ version: 1, days: this._days }), { mode: FILE_MODE });
				this._statsDirty = false;
			} catch {
				// ignore
			}
		}
		super.dispose();
	}

	/**
	 * 鍵の音声を探す。同じ鍵の合成が進行中（書き込み中を含む）なら、その読み終わりを待つ。無ければ、この要求が合成を任される
	 * （miss）。ディスクの失敗は投げず、無かったことにする。
	 */
	async lookup(key: string, options: IParadisVoiceCacheLookupOptions = {}): Promise<ParadisVoiceCacheLookup> {
		const minBytes = Math.max(PARADIS_VOICE_CACHE_MIN_ENTRY_BYTES, options.minBytes ?? 0);
		if (!options.refresh) {
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
			const stored = await this._read(key, minBytes);
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
		}
		if (options.refresh) {
			this._keyGenerations.set(key, (this._keyGenerations.get(key) ?? 0) + 1);
		}
		return { kind: 'miss', lease: this._claim(key, minBytes) };
	}

	/** キャッシュから鳴らした（API に送らなかった）1 回を数える。 */
	recordHit(characters: number): void {
		this._count('hit', characters);
	}

	/** API で合成した 1 回を数える。 */
	recordCall(characters: number): void {
		this._count('call', characters);
	}

	/** 置いてある音声を全部消す（日別の数は残す）。消している間に書き終えた合成も、書いた直後に消す。 */
	async clear(): Promise<void> {
		this._generation++;
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return; // まだ何も置いていない
		}
		await Promise.all(names
			.filter(name => ENTRY_PATTERN.test(name) || LEGACY_ENTRY_PATTERN.test(name) || (TEMP_PATTERN.test(name) && !name.startsWith(STATS_FILE)))
			.map(name => unlink(join(this.dir, name)).catch(() => undefined)));
	}

	/** 置いてある件数・合計サイズと、日別の数。期限切れ・上限超えを掃除してから数える。 */
	async getInfo(): Promise<IParadisVoiceCacheInfo> {
		await this.prune();
		const entries = await this._listEntries();
		const days = await this._withStats(days => days);
		return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), days };
	}

	/** 期限切れと上限を超えた分を掃除する（進行中の掃除があれば、それとその後の 1 回を待つ）。 */
	async prune(): Promise<void> {
		this._schedulePrune();
		while (this._pruning) {
			await this._pruning;
		}
	}

	private async _read(key: string, minBytes: number): Promise<Buffer | undefined> {
		if (!KEY_PATTERN.test(key)) {
			return undefined;
		}
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return undefined;
		}
		const candidates = names
			.map(name => ({ name, parsed: parseEntryName(name) }))
			.filter(candidate => candidate.parsed?.key === key)
			.sort((a, b) => b.parsed!.createdMs - a.parsed!.createdMs);
		for (const { name, parsed } of candidates) {
			const path = join(this.dir, name);
			if (isExpired(parsed!.createdMs, this.now(), this.maxAgeMs)) {
				await unlink(path).catch(() => undefined);
				continue;
			}
			let audio: Buffer;
			try {
				const info = await stat(path);
				if (info.size < minBytes || info.size > this.maxEntryBytes) {
					await this._drop(path, `unexpected size ${info.size}`);
					continue;
				}
				audio = await readFile(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
					continue; // 別の掃除と行き違った
				}
				// 読めない（権限・開きすぎ・I/O）。音は壊れていないかもしれないので消さずに外れにする
				this.logService.warn(`[ParadisNotifications] could not read a cached voice: ${getErrorMessage(error)}`);
				return undefined;
			}
			if (!paradisLooksLikeMp3(audio)) {
				await this._drop(path, 'not an MP3');
				continue;
			}
			// 使った印（上限を超えたとき古い順に消す順番。期限は作った時刻で決まるので延びない）
			const at = new Date(this.now());
			await utimes(path, at, at).catch(() => undefined);
			return audio;
		}
		return undefined;
	}

	private async _drop(path: string, reason: string): Promise<void> {
		this.logService.warn(`[ParadisNotifications] dropped a broken cached voice: ${reason}`);
		await unlink(path).catch(() => undefined);
	}

	private _claim(key: string, minBytes: number): IParadisVoiceCacheLease {
		let resolve!: (audio: Buffer | undefined) => void;
		const promise = new Promise<Buffer | undefined>(r => { resolve = r; });
		let settled = false;
		const inFlight: IInFlight = { promise, settle: audio => settle(audio) };
		/** 進行中の印を外す（書き終えた・置かないと決まった）。 */
		const finish = () => {
			if (this._inFlight.get(key) === inFlight) {
				this._inFlight.delete(key);
			}
		};
		// 待つ上限は claim の時点から数える
		const timer = setTimeout(() => {
			settle(undefined);
			finish();
		}, this.inFlightTimeoutMs);
		const settle = (audio: Buffer | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(audio);
			if (!audio) {
				finish();
			}
		};
		this._inFlight.set(key, inFlight);
		const generation = this._generation;
		const keyGeneration = this._keyGenerations.get(key) ?? 0;
		const store = (audio: Buffer) => this._write(key, audio, generation, keyGeneration);
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
					const audio = completed && size >= minBytes && size <= maxEntryBytes ? Buffer.concat(chunks, size) : undefined;
					const usable = audio !== undefined && paradisLooksLikeMp3(audio) ? audio : undefined;
					// 待っている要求には先に音を渡す。進行中の印は書き終えるまで残し、その間に来た同じ文にも同じ音を渡す
					settle(usable);
					if (usable) {
						void store(usable).finally(finish);
					}
				}
			},
		};
	}

	private async _write(key: string, audio: Buffer, generation: number, keyGeneration: number): Promise<void> {
		// 消した後・後から始めたテスト再生があるなら書かない（引き直した音を古い合成で戻さない）
		const current = () => generation === this._generation && keyGeneration === (this._keyGenerations.get(key) ?? 0);
		if (!current() || this._store.isDisposed) {
			return;
		}
		const createdMs = Math.floor(this.now());
		const name = `${key}.${createdMs}.mp3`;
		const path = join(this.dir, name);
		const temp = join(this.dir, `${key}.${generateUuid()}.tmp`);
		try {
			await this._ensureDir();
			await writeFile(temp, audio, { mode: FILE_MODE });
			if (!current()) {
				await unlink(temp).catch(() => undefined);
				return;
			}
			await rename(temp, path);
		} catch (error) {
			this.logService.warn(`[ParadisNotifications] could not cache the synthesized voice: ${getErrorMessage(error)}`);
			await unlink(temp).catch(() => undefined);
			return;
		}
		if (!current()) {
			// rename の間に clear() された・テスト再生が始まった。書いたものを片付ける
			await unlink(path).catch(() => undefined);
			return;
		}
		// 同じ鍵の、自分より前に作った音（テスト再生で引き直した前の音など）を外す。自分より後に作った音は消さない
		// （同じ鍵の書き込みがほぼ同時に終わっても、互いに消し合って両方消えないように）
		const names = await readdir(this.dir).catch(() => [] as string[]);
		await Promise.all(names
			.filter(other => {
				if (other === name) {
					return false;
				}
				if (LEGACY_ENTRY_PATTERN.test(other)) {
					return other.startsWith(`${key}.`);
				}
				const parsed = parseEntryName(other);
				return parsed?.key === key && parsed.createdMs < createdMs;
			})
			.map(other => unlink(join(this.dir, other)).catch(() => undefined)));
		this._schedulePrune();
	}

	/** ディレクトリを作る。前の版が 0755 で作っていたら 0700 に直す（初回だけ確かめる）。 */
	private async _ensureDir(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
		if (this._dirModeChecked) {
			return;
		}
		this._dirModeChecked = true;
		const info = await stat(this.dir).catch(() => undefined);
		if (info && (info.mode & 0o777) !== DIR_MODE) {
			await chmod(this.dir, DIR_MODE).catch(error => this.logService.warn(`[ParadisNotifications] could not restrict the voice cache folder: ${getErrorMessage(error)}`));
		}
	}

	private _schedulePrune(): void {
		if (this._store.isDisposed) {
			return;
		}
		if (this._pruning) {
			this._prunePending = true;
			return;
		}
		this._pruning = this._prune()
			.catch(error => this.logService.warn(`[ParadisNotifications] could not trim the voice cache: ${getErrorMessage(error)}`))
			.finally(() => {
				this._pruning = undefined;
				if (this._prunePending) {
					this._prunePending = false;
					this._schedulePrune();
				}
			});
	}

	/** 期限切れ・同じ鍵の古い音・上限を超えた分（最後に使ったのが古い順）を消す。書きかけの一時ファイルも掃除する。 */
	private async _prune(): Promise<void> {
		const now = this.now();
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return;
		}
		// 作った時刻を名前に持たない最初の版のファイルは、読めないので消す
		await Promise.all(names.filter(candidate => LEGACY_ENTRY_PATTERN.test(candidate)).map(candidate => unlink(join(this.dir, candidate)).catch(() => undefined)));
		for (const name of names.filter(candidate => TEMP_PATTERN.test(candidate))) {
			const path = join(this.dir, name);
			const info = await stat(path).catch(() => undefined);
			if (info && now - info.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
				await unlink(path).catch(() => undefined);
			}
		}
		const entries = await this._listEntries(names);
		const newestByKey = new Map<string, number>();
		for (const entry of entries) {
			newestByKey.set(entry.key, Math.max(newestByKey.get(entry.key) ?? 0, entry.createdMs));
		}
		const remove: IEntry[] = [];
		let kept = 0;
		let bytes = 0;
		for (const entry of [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
			if (isExpired(entry.createdMs, now, this.maxAgeMs) || entry.createdMs !== newestByKey.get(entry.key) || kept >= this.maxEntries || bytes + entry.size > this.maxBytes) {
				remove.push(entry);
			} else {
				kept++;
				bytes += entry.size;
			}
		}
		await Promise.all(remove.map(entry => unlink(entry.path).catch(() => undefined)));
	}

	private async _listEntries(names?: readonly string[]): Promise<IEntry[]> {
		if (names === undefined) {
			try {
				names = await readdir(this.dir);
			} catch {
				return [];
			}
		}
		const entries = await Promise.all(names.map(async (name): Promise<IEntry | undefined> => {
			const parsed = parseEntryName(name);
			if (!parsed) {
				return undefined;
			}
			const path = join(this.dir, name);
			const info = await stat(path).catch(() => undefined);
			return info?.isFile() ? { name, path, key: parsed.key, createdMs: parsed.createdMs, size: info.size, mtimeMs: info.mtimeMs } : undefined;
		}));
		return entries.filter((entry): entry is IEntry => entry !== undefined);
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
	private _withStats<T>(use: (days: IParadisVoiceCacheDay[]) => T | Promise<T>): Promise<T> {
		const result = this._statsQueue.then(async (): Promise<T> => {
			if (this._days === undefined) {
				this._days = await readFile(join(this.dir, STATS_FILE), 'utf8')
					.then(text => paradisParseVoiceCacheDays((JSON.parse(text) as { days?: unknown }).days))
					.catch(() => []);
			}
			return await use(this._days);
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
				await this._ensureDir();
				await writeFile(temp, JSON.stringify({ version: 1, days }), { mode: FILE_MODE });
				await rename(temp, join(this.dir, STATS_FILE));
			} catch (error) {
				// 次に数えたとき（か終了のとき）に書き直す
				this._statsDirty = true;
				this.logService.warn(`[ParadisNotifications] could not save the voice cache counts: ${getErrorMessage(error)}`);
				await unlink(temp).catch(() => undefined);
			}
		});
	}
}
