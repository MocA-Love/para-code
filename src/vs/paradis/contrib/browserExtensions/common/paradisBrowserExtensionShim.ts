/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/preload/browser-extension-worker-shim.ts, src/preload/browser-extension-main-world.ts, src/preload/browser-extension-storage-relay.ts, src/preload/browser-extension-storage-sync.ts, src/preload/browser-extension-api-surface.ts

// 拡張機能の中（背景の service worker と拡張機能のページ）で動く Para Code の詰め物。Electron 43 に無い
// chrome.* を足し、main とは私用スキームへの fetch で話す。
//
// ここの関数は main が toString() で文字列にして拡張機能の写しへ書く（paradisBrowserExtensionShimSource）。
// そのため、どの関数も自分の本体の外にあるもの（import・このファイルの他の定数）を参照してはならない。
// 使ってよいのは引数と、拡張機能の中にある globalThis のもの（chrome・fetch など）だけ。テストが
// 拡張機能の外の何も無い環境で実行して確かめる。クラスも使わない（製品のビルドが private を書き換える）。

/** 詰め物の中で main と話す口（transport が作って各 install へ渡す）。 */
export interface IParadisShimBridge {
	call(namespace: string, method: string, args: unknown[]): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }>;
	listen(namespace: string, event: string, active: boolean): void;
	/** 届いたイベントを受ける（どの受け手にも全部届く）。 */
	onEvent(handler: (namespace: string, event: string, args: unknown[]) => void): void;
}

/** 詰め物が足す API の一覧（main の登録と同じものを並べる。テストが突き合わせる）。 */
export interface IParadisShimSurfaceNamespace {
	/** manifest の permissions にこのどれかがあるときだけ足す（main も同じ判定で断る）。 */
	readonly permission?: string | readonly string[];
	readonly methods: readonly string[];
	readonly events: readonly string[];
	readonly constants?: Readonly<Record<string, number>>;
}

export type ParadisShimSurface = Readonly<Record<string, IParadisShimSurfaceNamespace>>;

/** chrome.storage.sync の定数（main が大きさを守る。書き込みの頻度は守らない）。 */
export const PARADIS_SHIM_STORAGE_SYNC_CONSTANTS: Readonly<Record<string, number>> = {
	QUOTA_BYTES: 102_400,
	QUOTA_BYTES_PER_ITEM: 8192,
	MAX_ITEMS: 512,
	MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
	MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
	MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1_000_000,
};

/** main だけが使う、chrome には出さない名前空間（storage の変化の中継・storage.sync の本体）。 */
export const PARADIS_SHIM_STORAGE_RELAY_NAMESPACE = 'paradisStorageRelay';
export const PARADIS_SHIM_STORAGE_SYNC_NAMESPACE = 'paradisStorageSync';

/** chrome に足す API（P4a: runtime の起動のイベント。tabs・windows などは後の PR で足す）。 */
export const PARADIS_SHIM_SURFACE: ParadisShimSurface = {
	// Electron はこの 2 つを出さない。Para Code が拡張機能の読み込みの後に出す
	runtime: { methods: [], events: ['onInstalled', 'onStartup'] },
};

type ApiObject = Record<string, unknown>;
type Callable = (...args: unknown[]) => unknown;

/**
 * 一覧（surface）の名前空間・関数・イベントを chrome と browser へ足す。関数はコールバックと Promise の
 * どちらの呼び方も受け、コールバックで失敗したら chrome.runtime.lastError を立てる。
 */
export function paradisInstallExtensionApis(bridge: IParadisShimBridge, surface: ParadisShimSurface): void {
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	if (!isObject(chromeApi)) {
		return;
	}
	const define = (target: ApiObject, key: string, value: unknown): void => {
		try {
			Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
		} catch {
			try {
				target[key] = value;
			} catch {
				// 凍った本物のオブジェクト: そのままにする
			}
		}
	};
	const runtime = (): ApiObject | undefined => isObject(chromeApi.runtime) ? chromeApi.runtime : undefined;
	const readManifest = (): ApiObject => {
		try {
			const getManifest = runtime()?.getManifest;
			const manifest: unknown = isCallable(getManifest) ? getManifest.call(runtime()) : undefined;
			return isObject(manifest) ? manifest : {};
		} catch {
			return {};
		}
	};
	const callWithLastError = (message: string, callback: () => void): void => {
		const target = runtime();
		let defined = false;
		if (target) {
			try {
				Object.defineProperty(target, 'lastError', { configurable: true, get: () => ({ message }) });
				defined = true;
			} catch {
				// 本物の lastError を差し替えられない。コールバックは呼ぶ
			}
		}
		try {
			callback();
		} finally {
			if (defined && target) {
				try {
					delete target.lastError;
				} catch {
					// ignore
				}
			}
		}
	};
	const makeMethod = (namespace: string, name: string) => function paradisExtensionMethod(...input: unknown[]): unknown {
		const args = [...input];
		// Chrome は末尾の undefined を無視する（main のタプルは無視しない）
		while (args.length > 0 && args[args.length - 1] === undefined) {
			args.pop();
		}
		const last = args[args.length - 1];
		const callback = isCallable(last) ? last : undefined;
		if (callback) {
			args.pop();
		}
		const promise = (async () => {
			const reply = await bridge.call(namespace, name, args);
			if (!reply.ok) {
				throw new Error(reply.error);
			}
			return reply.value;
		})();
		if (!callback) {
			return promise;
		}
		promise.then(
			value => value === undefined ? callback() : callback(value),
			(error: unknown) => callWithLastError(error instanceof Error ? error.message : String(error), () => callback()),
		);
		return undefined;
	};
	const listeners = new Map<string, Set<Callable>>();
	bridge.onEvent((namespace, event, args) => {
		for (const callback of listeners.get(`${namespace}.${event}`) ?? []) {
			try {
				callback(...args);
			} catch (error) {
				console.error(error);
			}
		}
	});
	const makeEvent = (namespace: string, name: string): ApiObject => {
		const key = `${namespace}.${name}`;
		const registered = listeners.get(key) ?? new Set<Callable>();
		listeners.set(key, registered);
		return {
			addListener: (callback: unknown) => {
				if (!isCallable(callback) || registered.has(callback)) {
					return;
				}
				registered.add(callback);
				if (registered.size === 1) {
					bridge.listen(namespace, name, true);
				}
			},
			removeListener: (callback: unknown) => {
				if (isCallable(callback) && registered.delete(callback) && registered.size === 0) {
					bridge.listen(namespace, name, false);
				}
			},
			hasListener: (callback: unknown) => isCallable(callback) && registered.has(callback),
			hasListeners: () => registered.size > 0,
		};
	};
	const manifest = readManifest();
	// 後から許可される権限（optional_permissions）でも足しておく。main は許可されるまで断る
	const permissions = [manifest.permissions, manifest.optional_permissions].flatMap(list => Array.isArray(list) ? list : []);
	for (const [namespace, spec] of Object.entries(surface)) {
		if (spec.permission !== undefined && ![spec.permission].flat().some(name => permissions.includes(name))) {
			continue;
		}
		const existing = chromeApi[namespace];
		const target: ApiObject = isObject(existing) ? existing : {};
		const members: [string, unknown][] = [
			...spec.methods.map((name): [string, unknown] => [name, makeMethod(namespace, name)]),
			...spec.events.map((name): [string, unknown] => [name, makeEvent(namespace, name)]),
			...Object.entries(spec.constants ?? {}).filter(([name]) => target[name] === undefined),
		];
		for (const [name, value] of members) {
			define(target, name, value);
		}
		if (target !== existing) {
			define(chromeApi, namespace, target);
		}
		// browser は chrome と別の本物のグローバル。WebExtension 流のコードはこちらを先に読む
		const browserApi = root.browser;
		if (isObject(browserApi) && browserApi !== chromeApi) {
			const mirror = browserApi[namespace];
			if (isObject(mirror) && mirror !== target) {
				for (const [name, value] of members) {
					define(mirror, name, value);
				}
			} else if (!isObject(mirror)) {
				define(browserApi, namespace, target);
			}
		}
	}
}

/**
 * Electron は拡張機能の service worker で chrome.storage.onChanged を出さない（Electron 43.7.7 で実測）。
 * local と session の set・remove・clear を包んで Chrome と同じ形の変化を作り、ページでは main へ知らせ、
 * main が同じ拡張機能の worker へ渡す。worker では onChanged を詰め物のイベントにし、ページからの知らせと
 * worker 自身の書き込みを届ける。ページの onChanged は本物が動くのでそのまま。
 * 残る穴: content script（ウェブページの中）からの書き込みは worker に届かない。
 */
export function paradisInstallStorageRelay(bridge: IParadisShimBridge, context: 'page' | 'worker', relayNamespace: string): void {
	type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	if (!isObject(chromeApi) || !isObject(chromeApi.storage)) {
		return;
	}
	const define = (target: ApiObject, key: string, value: unknown): void => {
		try {
			Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
		} catch {
			// 凍った本物のオブジェクト: そのままにする
		}
	};
	const lastErrorMessage = (): string | undefined => {
		const lastError = isObject(chromeApi.runtime) ? chromeApi.runtime.lastError : undefined;
		return isObject(lastError) ? String(lastError.message ?? 'Storage error') : undefined;
	};
	const diff = (before: ApiObject, after: ApiObject): Changes => {
		const changes: Changes = {};
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			const had = Object.prototype.hasOwnProperty.call(before, key);
			const has = Object.prototype.hasOwnProperty.call(after, key);
			if (had && has && JSON.stringify(before[key]) === JSON.stringify(after[key])) {
				continue;
			}
			changes[key] = { ...(had ? { oldValue: before[key] } : {}), ...(has ? { newValue: after[key] } : {}) };
		}
		return changes;
	};
	// worker の受け手（場所の名前ごと。'' は chrome.storage.onChanged）
	const listeners = new Map<string, Set<Callable>>();
	let listening = false;
	const deliver = (areaName: string, changes: ApiObject): void => {
		const calls: [Callable, unknown[]][] = [
			...[...(listeners.get(areaName) ?? [])].map((callback): [Callable, unknown[]] => [callback, [changes]]),
			...[...(listeners.get('') ?? [])].map((callback): [Callable, unknown[]] => [callback, [changes, areaName]]),
		];
		for (const [callback, args] of calls) {
			try {
				callback(...args);
			} catch (error) {
				console.error(error);
			}
		}
	};
	const makeEvent = (areaName: string): ApiObject => {
		const registered = new Set<Callable>();
		listeners.set(areaName, registered);
		const syncListening = (): void => {
			const active = [...listeners.values()].some(set => set.size > 0);
			if (active !== listening) {
				listening = active;
				bridge.listen(relayNamespace, 'onChanged', active);
			}
		};
		return {
			addListener: (callback: unknown) => {
				if (isCallable(callback) && !registered.has(callback)) {
					registered.add(callback);
					syncListening();
				}
			},
			removeListener: (callback: unknown) => {
				if (isCallable(callback) && registered.delete(callback)) {
					syncListening();
				}
			},
			hasListener: (callback: unknown) => isCallable(callback) && registered.has(callback),
			hasListeners: () => registered.size > 0,
		};
	};
	const publish = (areaName: string, changes: Changes): void => {
		if (Object.keys(changes).length === 0) {
			return;
		}
		if (context === 'worker') {
			deliver(areaName, changes);
		} else {
			void bridge.call(relayNamespace, 'report', [areaName, changes]);
		}
	};
	// 書き込みが触る鍵（null はすべて）。undefined は本物に断らせる形
	const writeKeys: Record<string, (args: unknown[]) => string[] | null | undefined> = {
		set: ([items]) => isObject(items) && !Array.isArray(items) ? Object.keys(items) : undefined,
		remove: ([keys]) => typeof keys === 'string' ? [keys] : Array.isArray(keys) && keys.every(key => typeof key === 'string') ? keys as string[] : undefined,
		clear: () => null,
	};
	const wrapArea = (area: ApiObject, areaName: string): void => {
		const get = area.get;
		if (!isCallable(get)) {
			return;
		}
		for (const [method, keysOf] of Object.entries(writeKeys)) {
			const native = area[method];
			if (!isCallable(native)) {
				continue;
			}
			define(area, method, function paradisStorageWrite(...input: unknown[]): unknown {
				const args = [...input];
				const last = args[args.length - 1];
				const callback = isCallable(last) ? last : undefined;
				if (callback) {
					args.pop();
				}
				const keys = keysOf(args);
				if (keys === undefined) {
					return native.call(area, ...input);
				}
				// Chromium は 1 つの場所の呼び出しを順に処理するので、前後の読みがこの書き込みをちょうど挟む
				const run = (done: (error: string | undefined) => void): void => {
					let before: unknown;
					let error: string | undefined;
					get.call(area, keys, (value: unknown) => {
						before = value;
					});
					native.call(area, ...args, () => {
						error = lastErrorMessage();
						if (error !== undefined) {
							done(error);
						}
					});
					get.call(area, keys, (after: unknown) => {
						if (error !== undefined) {
							return;
						}
						done(undefined);
						if (isObject(before) && isObject(after)) {
							publish(areaName, diff(before, after));
						}
					});
				};
				if (callback) {
					run(() => callback());
					return undefined;
				}
				return new Promise((resolve, reject) => run(error => error === undefined ? resolve(undefined) : reject(new Error(error))));
			});
		}
	};
	const wrapped = new WeakSet<object>();
	const events = context === 'worker'
		? { onChanged: makeEvent(''), local: makeEvent('local'), session: makeEvent('session') }
		: undefined;
	for (const api of [chromeApi, root.browser]) {
		const storage = isObject(api) ? api.storage : undefined;
		if (!isObject(storage)) {
			continue;
		}
		for (const areaName of ['local', 'session'] as const) {
			const area = storage[areaName];
			if (!isObject(area) || wrapped.has(area)) {
				continue;
			}
			wrapped.add(area);
			wrapArea(area, areaName);
			if (events) {
				define(area, 'onChanged', events[areaName]);
			}
		}
		if (events) {
			define(storage, 'onChanged', events.onChanged);
		}
	}
	if (events) {
		bridge.onEvent((namespace, event, args) => {
			const [changes, areaName] = args;
			if (namespace === relayNamespace && event === 'onChanged' && isObject(changes) && typeof areaName === 'string') {
				deliver(areaName, changes);
			}
		});
	}
}

/**
 * Electron は chrome.storage.sync を使えなくしている（「"sync" is not available in this instance of Chrome」、
 * Electron 43.7.7 で実測）。main が手元に保存する場所に置き換え、chrome.storage.onChanged にも main の 'sync' の
 * 変化を届ける。paradisInstallStorageRelay の後に呼ぶ（その onChanged を包むため）。
 */
export function paradisInstallStorageSync(bridge: IParadisShimBridge, constants: Readonly<Record<string, number>>, syncNamespace: string): void {
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	if (!isObject(chromeApi) || !isObject(chromeApi.storage)) {
		return;
	}
	const define = (target: ApiObject, key: string, value: unknown): void => {
		try {
			Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
		} catch {
			// 凍った本物のオブジェクト: そのままにする
		}
	};
	const callWithLastError = (message: string, callback: () => void): void => {
		const runtime = isObject(chromeApi.runtime) ? chromeApi.runtime : undefined;
		let defined = false;
		if (runtime) {
			try {
				Object.defineProperty(runtime, 'lastError', { configurable: true, get: () => ({ message }) });
				defined = true;
			} catch {
				// 本物の lastError を差し替えられない。コールバックは呼ぶ
			}
		}
		try {
			callback();
		} finally {
			if (defined && runtime) {
				delete runtime.lastError;
			}
		}
	};
	// Chrome は JSON で保存する。ここで JSON にすると、関数の混じった値も main へ送れる形になる
	const toWire = (value: unknown): unknown => {
		const json = JSON.stringify(value);
		return json === undefined ? undefined : JSON.parse(json);
	};
	const splitCallback = (input: unknown[]): [unknown[], Callable | undefined] => {
		let end = input.length;
		while (end > 0 && input[end - 1] === undefined) {
			end -= 1;
		}
		const last = input[end - 1];
		return isCallable(last) ? [input.slice(0, end - 1), last] : [input.slice(0, end), undefined];
	};
	// sync.onChanged の受け手と、chrome・browser それぞれの storage.onChanged の受け手
	const areaListeners = new Set<Callable>();
	const storageListeners: Set<Callable>[] = [];
	let listening = false;
	const syncListening = (): void => {
		const active = [areaListeners, ...storageListeners].some(set => set.size > 0);
		if (active !== listening) {
			listening = active;
			bridge.listen(syncNamespace, 'onChanged', active);
		}
	};
	const makeEvent = (registered: Set<Callable>, inner: ApiObject | undefined): ApiObject => ({
		addListener: (callback: unknown) => {
			if (inner && isCallable(inner.addListener)) {
				inner.addListener(callback);
			}
			if (isCallable(callback) && !registered.has(callback)) {
				registered.add(callback);
				syncListening();
			}
		},
		removeListener: (callback: unknown) => {
			if (inner && isCallable(inner.removeListener)) {
				inner.removeListener(callback);
			}
			if (isCallable(callback) && registered.delete(callback)) {
				syncListening();
			}
		},
		hasListener: (callback: unknown) => isCallable(callback) && registered.has(callback),
		hasListeners: () => registered.size > 0,
	});
	const deliver = (changes: ApiObject): void => {
		const calls: [Callable, unknown[]][] = [
			...[...areaListeners].map((callback): [Callable, unknown[]] => [callback, [changes]]),
			...storageListeners.flatMap(set => [...set].map((callback): [Callable, unknown[]] => [callback, [changes, 'sync']])),
		];
		for (const [callback, args] of calls) {
			try {
				callback(...args);
			} catch (error) {
				console.error(error);
			}
		}
	};
	bridge.onEvent((namespace, event, args) => {
		const [changes] = args;
		if (namespace === syncNamespace && event === 'onChanged' && isObject(changes)) {
			deliver(changes);
		}
	});
	// 書き込みは自分の変化を自分で届ける（起動したばかりの worker の書き込みが、受け手の登録より先に main へ
	// 着くことがあり、Chrome は書いた側の受け手にも出すため）。main は呼び出し元へは送らない
	const writes = new Set(['set', 'remove', 'clear']);
	const method = (name: string) => (...input: unknown[]): unknown => {
		const [args, callback] = splitCallback(input);
		const promise = (async () => {
			const reply = await bridge.call(syncNamespace, name, args.map(toWire));
			if (!reply.ok) {
				throw new Error(reply.error);
			}
			if (!writes.has(name)) {
				return reply.value;
			}
			if (isObject(reply.value) && Object.keys(reply.value).length > 0) {
				deliver(reply.value);
			}
			return undefined;
		})();
		if (!callback) {
			return promise;
		}
		promise.then(
			value => value === undefined ? callback() : callback(value),
			(error: unknown) => callWithLastError(error instanceof Error ? error.message : String(error), () => callback()),
		);
		return undefined;
	};
	const area: ApiObject = {
		...constants,
		// 既定の値だけを受ける
		setAccessLevel: (...input: unknown[]) => {
			const [[options], callback] = splitCallback(input);
			const supported = isObject(options) && options.accessLevel === 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
			const error = 'This StorageArea is not available for setting access level';
			if (!callback) {
				return supported ? Promise.resolve() : Promise.reject(new Error(error));
			}
			void Promise.resolve().then(() => supported ? callback() : callWithLastError(error, () => callback()));
			return undefined;
		},
		onChanged: makeEvent(areaListeners, undefined),
	};
	for (const name of ['get', 'getKeys', 'getBytesInUse', 'set', 'remove', 'clear']) {
		area[name] = method(name);
	}
	const installed = new Set<object>();
	for (const api of [chromeApi, root.browser]) {
		const storage = isObject(api) ? api.storage : undefined;
		if (!isObject(storage) || installed.has(storage)) {
			continue;
		}
		installed.add(storage);
		define(storage, 'sync', area);
		const registered = new Set<Callable>();
		storageListeners.push(registered);
		define(storage, 'onChanged', makeEvent(registered, isObject(storage.onChanged) ? storage.onChanged : undefined));
	}
	syncListening();
}

/** {@link paradisExtensionShimMain} に渡すもの（main が文字列にして埋め込む）。 */
export interface IParadisShimOptions {
	readonly callUrl: string;
	readonly eventsUrl: string;
	/** トークンのファイルの、拡張機能の根からのパス（`/paracode-extension-api-token.json`）。 */
	readonly tokenPath: string;
	readonly surface: ParadisShimSurface;
	readonly syncConstants: Readonly<Record<string, number>>;
	readonly relayNamespace: string;
	readonly syncNamespace: string;
	readonly installApis: typeof paradisInstallExtensionApis;
	readonly installStorageRelay: typeof paradisInstallStorageRelay;
	readonly installStorageSync: typeof paradisInstallStorageSync;
	/** 再接続までの待ち（ミリ秒）。 */
	readonly reconnectDelayMs: number;
}

/**
 * 詰め物の入口。fetch で main と話す口（bridge）を作り、API を足す。worker でもページでも同じものが動く
 * （worker か否かは ServiceWorkerGlobalScope で見分ける）。
 */
export function paradisExtensionShimMain(options: IParadisShimOptions): void {
	type Reply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };
	const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
	const scope = globalThis as { ServiceWorkerGlobalScope?: unknown; chrome?: unknown; crypto?: { randomUUID?: () => string } };
	const isWorker = typeof scope.ServiceWorkerGlobalScope === 'function' && globalThis instanceof (scope.ServiceWorkerGlobalScope as new () => object);
	// 呼び出しを受ける chrome が無い（manifest の sandbox のページなど）なら何もしない
	if (!isRecord(scope.chrome)) {
		return;
	}
	const connection = isWorker ? 'worker' : `page-${typeof scope.crypto?.randomUUID === 'function' ? scope.crypto.randomUUID() : String(Math.random()).slice(2)}`;
	const FAILED: Reply = { ok: false, error: 'Para Code could not handle this extension call' };
	// 拡張機能のコードが後から fetch を包んでも、詰め物の呼び出しを見たり壊したりできないよう今のものを持つ
	const nativeFetch = globalThis.fetch.bind(globalThis);
	// undefined を保つ JSON（paradisBrowserExtensionApiWire.ts と同じ形）
	const ESCAPE = String.fromCharCode(0);
	const encode = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => entry === undefined
		? ESCAPE
		: typeof entry === 'string' && entry.startsWith(ESCAPE) ? ESCAPE + entry : entry);
	const decode = (text: string): unknown => JSON.parse(text, (_key, entry: unknown) => typeof entry !== 'string' || !entry.startsWith(ESCAPE)
		? entry
		: entry === ESCAPE ? undefined : entry.slice(1));
	const isReply = (value: unknown): value is Reply => isRecord(value) && (value.ok === true || (value.ok === false && typeof value.error === 'string'));
	const tokenReady: Promise<string | undefined> = nativeFetch(options.tokenPath, { cache: 'no-store' })
		.then(response => response.ok ? response.json() : undefined)
		.then((value: unknown) => isRecord(value) && typeof value.token === 'string' ? value.token : undefined)
		.catch(() => undefined);
	// text/plain: 単純な要求にして、CORS の事前確認の往復を省く。トークンと文脈の名前は URL に書く（main が
	// 本文を読む前に確かめる）
	const post = (endpoint: string, token: string, body: unknown): Promise<Response> => nativeFetch(`${endpoint}?t=${encodeURIComponent(token)}&c=${encodeURIComponent(connection)}`, {
		method: 'POST',
		cache: 'no-store',
		headers: { 'content-type': 'text/plain' },
		body: encode(body),
	});
	const invoke = async (request: unknown): Promise<Reply> => {
		const token = await tokenReady;
		if (token === undefined) {
			return FAILED;
		}
		try {
			const reply = decode(await (await post(options.callUrl, token, { request })).text());
			return isReply(reply) ? reply : FAILED;
		} catch {
			return FAILED;
		}
	};
	const handlers: ((namespace: string, event: string, args: unknown[]) => void)[] = [];
	const deliver = (line: string): void => {
		let payload: unknown;
		try {
			payload = decode(line);
		} catch {
			return;
		}
		if (isRecord(payload) && typeof payload.namespace === 'string' && typeof payload.event === 'string' && Array.isArray(payload.args)) {
			for (const handler of handlers) {
				handler(payload.namespace, payload.event, payload.args);
			}
		}
	};
	const readLines = async (body: ReadableStream<Uint8Array>): Promise<void> => {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffered = '';
		try {
			for (; ;) {
				const { value, done } = await reader.read();
				if (done) {
					return;
				}
				buffered += decoder.decode(value, { stream: true });
				let newline = buffered.indexOf('\n');
				while (newline >= 0) {
					deliver(buffered.slice(0, newline));
					buffered = buffered.slice(newline + 1);
					newline = buffered.indexOf('\n');
				}
			}
		} catch {
			// 途切れた。呼び出し側がつなぎ直す
		}
	};
	// 受け手の登録の最後の状態（つなぎ直した後に送り直し、main が溜めたイベントを出させる）
	const listening = new Map<string, { readonly namespace: string; readonly event: string }>();
	// 登録と解除は順に、イベントの応答が開いてから main へ届ける（止まっていた worker へ溜めたイベントは、
	// 受け手の登録で出るため）
	let markConnected: () => void = () => { };
	let listenChain: Promise<unknown> = new Promise<void>(resolve => markConnected = resolve);
	const sendListen = (namespace: string, event: string, active: boolean): void => {
		listenChain = listenChain.then(() => invoke({ type: 'listen', namespace, event, active }));
	};
	const connectEvents = async (): Promise<void> => {
		const token = await tokenReady;
		let connectedBefore = false;
		while (token !== undefined) {
			let response: Response | undefined;
			try {
				response = await post(options.eventsUrl, token, {});
			} catch {
				response = undefined;
			}
			if (response && !response.ok) {
				break;
			}
			if (response?.body) {
				if (!connectedBefore) {
					connectedBefore = true;
					markConnected();
				} else {
					for (const entry of listening.values()) {
						sendListen(entry.namespace, entry.event, true);
					}
				}
				await readLines(response.body);
			}
			await new Promise(resolve => setTimeout(resolve, options.reconnectDelayMs));
		}
		markConnected();
	};
	const bridge: IParadisShimBridge = {
		call: (namespace, method, args) => invoke({ type: 'call', namespace, method, args }),
		listen: (namespace, event, active) => {
			const key = `${namespace}.${event}`;
			if (active) {
				listening.set(key, { namespace, event });
			} else {
				listening.delete(key);
			}
			sendListen(namespace, event, active);
		},
		onEvent: handler => {
			handlers.push(handler);
		},
	};
	void connectEvents();
	options.installApis(bridge, options.surface);
	options.installStorageRelay(bridge, isWorker ? 'worker' : 'page', options.relayNamespace);
	options.installStorageSync(bridge, options.syncConstants, options.syncNamespace);
}
