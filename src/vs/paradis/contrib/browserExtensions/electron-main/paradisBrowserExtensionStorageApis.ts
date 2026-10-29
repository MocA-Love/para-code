/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-sync-storage-store.ts, src/main/browser/extensions/api/storage-sync.ts, src/main/browser/extensions/api/storage-relay.ts

// chrome.storage.sync の本体と、ページの storage の変化を worker へ渡す中継（詰め物の名前空間）。
//
// storage.sync: Electron は使えなくしているので、Chrome がサインインしていない人にするのと同じく手元に
// 保存する。場所（`default` / `profile:<id>`）× 拡張機能ごとに 1 ファイル、100 KB まで。main だけが書くので、
// 変化は正確な前の値を持つ。書き込みは変化を呼び出し元へ返し（呼び出し元が自分の受け手へ出す）、同じ
// セッションのほかの文脈へは onChanged で届ける。
//
// 中継: Electron は拡張機能の worker で chrome.storage.onChanged を出さないので、ページが自分の書き込みを
// 知らせ、main が同じセッションの同じ拡張機能の worker へ渡す（worker は自分の書き込みを自分で出す）。

import { promises as fs } from 'fs';
import { z } from 'zod';
import { join } from '../../../../base/common/path.js';
import { PARADIS_SHIM_STORAGE_RELAY_NAMESPACE, PARADIS_SHIM_STORAGE_SYNC_NAMESPACE } from '../common/paradisBrowserExtensionShim.js';
import { paradisIsExtensionId } from '../common/paradisBrowserExtensions.js';
import { IParadisExtensionApiCaller, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';

/** Para Code が守る storage.sync の大きさの上限（書き込みの頻度は守らない）。 */
export const PARADIS_STORAGE_SYNC_QUOTAS = { QUOTA_BYTES: 102_400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512 } as const;

type SyncItems = Record<string, unknown>;
type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const PERSIST_DELAY_MS = 250;

function isItems(value: unknown): value is SyncItems {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * storage.sync の中身（場所 × 拡張機能）。拡張機能は設定を鍵ごとに続けて書くことが多いので、まとめて書く。
 */
export class ParadisBrowserExtensionSyncStore {
	private readonly _cache = new Map<string, SyncItems>();
	private readonly _dirty = new Set<string>();
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _writing: Promise<void> = Promise.resolve();
	/** 場所 × 拡張機能ごとの書き込みの順番（読んでから書くまでの間に、ほかの書き込みを割り込ませない）。 */
	private readonly _queues = new Map<string, Promise<unknown>>();

	constructor(private readonly _root: string, private readonly _logService: { warn(message: string, ...args: unknown[]): void }) { }

	private _folder(place: string): string {
		return join(this._root, encodeURIComponent(place));
	}

	private _file(place: string, extensionId: string): string {
		return join(this._folder(place), `${extensionId}.json`);
	}

	private static _key(place: string, extensionId: string): string {
		return `${place}\n${extensionId}`;
	}

	async read(place: string, extensionId: string): Promise<SyncItems> {
		const key = ParadisBrowserExtensionSyncStore._key(place, extensionId);
		let items = this._cache.get(key);
		if (!items) {
			try {
				const raw: unknown = JSON.parse(await fs.readFile(this._file(place, extensionId), 'utf8'));
				items = isItems(raw) ? raw : {};
			} catch {
				items = {};
			}
			// 読んでいる間に書かれていれば、書かれた方を使う
			items = this._cache.get(key) ?? items;
			this._cache.set(key, items);
		}
		return items;
	}

	/** 読んで書く処理を、同じ場所 × 拡張機能の中で 1 つずつ行う。 */
	exclusive<T>(place: string, extensionId: string, task: () => Promise<T>): Promise<T> {
		const key = ParadisBrowserExtensionSyncStore._key(place, extensionId);
		const run = (this._queues.get(key) ?? Promise.resolve()).then(task, task);
		const settled = run.then(() => undefined, () => undefined);
		this._queues.set(key, settled);
		void settled.then(() => {
			if (this._queues.get(key) === settled) {
				this._queues.delete(key);
			}
		});
		return run;
	}

	write(place: string, extensionId: string, items: SyncItems): void {
		const key = ParadisBrowserExtensionSyncStore._key(place, extensionId);
		this._cache.set(key, items);
		this._dirty.add(key);
		this._timer ??= setTimeout(() => {
			this._timer = undefined;
			void this.flush();
		}, PERSIST_DELAY_MS);
	}

	/** 書いていない中身を書く（終了のときにも呼ぶ）。 */
	flush(): Promise<void> {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		const keys = [...this._dirty];
		this._dirty.clear();
		this._writing = this._writing.then(async () => {
			for (const key of keys) {
				const [place, extensionId] = key.split('\n');
				const items = this._cache.get(key);
				if (!items) {
					continue;
				}
				const target = this._file(place, extensionId);
				await fs.mkdir(this._folder(place), { recursive: true });
				const temporary = `${target}.tmp`;
				await fs.writeFile(temporary, JSON.stringify(items));
				await fs.rename(temporary, target);
			}
		}).catch(error => this._logService.warn('[paradis] could not save browser extension sync storage', error));
		return this._writing;
	}

	/** 拡張機能を削除した: すべての場所の中身を消す。 */
	async forgetExtension(extensionId: string): Promise<void> {
		for (const key of [...this._cache.keys()]) {
			if (key.endsWith(`\n${extensionId}`)) {
				this._cache.delete(key);
				this._dirty.delete(key);
			}
		}
		await this._writing;
		for (const folder of await fs.readdir(this._root).catch(() => [])) {
			await fs.rm(join(this._root, folder, `${extensionId}.json`), { force: true }).catch(() => { /* already gone */ });
		}
	}

	/** 台帳に無い拡張機能の中身を消す（削除の途中に落ちた分の片付け）。 */
	async forgetExtensionsExcept(extensionIds: ReadonlySet<string>): Promise<void> {
		for (const folder of await fs.readdir(this._root).catch(() => [])) {
			for (const file of await fs.readdir(join(this._root, folder)).catch(() => [])) {
				const extensionId = file.replace(/\.json$/, '');
				if (paradisIsExtensionId(extensionId) && !extensionIds.has(extensionId)) {
					await fs.rm(join(this._root, folder, file), { force: true }).catch(() => { /* already gone */ });
				}
			}
		}
	}
}

const keyListSchema = z.union([z.string(), z.array(z.string())]);
const itemsSchema = z.record(z.string(), z.unknown());
const getKeysSchema = z.union([z.null(), keyListSchema, itemsSchema]).optional();
const changesSchema = z.record(z.string(), z.object({ oldValue: z.unknown().optional(), newValue: z.unknown().optional() }).strict());

/** Chrome は JSON で保存する（関数と undefined の値は落ちる。undefined は書かない）。 */
function toStoredValue(value: unknown): unknown {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		throw new ParadisExtensionApiError('Values must be JSON-serializable');
	}
	return json === undefined ? undefined : JSON.parse(json);
}

// Chrome は鍵と値の JSON の UTF-8 のバイト数を数える
function itemBytes(key: string, value: unknown): number {
	return Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
}

function bytesInUse(items: SyncItems, keys: readonly string[]): number {
	return keys.reduce((total, key) => Object.prototype.hasOwnProperty.call(items, key) ? total + itemBytes(key, items[key]) : total, 0);
}

/** storage.sync と中継の名前空間を登録する。 */
export function paradisRegisterStorageApis(host: ParadisExtensionApiHost, store: ParadisBrowserExtensionSyncStore): void {
	const commit = (caller: IParadisExtensionApiCaller, current: SyncItems, next: SyncItems, keys: Iterable<string>): StorageChanges => {
		const changes: StorageChanges = {};
		for (const key of keys) {
			const had = Object.prototype.hasOwnProperty.call(current, key);
			const has = Object.prototype.hasOwnProperty.call(next, key);
			if ((had || has) && !(had && has && JSON.stringify(current[key]) === JSON.stringify(next[key]))) {
				changes[key] = { ...(had ? { oldValue: current[key] } : {}), ...(has ? { newValue: next[key] } : {}) };
			}
		}
		if (Object.keys(changes).length === 0) {
			return changes;
		}
		store.write(caller.place, caller.extension.id, next);
		// 呼び出し元は自分で出すので、それ以外の文脈へ。同じ場所のほかのセッション（Global と各ワークスペース）も
		// 同じ中身を見ているので、そちらへも届ける
		host.emitToPlace(caller.place, caller.extension.id, PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, 'onChanged', [changes], { session: caller.session, connection: caller.connection });
		return changes;
	};
	const quotaError = (name: keyof typeof PARADIS_STORAGE_SYNC_QUOTAS) => new ParadisExtensionApiError(`${name} quota exceeded`);

	host.registerNamespace(PARADIS_SHIM_STORAGE_SYNC_NAMESPACE, {
		permission: 'storage',
		methods: {
			get: paradisDefineExtensionMethod(z.tuple([getKeysSchema]), async (caller, keys) => {
				const items = await store.read(caller.place, caller.extension.id);
				if (keys === null || keys === undefined) {
					return { ...items };
				}
				if (typeof keys === 'string' || Array.isArray(keys)) {
					return Object.fromEntries([keys].flat().flatMap(key => Object.prototype.hasOwnProperty.call(items, key) ? [[key, items[key]]] : []));
				}
				const result: SyncItems = {};
				for (const [key, fallback] of Object.entries(keys)) {
					const value = Object.prototype.hasOwnProperty.call(items, key) ? items[key] : toStoredValue(fallback);
					if (value !== undefined) {
						result[key] = value;
					}
				}
				return result;
			}),
			getKeys: paradisDefineExtensionMethod(z.tuple([]), async caller => Object.keys(await store.read(caller.place, caller.extension.id))),
			getBytesInUse: paradisDefineExtensionMethod(z.tuple([z.union([z.null(), keyListSchema]).optional()]), async (caller, keys) => {
				const items = await store.read(caller.place, caller.extension.id);
				return bytesInUse(items, keys === null || keys === undefined ? Object.keys(items) : [keys].flat());
			}),
			set: paradisDefineExtensionMethod(z.tuple([itemsSchema]), (caller, input) => store.exclusive(caller.place, caller.extension.id, async () => {
				const current = await store.read(caller.place, caller.extension.id);
				const next = { ...current };
				let total = bytesInUse(current, Object.keys(current));
				for (const [key, raw] of Object.entries(input)) {
					const value = toStoredValue(raw);
					if (value === undefined) {
						continue;
					}
					const size = itemBytes(key, value);
					if (size > PARADIS_STORAGE_SYNC_QUOTAS.QUOTA_BYTES_PER_ITEM) {
						throw quotaError('QUOTA_BYTES_PER_ITEM');
					}
					total += size - bytesInUse(next, [key]);
					next[key] = value;
				}
				if (total > PARADIS_STORAGE_SYNC_QUOTAS.QUOTA_BYTES) {
					throw quotaError('QUOTA_BYTES');
				}
				if (Object.keys(next).length > PARADIS_STORAGE_SYNC_QUOTAS.MAX_ITEMS) {
					throw quotaError('MAX_ITEMS');
				}
				return commit(caller, current, next, Object.keys(input));
			})),
			remove: paradisDefineExtensionMethod(z.tuple([keyListSchema]), (caller, keys) => store.exclusive(caller.place, caller.extension.id, async () => {
				const current = await store.read(caller.place, caller.extension.id);
				const next = { ...current };
				for (const key of [keys].flat()) {
					delete next[key];
				}
				return commit(caller, current, next, [keys].flat());
			})),
			clear: paradisDefineExtensionMethod(z.tuple([]), caller => store.exclusive(caller.place, caller.extension.id, async () => {
				const current = await store.read(caller.place, caller.extension.id);
				return commit(caller, current, {}, Object.keys(current));
			})),
		},
		events: ['onChanged'],
	});

	host.registerNamespace(PARADIS_SHIM_STORAGE_RELAY_NAMESPACE, {
		methods: {
			report: paradisDefineExtensionMethod(z.tuple([z.enum(['local', 'session']), changesSchema]), (caller, areaName, changes) => {
				if (caller.fromWorker) {
					throw new ParadisExtensionApiError('The worker delivers its own storage changes');
				}
				host.emit({ session: caller.session, extensionId: caller.extension.id, exceptConnection: caller.connection }, PARADIS_SHIM_STORAGE_RELAY_NAMESPACE, 'onChanged', [changes, areaName]);
			}),
		},
		events: ['onChanged'],
	});
}
