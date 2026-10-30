/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/preload/browser-extension-worker-shim.ts, src/preload/browser-extension-main-world.ts, src/preload/browser-extension-storage-relay.ts, src/preload/browser-extension-storage-sync.ts, src/preload/browser-extension-api-surface.ts, src/preload/browser-extension-inert-apis.ts, src/preload/browser-extension-content-script-relay.ts, src/preload/browser-extension-content-script-api.ts, src/preload/browser-extension-event-filters.ts, src/preload/browser-extension-native-messaging.ts

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
	/** manifest_version がこれのときだけ足す（chrome.browserAction があれば MV2 とみなすコードがあるため）。 */
	readonly manifestVersion?: number;
	readonly methods: readonly string[];
	readonly events: readonly string[];
	readonly constants?: Readonly<Record<string, number | Readonly<Record<string, string>>>>;
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

/** chrome.action の関数（main の登録と同じもの）。 */
const PARADIS_SHIM_ACTION_METHODS: readonly string[] = [
	'setTitle', 'getTitle', 'setIcon', 'setPopup', 'getPopup', 'setBadgeText', 'getBadgeText', 'setBadgeBackgroundColor', 'getBadgeBackgroundColor',
	'setBadgeTextColor', 'getBadgeTextColor', 'enable', 'disable', 'isEnabled', 'getUserSettings', 'openPopup',
];

/** chrome に足す API（main の登録と同じものを並べる。テストが突き合わせる）。 */
export const PARADIS_SHIM_SURFACE: ParadisShimSurface = {
	// Electron は onInstalled・onStartup を出さない。Para Code が拡張機能の読み込みの後に出す
	runtime: { methods: ['openOptionsPage'], events: ['onInstalled', 'onStartup'] },
	tabs: {
		methods: ['query', 'get', 'getCurrent', 'create', 'duplicate', 'remove', 'update', 'goBack', 'goForward', 'captureVisibleTab'],
		events: ['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onReplaced'],
		constants: { TAB_ID_NONE: -1 },
	},
	windows: {
		methods: ['getAll', 'get', 'getCurrent', 'getLastFocused', 'create', 'update', 'remove'],
		events: ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged'],
		constants: { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 },
	},
	webNavigation: {
		permission: 'webNavigation',
		methods: ['getFrame', 'getAllFrames'],
		events: ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onCreatedNavigationTarget'],
	},
	// ツールバーのボタン（P5）。Electron の chrome.action は何も覚えないので、全部を Para Code のものにする。
	// MV2 の名前 browserAction も同じもの
	action: { manifestVersion: 3, methods: PARADIS_SHIM_ACTION_METHODS, events: ['onClicked', 'onUserSettingsChanged'] },
	browserAction: { manifestVersion: 2, methods: PARADIS_SHIM_ACTION_METHODS, events: ['onClicked', 'onUserSettingsChanged'] },
	// 右クリックの項目とショートカット（P5b）。contextMenus.create は id をその場で返す（下の paradisInstallExtensionApis）
	contextMenus: { permission: 'contextMenus', methods: ['create', 'update', 'remove', 'removeAll'], events: ['onClicked'], constants: { ACTION_MENU_TOP_LEVEL_LIMIT: 6 } },
	commands: { methods: ['getAll'], events: ['onCommand'] },
	// P5c。後から許される権限（optional_permissions）でも足しておく。main は許されるまで断る
	permissions: { methods: ['contains', 'getAll', 'request', 'remove'], events: ['onAdded', 'onRemoved'] },
	notifications: { permission: 'notifications', methods: ['create', 'update', 'clear', 'getAll', 'getPermissionLevel'], events: ['onClicked', 'onButtonClicked', 'onClosed', 'onPermissionLevelChanged'], constants: { TemplateType: { BASIC: 'basic', IMAGE: 'image', LIST: 'list', PROGRESS: 'progress' } } },
	cookies: { permission: 'cookies', methods: ['get', 'getAll', 'set', 'remove', 'getAllCookieStores'], events: ['onChanged'] },
	downloads: { permission: 'downloads', methods: ['download'], events: ['onCreated', 'onChanged'] },
	management: { permission: 'management', methods: ['getAll', 'get', 'setEnabled'], events: [] },
	// P9d。パネルは Para Code のウィンドウの中、内蔵ブラウザのタブの右に出す（main の paradisBrowserExtensionSidePanel.ts）
	sidePanel: { permission: 'sidePanel', methods: ['setOptions', 'getOptions', 'setPanelBehavior', 'getPanelBehavior', 'getLayout', 'open', 'close'], events: ['onOpened', 'onClosed'] },
	// P9a。呼び出し元のセッションのウェブのデータだけを消す（main の paradisBrowserExtensionBrowsingData.ts）
	browsingData: {
		permission: 'browsingData',
		methods: ['remove', 'settings', 'removeAppcache', 'removeCache', 'removeCacheStorage', 'removeCookies', 'removeDownloads', 'removeFileSystems', 'removeFormData', 'removeHistory', 'removeIndexedDB', 'removeLocalStorage', 'removePasswords', 'removePluginData', 'removeServiceWorkers', 'removeWebSQL'],
		events: [],
	},
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
	// action.setIcon: ImageData は JSON にすると中身が消えるので、幅・高さ・画素の並びにする。path は呼んだ
	// スクリプト（worker の入口は元の worker と同じフォルダにある）・ページから見た URL にしてから送る（Chrome と同じ解決）
	const isImageData = (value: unknown): value is { readonly width: number; readonly height: number; readonly data: ArrayLike<number> } =>
		isObject(value) && typeof value.width === 'number' && typeof value.height === 'number' && isObject(value.data) && typeof (value.data as { length?: unknown }).length === 'number';
	const plainImage = (value: { readonly width: number; readonly height: number; readonly data: ArrayLike<number> }) => ({ width: value.width, height: value.height, data: Array.from(value.data) });
	const resolvePath = (value: unknown): unknown => {
		if (typeof value !== 'string') {
			return value;
		}
		try {
			return new URL(value, (globalThis as { location?: { href?: string } }).location?.href).href;
		} catch {
			return value;
		}
	};
	const prepareIconDetails = (details: ApiObject): ApiObject => {
		const next: ApiObject = { ...details };
		const imageData = details.imageData;
		if (isImageData(imageData)) {
			next.imageData = plainImage(imageData);
		} else if (isObject(imageData)) {
			next.imageData = Object.fromEntries(Object.entries(imageData).map(([size, image]) => [size, isImageData(image) ? plainImage(image) : image]));
		}
		const path = details.path;
		if (typeof path === 'string') {
			next.path = resolvePath(path);
		} else if (isObject(path)) {
			next.path = Object.fromEntries(Object.entries(path).map(([size, value]) => [size, resolvePath(value)]));
		}
		return next;
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
		if ((namespace === 'action' || namespace === 'browserAction') && name === 'setIcon' && isObject(args[0])) {
			args[0] = prepareIconDetails(args[0]);
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
	// webNavigation の受け手の絞り込み（events.UrlFilter の並び）。どれかに当たればその受け手に出す
	const matchesUrlFilter = (rawUrl: string, filter: unknown): boolean => {
		if (!isObject(filter)) {
			return true;
		}
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return false;
		}
		const host = url.hostname;
		const path = url.pathname;
		const query = url.search.replace(/^\?/, '');
		const plain = rawUrl.split('#')[0];
		const checks: Record<string, (value: string) => boolean> = {
			hostContains: value => `.${host}`.includes(value),
			hostEquals: value => host === value,
			hostPrefix: value => host.startsWith(value),
			hostSuffix: value => host.endsWith(value),
			pathContains: value => path.includes(value),
			pathEquals: value => path === value,
			pathPrefix: value => path.startsWith(value),
			pathSuffix: value => path.endsWith(value),
			queryContains: value => query.includes(value),
			queryEquals: value => query === value,
			queryPrefix: value => query.startsWith(value),
			querySuffix: value => query.endsWith(value),
			urlContains: value => plain.includes(value),
			urlEquals: value => plain === value,
			urlPrefix: value => plain.startsWith(value),
			urlSuffix: value => plain.endsWith(value),
			urlMatches: value => {
				try {
					return new RegExp(value).test(plain);
				} catch {
					return false;
				}
			},
		};
		for (const [key, value] of Object.entries(filter)) {
			if (key === 'schemes' && Array.isArray(value) && !value.includes(url.protocol.slice(0, -1))) {
				return false;
			}
			if (key === 'ports' && Array.isArray(value)) {
				const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
				if (!value.some(entry => Array.isArray(entry) ? port >= entry[0] && port <= entry[1] : entry === port)) {
					return false;
				}
			}
			if (typeof value === 'string' && checks[key] && !checks[key](value)) {
				return false;
			}
		}
		return true;
	};
	const passesFilter = (args: readonly unknown[], filter: unknown): boolean => {
		if (!isObject(filter) || !Array.isArray(filter.url)) {
			return true;
		}
		const details = args[0];
		const url = isObject(details) ? details.url : undefined;
		return typeof url === 'string' && filter.url.some(entry => matchesUrlFilter(url, entry));
	};
	// 受け手 → その絞り込み
	const listeners = new Map<string, Map<Callable, unknown>>();
	bridge.onEvent((namespace, event, args) => {
		for (const [callback, filter] of listeners.get(`${namespace}.${event}`) ?? []) {
			if (!passesFilter(args, filter)) {
				continue;
			}
			try {
				callback(...args);
			} catch (error) {
				console.error(error);
			}
		}
	});
	const makeEvent = (namespace: string, name: string): ApiObject => {
		const key = `${namespace}.${name}`;
		const registered = listeners.get(key) ?? new Map<Callable, unknown>();
		listeners.set(key, registered);
		return {
			addListener: (callback: unknown, filter?: unknown) => {
				if (!isCallable(callback) || registered.has(callback)) {
					return;
				}
				registered.set(callback, filter);
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
	// chrome.contextMenus: create は id をその場で返す（Chrome と同じ。無ければここで決める）。onclick（関数）は main へ
	// 送れないので、この文脈に覚えておき、onClicked で呼ぶ
	const menuClicks = new Map<string, Callable>();
	let nextMenuId = 1 + Math.floor(Math.random() * 1_000_000_000);
	let listeningMenuClicks = false;
	const keepOnclick = (id: unknown, onclick: unknown): void => {
		const key = JSON.stringify(id);
		if (!isCallable(onclick)) {
			return;
		}
		menuClicks.set(key, onclick);
		const menusApi = chromeApi.contextMenus;
		const onClicked = isObject(menusApi) && isObject(menusApi.onClicked) ? menusApi.onClicked : undefined;
		if (!listeningMenuClicks && onClicked && isCallable(onClicked.addListener)) {
			listeningMenuClicks = true;
			onClicked.addListener((info: unknown, tab: unknown) => menuClicks.get(JSON.stringify(isObject(info) ? info.menuItemId : undefined))?.(info, tab));
		}
	};
	const makeMenuMethod = (name: string) => {
		const base = makeMethod('contextMenus', name) as (...args: unknown[]) => unknown;
		const run = (args: unknown[]): unknown => {
			const result = base(...args);
			// コールバックの無い呼び出しの失敗は、Chrome と同じくコンソールに出すだけ
			if (result instanceof Promise) {
				result.catch((error: unknown) => console.error(error));
			}
			return result;
		};
		if (name === 'create') {
			return function paradisContextMenusCreate(properties?: unknown, callback?: unknown): unknown {
				const details: ApiObject = isObject(properties) ? { ...properties } : {};
				if (details.id === undefined) {
					details.id = nextMenuId++;
				}
				keepOnclick(details.id, details.onclick);
				delete details.onclick;
				run(isCallable(callback) ? [details, callback] : [details]);
				return details.id;
			};
		}
		if (name === 'update') {
			return function paradisContextMenusUpdate(id?: unknown, properties?: unknown, callback?: unknown): unknown {
				const details: ApiObject = isObject(properties) ? { ...properties } : {};
				keepOnclick(id, details.onclick);
				delete details.onclick;
				return run(isCallable(callback) ? [id, details, callback] : [id, details]);
			};
		}
		return function paradisContextMenusMethod(...args: unknown[]): unknown {
			if (name === 'removeAll') {
				menuClicks.clear();
			} else if (name === 'remove') {
				menuClicks.delete(JSON.stringify(args[0]));
			}
			return run(args);
		};
	};
	const manifest = readManifest();
	// 後から許可される権限（optional_permissions）でも足しておく。main は許可されるまで断る
	const permissions = [manifest.permissions, manifest.optional_permissions].flatMap(list => Array.isArray(list) ? list : []);
	for (const [namespace, spec] of Object.entries(surface)) {
		if (spec.permission !== undefined && ![spec.permission].flat().some(name => permissions.includes(name))) {
			continue;
		}
		if (spec.manifestVersion !== undefined && manifest.manifest_version !== spec.manifestVersion) {
			continue;
		}
		const existing = chromeApi[namespace];
		const target: ApiObject = isObject(existing) ? existing : {};
		const members: [string, unknown][] = [
			...spec.methods.map((name): [string, unknown] => [name, namespace === 'contextMenus' ? makeMenuMethod(name) : makeMethod(namespace, name)]),
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
export function paradisInstallStorageRelay(bridge: IParadisShimBridge, context: 'page' | 'worker', relayNamespace: string): ((areaName: string, changes: Record<string, unknown>) => void) | undefined {
	type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	if (!isObject(chromeApi) || !isObject(chromeApi.storage)) {
		return undefined;
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
	// worker: content script（ウェブページの中）からの知らせを受けて出す口
	return events ? (areaName: string, changes: Record<string, unknown>) => deliver(areaName, changes) : undefined;
}

export function paradisInstallStorageSync(
	bridge: IParadisShimBridge,
	constants: Readonly<Record<string, number>>,
	syncNamespace: string,
	/** worker だけ: 見えた sync の変化を content script へも渡す（`from` はその変化を起こした content script）。 */
	forward?: (changes: Record<string, unknown>, from?: string) => void,
): ((method: string, args: unknown[], from?: string) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }>) | undefined {
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	if (!isObject(chromeApi) || !isObject(chromeApi.storage)) {
		return undefined;
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
		// content script へ渡すときは、ほかの文脈の変化も受けていなければならない
		const active = forward !== undefined || [areaListeners, ...storageListeners].some(set => set.size > 0);
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
	const deliver = (changes: ApiObject, from?: string): void => {
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
		forward?.(changes, from);
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
	// content script の代わりに呼ぶ口（worker が content script からの中継に答えるのに使う）
	const relayable = new Set(['get', 'getKeys', 'getBytesInUse', ...writes]);
	return async (name, args, from) => {
		if (!relayable.has(name)) {
			return { ok: false, error: `storage.sync.${name} is not available here` };
		}
		const reply = await bridge.call(syncNamespace, name, args.map(toWire));
		if (reply.ok && writes.has(name) && isObject(reply.value) && Object.keys(reply.value).length > 0) {
			deliver(reply.value, from);
		}
		return reply;
	};
}

/** content script と worker の間の中継の印（runtime のメッセージに付ける。拡張機能自身の onMessage には見せない）。 */
export const PARADIS_SHIM_CONTENT_SCRIPT_RELAY_KEY = 'paradisContentScriptRelay';

/**
 * Para Code での答えが決まっている API（企業のポリシー・シークレット・オムニボックス・フォントの設定）を、
 * Chrome と同じ形の空の答えで足す。拡張機能は起動のときにこれらに触るので、main へ聞かずにここで答える。
 * すでにあるものはそのまま（storage.managed だけは、Electron が「使えない」と失敗するので置き換える）。
 */
export function paradisInstallInertApis(context: 'page' | 'worker' | 'content-script'): void {
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	if (!isObject(chromeApi)) {
		return;
	}
	const apis = isObject(root.browser) && root.browser !== chromeApi ? [chromeApi, root.browser] : [chromeApi];
	let manifest: ApiObject = {};
	try {
		const runtime = chromeApi.runtime;
		const getManifest = isObject(runtime) ? runtime.getManifest : undefined;
		const value: unknown = isCallable(getManifest) ? getManifest.call(runtime) : undefined;
		manifest = isObject(value) ? value : {};
	} catch {
		manifest = {};
	}
	const permissions = [manifest.permissions, manifest.optional_permissions].flatMap(list => Array.isArray(list) ? list : []);
	const define = (target: ApiObject, key: string, value: unknown): void => {
		try {
			Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
		} catch {
			// 凍った本物のオブジェクト: そのままにする
		}
	};
	// Chrome の形: 最後の引数がコールバックなら後で呼び、無ければ Promise
	const answer = (result: () => unknown) => (...args: unknown[]): unknown => {
		const last = [...args].reverse().find(arg => arg !== undefined);
		if (isCallable(last)) {
			void Promise.resolve().then(() => last(result()));
			return undefined;
		}
		return Promise.resolve(result());
	};
	const inertEvent = (): ApiObject => {
		const listeners = new Set<unknown>();
		return {
			addListener: (callback: unknown) => {
				listeners.add(callback);
			},
			removeListener: (callback: unknown) => {
				listeners.delete(callback);
			},
			hasListener: (callback: unknown) => listeners.has(callback),
			hasListeners: () => listeners.size > 0,
		};
	};
	const install = (namespace: string, members: ApiObject, options: { readonly replace?: readonly string[]; readonly existingOnly?: boolean } = {}): void => {
		for (const api of apis) {
			let target: unknown = api;
			for (const key of namespace.split('.')) {
				const parent: ApiObject = isObject(target) ? target : {};
				let next = parent[key];
				if (!isObject(next) && !options.existingOnly) {
					next = {};
					define(parent, key, next);
				}
				target = next;
			}
			if (!isObject(target)) {
				continue;
			}
			for (const [key, value] of Object.entries(members)) {
				if (target[key] === undefined || options.replace?.includes(key)) {
					define(target, key, value);
				}
			}
		}
	};
	// 企業のポリシーが無い Chrome: 空の、読むだけの場所
	install('storage.managed', {
		get: answer(() => ({})),
		getKeys: answer(() => []),
		getBytesInUse: answer(() => 0),
		onChanged: inertEvent(),
	}, { replace: ['get', 'getKeys', 'getBytesInUse'], existingOnly: true });
	if (context !== 'worker') {
		// 開いた shadow root だけ（isolated world からは、ページが付けた閉じた root は見えない）
		install('dom', { openOrClosedShadowRoot: (element: unknown) => isObject(element) && isObject(element.shadowRoot) ? element.shadowRoot : null });
	}
	if (context === 'content-script') {
		install('extension', { inIncognitoContext: false });
		return;
	}
	if (context === 'page') {
		// ほかの拡張機能のページの window は渡せない
		install('extension', { getViews: () => [] });
	}
	// ファイルの URL とシークレットのウィンドウへの許可（Para Code はどちらも出さない。allowFileAccess: false で読み込み、シークレットの
	// ウィンドウは無い）。Electron 43 には無く、Dark Reader などが呼んで落ちる（互換性の確かめで見つけた）
	install('extension', { isAllowedFileSchemeAccess: answer(() => false), isAllowedIncognitoAccess: answer(() => false) });
	install('runtime', { onPerformanceWarning: inertEvent() });
	install('permissions', { addHostAccessRequest: answer(() => undefined), removeHostAccessRequest: answer(() => undefined) });
	if (manifest.omnibox !== undefined) {
		install('omnibox', {
			setDefaultSuggestion: answer(() => undefined),
			onInputStarted: inertEvent(),
			onInputChanged: inertEvent(),
			onInputEntered: inertEvent(),
			onInputCancelled: inertEvent(),
			onDeleteSuggestion: inertEvent(),
			OnInputEnteredDisposition: { CURRENT_TAB: 'currentTab', NEW_FOREGROUND_TAB: 'newForegroundTab', NEW_BACKGROUND_TAB: 'newBackgroundTab' },
		});
	}
	// 断る答え（Chrome の形: コールバックなら runtime.lastError を立てて呼び、無ければ拒む Promise）
	const refuse = (message: string) => (...args: unknown[]): unknown => {
		const last = [...args].reverse().find(arg => arg !== undefined);
		if (isCallable(last)) {
			const runtime = chromeApi.runtime;
			void Promise.resolve().then(() => {
				let defined = false;
				if (isObject(runtime)) {
					try {
						Object.defineProperty(runtime, 'lastError', { configurable: true, enumerable: true, get: () => ({ message }) });
						defined = true;
					} catch {
						// 置き換えられない lastError
					}
				}
				try {
					last();
				} finally {
					if (defined && isObject(runtime)) {
						try {
							delete runtime.lastError;
						} catch {
							// 消せない
						}
					}
				}
			});
			return undefined;
		}
		return Promise.reject(new Error(message));
	};
	// 以下は Electron 43 に無く、在ることを前提に起動のときから読む拡張機能があるもの（互換性の確かめで、worker が落ちるのを見つけた）。
	// どれも Para Code では働かない形で足す（できたふりはしない）
	if (permissions.includes('identity')) {
		// Google へのサインイン（getAuthToken）とウェブの認証の窓（launchWebAuthFlow）は Para Code に無い
		const runtimeId = isObject(chromeApi.runtime) && typeof chromeApi.runtime.id === 'string' ? chromeApi.runtime.id : '';
		install('identity', {
			getAuthToken: refuse('Para Code does not support signing in to Google from browser extensions'),
			launchWebAuthFlow: refuse('Para Code does not support chrome.identity.launchWebAuthFlow'),
			getProfileUserInfo: answer(() => ({ email: '', id: '' })),
			getAccounts: answer(() => []),
			removeCachedAuthToken: answer(() => undefined),
			clearAllCachedAuthTokens: answer(() => undefined),
			getRedirectURL: (path?: unknown) => `https://${runtimeId}.chromiumapp.org/${typeof path === 'string' ? path.replace(/^\/+/, '') : ''}`,
			onSignInChanged: inertEvent(),
			AccountStatus: { SYNC: 'SYNC', ANY: 'ANY' },
		});
	}
	if (permissions.includes('debugger')) {
		// ページへのデバッガーの接続は渡さない（CDP の力はエージェントと拡張機能を分ける守りに関わる）
		install('debugger', {
			attach: refuse('Para Code does not let browser extensions attach a debugger'),
			detach: refuse('Debugger is not attached'),
			sendCommand: refuse('Debugger is not attached'),
			getTargets: answer(() => []),
			onEvent: inertEvent(),
			onDetach: inertEvent(),
		});
	}
	if (permissions.includes('fontSettings')) {
		const generic = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
		install('fontSettings', {
			getFontList: answer(() => generic.map(fontId => ({ fontId, displayName: fontId }))),
			getFont: answer(() => ({ fontId: '', levelOfControl: 'not_controllable' })),
			setFont: answer(() => undefined),
			clearFont: answer(() => undefined),
			onFontChanged: inertEvent(),
		});
	}
}

/**
 * content script との中継の口（runtime.connect のポート、名前は `relayKey`）。拡張機能の runtime.onConnect の
 * 受け手には、このポートを見せない。`answer` を渡すと（worker）、拡張機能自身の content script（タブの中）からの
 * 頼みに答え、返り値の関数で sync の変化をつないでいる content script へ送る。ページは答えない（undefined を返す）。
 *
 * runtime のメッセージ（onMessage）は使わない。受け手を足すと、受け手の無い文脈への sendMessage が失敗せず
 * undefined を返すように変わってしまうため。
 */
export function paradisInstallContentScriptRelayHub(
	relayKey: string,
	answer?: (namespace: string, method: string, args: unknown[], from?: string) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }>,
): ((changes: Record<string, unknown>, from?: string) => void) | undefined {
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	const runtime = isObject(chromeApi) ? chromeApi.runtime : undefined;
	const native = isObject(runtime) ? runtime.onConnect : undefined;
	if (!isObject(runtime) || !isObject(native) || !isCallable(native.addListener)) {
		return undefined;
	}
	const nativeEvent = native;
	const call = (name: string, ...args: unknown[]): unknown => {
		const method = nativeEvent[name];
		return isCallable(method) ? method.apply(nativeEvent, args) : undefined;
	};
	const isRelayPort = (port: unknown): boolean => isObject(port) && port.name === relayKey;
	const wrapped = new Map<Callable, Callable>();
	const event: ApiObject = {
		addListener: (callback: unknown) => {
			if (!isCallable(callback) || wrapped.has(callback)) {
				return;
			}
			const listener: Callable = (port, ...rest) => isRelayPort(port) ? undefined : callback(port, ...rest);
			wrapped.set(callback, listener);
			call('addListener', listener);
		},
		removeListener: (callback: unknown) => {
			const listener = isCallable(callback) ? wrapped.get(callback) : undefined;
			if (listener && isCallable(callback)) {
				wrapped.delete(callback);
				call('removeListener', listener);
			}
		},
		hasListener: (callback: unknown) => isCallable(callback) && wrapped.has(callback),
		hasListeners: () => wrapped.size > 0,
	};
	const installed = new Set<object>();
	for (const api of [chromeApi, root.browser]) {
		const target = isObject(api) ? api.runtime : undefined;
		if (!isObject(target) || installed.has(target)) {
			continue;
		}
		installed.add(target);
		try {
			Object.defineProperty(target, 'onConnect', { value: event, configurable: true, enumerable: true, writable: true });
		} catch {
			// 凍った本物のオブジェクト: そのままにする
		}
	}
	if (!answer) {
		return undefined;
	}
	const ownId = runtime.id;
	const ports = new Set<ApiObject>();
	call('addListener', (port: unknown) => {
		const sender = isObject(port) ? port.sender : undefined;
		// つなぐのは、この拡張機能自身の content script（タブの中）だけ
		if (!isObject(port) || !isRelayPort(port) || !isObject(sender) || sender.id !== ownId || !isObject(sender.tab)) {
			return;
		}
		const onMessage = port.onMessage;
		const onDisconnect = port.onDisconnect;
		const post = port.postMessage;
		if (!isObject(onMessage) || !isCallable(onMessage.addListener) || !isCallable(post)) {
			return;
		}
		ports.add(port);
		if (isObject(onDisconnect) && isCallable(onDisconnect.addListener)) {
			onDisconnect.addListener(() => ports.delete(port));
		}
		onMessage.addListener((request: unknown) => {
			if (!isObject(request) || typeof request.id !== 'number' || typeof request.namespace !== 'string' || typeof request.method !== 'string' || !Array.isArray(request.args)) {
				return;
			}
			const id = request.id;
			const from = typeof request.from === 'string' ? request.from : undefined;
			const reply = (value: unknown) => {
				try {
					post.call(port, { id, reply: value });
				} catch {
					// content script のフレームが閉じた
				}
			};
			answer(request.namespace, request.method, request.args, from).then(reply, () => reply({ ok: false, error: 'Para Code could not handle this extension call' }));
		});
	});
	return (changes, from) => {
		for (const port of ports) {
			try {
				(port.postMessage as Callable).call(port, { changes, from });
			} catch {
				ports.delete(port);
			}
		}
	};
}

/**
 * content script から main への口。content script はウェブページの中で動き、私用スキームに届かない
 * （呼び出し元の origin がウェブページになる）ので、拡張機能自身の worker へポートでつないで頼み、worker が
 * main と話す。sync の変化も同じポートで届く（`from` で自分の書き込みを二重に出さない）。worker が止まって
 * ポートが切れたら、受けている間はつなぎ直す。
 */
export function paradisCreateContentScriptRelayBridge(relayKey: string, syncNamespace: string, reconnectDelayMs: number): IParadisShimBridge | undefined {
	type Reply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown };
	const chromeApi = isObject(root.chrome) ? root.chrome : undefined;
	const runtime = chromeApi && isObject(chromeApi.runtime) ? chromeApi.runtime : undefined;
	const connect = runtime?.connect;
	if (!runtime || !isCallable(connect)) {
		return undefined;
	}
	// worker が無い拡張機能は、中継に答える相手がいない
	let hasWorker = false;
	try {
		const getManifest = runtime.getManifest;
		const manifest: unknown = isCallable(getManifest) ? getManifest.call(runtime) : undefined;
		const background = isObject(manifest) ? manifest.background : undefined;
		hasWorker = isObject(background) && typeof background.service_worker === 'string';
	} catch {
		hasWorker = false;
	}
	if (!hasWorker) {
		return undefined;
	}
	const isReply = (value: unknown): value is Reply => isObject(value) && (value.ok === true || (value.ok === false && typeof value.error === 'string'));
	const from = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const handlers: ((namespace: string, event: string, args: unknown[]) => void)[] = [];
	const pending = new Map<number, (reply: Reply) => void>();
	let nextId = 1;
	let listening = false;
	let port: ApiObject | undefined;
	const open = (): ApiObject | undefined => {
		if (port) {
			return port;
		}
		let opened: unknown;
		try {
			opened = connect.call(runtime, { name: relayKey });
		} catch {
			return undefined;
		}
		const messages = isObject(opened) ? opened.onMessage : undefined;
		if (!isObject(opened) || !isObject(messages) || !isCallable(messages.addListener)) {
			return undefined;
		}
		const current = opened;
		port = current;
		messages.addListener((message: unknown) => {
			if (!isObject(message)) {
				return;
			}
			if (typeof message.id === 'number') {
				const resolve = pending.get(message.id);
				pending.delete(message.id);
				resolve?.(isReply(message.reply) ? message.reply : { ok: false, error: 'Para Code could not reach the extension' });
			} else if (isObject(message.changes) && message.from !== from) {
				for (const handler of handlers) {
					handler(syncNamespace, 'onChanged', [message.changes]);
				}
			}
		});
		const onDisconnect = current.onDisconnect;
		if (isObject(onDisconnect) && isCallable(onDisconnect.addListener)) {
			onDisconnect.addListener(() => {
				if (port === current) {
					port = undefined;
				}
				for (const resolve of pending.values()) {
					resolve({ ok: false, error: 'Para Code could not reach the extension' });
				}
				pending.clear();
				// worker が止まった。変化を受けている間は、つなぎ直す
				if (listening) {
					setTimeout(() => {
						if (listening) {
							open();
						}
					}, reconnectDelayMs);
				}
			});
		}
		return current;
	};
	return {
		call: (namespace, method, args) => new Promise<Reply>(resolve => {
			const current = open();
			const post = current?.postMessage;
			if (!current || !isCallable(post)) {
				resolve({ ok: false, error: 'Para Code could not reach the extension' });
				return;
			}
			const id = nextId++;
			pending.set(id, resolve);
			try {
				post.call(current, { id, namespace, method, args, from });
			} catch (error) {
				pending.delete(id);
				resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}),
		listen: (namespace, _event, active) => {
			if (namespace !== syncNamespace) {
				return;
			}
			listening = active;
			if (active) {
				open();
			}
		},
		onEvent: handler => {
			handlers.push(handler);
		},
	};
}

/** content script の詰め物に渡すもの（main が文字列にして埋め込む）。 */
export interface IParadisContentScriptOptions {
	readonly relayKey: string;
	readonly syncConstants: Readonly<Record<string, number>>;
	readonly relayNamespace: string;
	readonly syncNamespace: string;
	readonly installInertApis: typeof paradisInstallInertApis;
	readonly createContentScriptRelayBridge: typeof paradisCreateContentScriptRelayBridge;
	readonly reconnectDelayMs: number;
	readonly installStorageRelay: typeof paradisInstallStorageRelay;
	readonly installStorageSync: typeof paradisInstallStorageSync;
}

/**
 * content script の詰め物の入口（manifest の各 content script の先頭に入れる）。Chrome にあって Electron に
 * 無い content script の API を足し、worker がある拡張機能では chrome.storage.sync と、storage.local・session の
 * 書き込みの worker への知らせを、worker を通して行う。
 */
export function paradisContentScriptMain(options: IParadisContentScriptOptions): void {
	const root = globalThis as { chrome?: unknown; __paradisContentScriptApi?: true };
	// 同じフレームの content script は 1 つの world を共有するので、1 回だけ入れる
	if (root.__paradisContentScriptApi || root.chrome === null || typeof root.chrome !== 'object') {
		return;
	}
	root.__paradisContentScriptApi = true;
	options.installInertApis('content-script');
	const bridge = options.createContentScriptRelayBridge(options.relayKey, options.syncNamespace, options.reconnectDelayMs);
	if (bridge) {
		// storage.local・session の書き込みは 'page' と同じく知らせ（中継で worker へ届く）、sync は worker を通す
		options.installStorageRelay(bridge, 'page', options.relayNamespace);
		options.installStorageSync(bridge, options.syncConstants, options.syncNamespace);
	}
}

/** main だけが使う、chrome.tts の名前空間（chrome には出さない）。main の登録と同じ名前。 */
export const PARADIS_SHIM_TTS_NAMESPACE = 'paradisTts';

/**
 * chrome.tts（P9a）。manifest に tts がある拡張機能だけ。読み上げは main が OS の読み上げで行い、出来事（start・word・end など）を
 * この文脈へ返す。speak の options.onEvent（関数）はここに残し、main には読み上げの id だけを渡す。
 */
export function paradisInstallTts(bridge: IParadisShimBridge, namespace: string): void {
	type ApiObject = Record<string, unknown>;
	type Callable = (...args: unknown[]) => unknown;
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	const runtime = isObject(chromeApi) && isObject(chromeApi.runtime) ? chromeApi.runtime : undefined;
	if (!isObject(chromeApi) || !runtime) {
		return;
	}
	let manifest: unknown;
	try {
		manifest = isCallable(runtime.getManifest) ? runtime.getManifest.call(runtime) : undefined;
	} catch {
		manifest = undefined;
	}
	const declared = isObject(manifest) ? [manifest.permissions, manifest.optional_permissions].flatMap(list => Array.isArray(list) ? list : []) : [];
	if (!declared.includes('tts')) {
		return;
	}
	const settle = (callback: unknown, reply: Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }>): unknown => {
		if (isCallable(callback)) {
			void reply.then(result => {
				let defined = false;
				if (!result.ok) {
					try {
						Object.defineProperty(runtime, 'lastError', { configurable: true, enumerable: true, get: () => ({ message: result.error }) });
						defined = true;
					} catch {
						// 置き換えられない lastError
					}
				}
				try {
					if (result.ok && result.value !== undefined) {
						callback(result.value);
					} else {
						callback();
					}
				} finally {
					if (defined) {
						try {
							delete runtime.lastError;
						} catch {
							// 消せない
						}
					}
				}
			});
			return undefined;
		}
		return reply.then(result => {
			if (!result.ok) {
				throw new Error(result.error);
			}
			return result.value;
		});
	};
	const handlers = new Map<string, Callable>();
	let listening = false;
	let counter = 0;
	bridge.onEvent((eventNamespace, event, args) => {
		if (eventNamespace !== namespace || event !== 'onUtteranceEvent' || typeof args[0] !== 'string' || !isObject(args[1])) {
			return;
		}
		const handler = handlers.get(args[0]);
		const type = args[1].type;
		if (type === 'end' || type === 'interrupted' || type === 'cancelled' || type === 'error') {
			handlers.delete(args[0]);
		}
		try {
			handler?.(args[1]);
		} catch (error) {
			console.error(error);
		}
	});
	const call = (method: string, args: unknown[]) => bridge.call(namespace, method, args);
	const last = (input: unknown[]) => input.length > 0 && isCallable(input[input.length - 1]) ? input[input.length - 1] : undefined;
	const tts: ApiObject = {
		speak: (utterance: unknown, ...rest: unknown[]) => {
			const callback = last(rest);
			const options = isObject(rest[0]) ? rest[0] : {};
			counter += 1;
			const requestId = `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2)}`;
			if (isCallable(options.onEvent)) {
				handlers.set(requestId, options.onEvent);
				if (!listening) {
					listening = true;
					bridge.listen(namespace, 'onUtteranceEvent', true);
				}
			}
			const plain: ApiObject = {};
			for (const key of ['enqueue', 'lang', 'rate', 'pitch', 'volume', 'voiceName']) {
				if (options[key] !== undefined) {
					plain[key] = options[key];
				}
			}
			return settle(callback, call('speak', [requestId, typeof utterance === 'string' ? utterance : String(utterance), plain]));
		},
		stop: () => {
			void call('stop', []);
		},
		pause: () => {
			void call('pause', []);
		},
		resume: () => {
			void call('resume', []);
		},
		isSpeaking: (...input: unknown[]) => settle(last(input), call('isSpeaking', [])),
		getVoices: (...input: unknown[]) => settle(last(input), call('getVoices', [])),
		onVoicesChanged: { addListener: () => { }, removeListener: () => { }, hasListener: () => false, hasListeners: () => false },
		EventType: { START: 'start', END: 'end', WORD: 'word', SENTENCE: 'sentence', MARKER: 'marker', INTERRUPTED: 'interrupted', CANCELLED: 'cancelled', ERROR: 'error', PAUSE: 'pause', RESUME: 'resume' },
		VoiceGender: { MALE: 'male', FEMALE: 'female' },
	};
	for (const target of isObject(root.browser) && root.browser !== chromeApi ? [chromeApi, root.browser] : [chromeApi]) {
		try {
			Object.defineProperty(target, 'tts', { value: tts, configurable: true, enumerable: true, writable: true });
		} catch {
			// 凍った物は触らない
		}
	}
}

/**
 * chrome.desktopCapture・chrome.tabCapture（P9e）。録画は安全のため Para Code では使えない（拡張機能のページに画面の取得の権限を
 * 渡すと、Electron 43 では生の画面 id の getUserMedia を区別して断れないため）。manifest にある拡張機能には、Chrome と同じ形で
 * 失敗を返す API を足す（API が無いと、起動のときに落ちる拡張機能がある）。
 */
export function paradisInstallCapture(): void {
	type ApiObject = Record<string, unknown>;
	type Callable = (...args: unknown[]) => unknown;
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	const runtime = isObject(chromeApi) && isObject(chromeApi.runtime) ? chromeApi.runtime : undefined;
	if (!isObject(chromeApi) || !runtime) {
		return;
	}
	let manifest: unknown;
	try {
		manifest = isCallable(runtime.getManifest) ? runtime.getManifest.call(runtime) : undefined;
	} catch {
		manifest = undefined;
	}
	const declared = isObject(manifest) ? [manifest.permissions, manifest.optional_permissions].flatMap(list => Array.isArray(list) ? list : []) : [];
	const message = 'Para Code does not support screen and tab capture in browser extensions';
	const fail = (callback: unknown, ...values: unknown[]): unknown => {
		if (!isCallable(callback)) {
			return Promise.reject(new Error(message));
		}
		queueMicrotask(() => {
			let defined = false;
			try {
				Object.defineProperty(runtime, 'lastError', { configurable: true, enumerable: true, get: () => ({ message }) });
				defined = true;
			} catch {
				// 置き換えられない lastError
			}
			try {
				callback(...values);
			} finally {
				if (defined) {
					try {
						delete runtime.lastError;
					} catch {
						// 消せない
					}
				}
			}
		});
		return undefined;
	};
	const last = (input: unknown[]) => input.length > 0 && isCallable(input[input.length - 1]) ? input[input.length - 1] : undefined;
	const inertEvent = { addListener: () => { }, removeListener: () => { }, hasListener: () => false, hasListeners: () => false };
	const targets = isObject(root.browser) && root.browser !== chromeApi ? [chromeApi, root.browser] : [chromeApi];
	const define = (name: string, value: ApiObject) => {
		for (const target of targets) {
			try {
				Object.defineProperty(target, name, { value, configurable: true, enumerable: true, writable: true });
			} catch {
				// 凍った物は触らない
			}
		}
	};
	if (declared.includes('desktopCapture')) {
		let nextId = 0;
		define('desktopCapture', {
			// Chrome は取り消しと同じく、空の stream id で答える
			chooseDesktopMedia: (...input: unknown[]) => {
				nextId += 1;
				fail(last(input), '', { canRequestAudioTrack: false });
				return nextId;
			},
			cancelChooseDesktopMedia: () => { },
			DesktopCaptureSourceType: { SCREEN: 'screen', WINDOW: 'window', TAB: 'tab', AUDIO: 'audio' },
		});
	}
	if (declared.includes('tabCapture')) {
		define('tabCapture', {
			capture: (_options: unknown, callback: unknown) => {
				fail(isCallable(callback) ? callback : () => { }, null);
			},
			getMediaStreamId: (...input: unknown[]) => fail(last(input)),
			getCapturedTabs: (...input: unknown[]) => {
				const callback = last(input);
				if (isCallable(callback)) {
					queueMicrotask(() => callback([]));
					return undefined;
				}
				return Promise.resolve([]);
			},
			onStatusChanged: inertEvent,
			TabCaptureState: { PENDING: 'pending', ACTIVE: 'active', STOPPED: 'stopped', ERROR: 'error' },
		});
	}
}

/** main だけが使う、chrome.privacy の名前空間（chrome には出さない）。main の登録と同じ名前。 */
export const PARADIS_SHIM_PRIVACY_NAMESPACE = 'paradisPrivacy';

/**
 * chrome.privacy（P8）。manifest に privacy（後から許されるものも）がある拡張機能だけ。Para Code が本当に効かせられるのは
 * `network.webRTCIPHandlingPolicy` だけで、main がその場所の利用者のタブへ webContents.setWebRTCIPHandlingPolicy で効かせる。
 * ほかの設定は Para Code に同じものが無いので、`not_controllable` と答え、set・clear は断る（守れたと思わせない）。
 */
export function paradisInstallPrivacy(bridge: IParadisShimBridge, namespace: string): void {
	type ApiObject = Record<string, unknown>;
	type Callable = (...args: unknown[]) => unknown;
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	const runtime = isObject(chromeApi) && isObject(chromeApi.runtime) ? chromeApi.runtime : undefined;
	if (!isObject(chromeApi) || !runtime) {
		return;
	}
	let manifest: unknown;
	try {
		manifest = isCallable(runtime.getManifest) ? runtime.getManifest.call(runtime) : undefined;
	} catch {
		manifest = undefined;
	}
	const declared = isObject(manifest) ? [manifest.permissions, manifest.optional_permissions].flatMap(list => Array.isArray(list) ? list : []) : [];
	if (!declared.includes('privacy')) {
		return;
	}
	// コールバックなら runtime.lastError を立てて呼び、無ければ Promise
	const settle = (input: unknown[], reply: Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }>): unknown => {
		const last = input[input.length - 1];
		if (isCallable(last)) {
			void reply.then(result => {
				let defined = false;
				if (!result.ok) {
					try {
						Object.defineProperty(runtime, 'lastError', { configurable: true, enumerable: true, get: () => ({ message: result.error }) });
						defined = true;
					} catch {
						// 置き換えられない lastError
					}
				}
				try {
					if (result.ok && result.value !== undefined) {
						last(result.value);
					} else {
						last();
					}
				} finally {
					if (defined) {
						try {
							delete runtime.lastError;
						} catch {
							// 消せない
						}
					}
				}
			});
			return undefined;
		}
		return reply.then(result => {
			if (!result.ok) {
				throw new Error(result.error);
			}
			return result.value;
		});
	};
	const listeners = new Set<Callable>();
	const event = (shared: boolean): ApiObject => {
		const own = shared ? listeners : new Set<Callable>();
		return {
			addListener: (callback: unknown) => { if (isCallable(callback)) { own.add(callback); } },
			removeListener: (callback: unknown) => { if (isCallable(callback)) { own.delete(callback); } },
			hasListener: (callback: unknown) => isCallable(callback) && own.has(callback),
			hasListeners: () => own.size > 0,
		};
	};
	let listening = false;
	const controlled = (): ApiObject => ({
		get: (...input: unknown[]) => settle(input, bridge.call(namespace, 'get', [])),
		set: (details: unknown, ...rest: unknown[]) => settle(rest, bridge.call(namespace, 'set', [details])),
		clear: (details: unknown, ...rest: unknown[]) => settle(rest, bridge.call(namespace, 'clear', [details])),
		onChange: (() => {
			const api = event(true);
			const add = api.addListener as Callable;
			api.addListener = (callback: unknown) => {
				if (!listening) {
					listening = true;
					bridge.listen(namespace, 'onChange', true);
				}
				add(callback);
			};
			return api;
		})(),
	});
	const refused = 'Para Code does not have this setting, so browser extensions cannot control it';
	const fixed = (value: unknown): ApiObject => ({
		get: (...input: unknown[]) => settle(input, Promise.resolve({ ok: true as const, value: { value, levelOfControl: 'not_controllable' } })),
		set: (_details: unknown, ...rest: unknown[]) => settle(rest, Promise.resolve({ ok: false as const, error: refused })),
		clear: (_details: unknown, ...rest: unknown[]) => settle(rest, Promise.resolve({ ok: false as const, error: refused })),
		onChange: event(false),
	});
	bridge.onEvent((eventNamespace, name, args) => {
		if (eventNamespace === namespace && name === 'onChange') {
			for (const listener of listeners) {
				try {
					listener(...args);
				} catch (error) {
					console.error(error);
				}
			}
		}
	});
	const privacy: ApiObject = {
		network: { webRTCIPHandlingPolicy: controlled(), networkPredictionEnabled: fixed(false) },
		// Para Code には Chrome のパスワードの保存・自動入力などが無い（無効のまま変えられない）
		services: {
			passwordSavingEnabled: fixed(false), autofillEnabled: fixed(false), autofillAddressEnabled: fixed(false), autofillCreditCardEnabled: fixed(false),
			alternateErrorPagesEnabled: fixed(false), safeBrowsingEnabled: fixed(false), safeBrowsingExtendedReportingEnabled: fixed(false),
			searchSuggestEnabled: fixed(false), spellingServiceEnabled: fixed(false), translationServiceEnabled: fixed(false),
		},
		websites: {
			hyperlinkAuditingEnabled: fixed(true), referrersEnabled: fixed(true), doNotTrackEnabled: fixed(false), protectedContentEnabled: fixed(true),
			thirdPartyCookiesAllowed: fixed(true), topicsEnabled: fixed(false), fledgeEnabled: fixed(false), adMeasurementEnabled: fixed(false), relatedWebsiteSetsEnabled: fixed(false),
		},
		IPHandlingPolicy: { DEFAULT: 'default', DEFAULT_PUBLIC_AND_PRIVATE_INTERFACES: 'default_public_and_private_interfaces', DEFAULT_PUBLIC_INTERFACE_ONLY: 'default_public_interface_only', DISABLE_NON_PROXIED_UDP: 'disable_non_proxied_udp' },
	};
	for (const target of isObject(root.browser) && root.browser !== chromeApi ? [chromeApi, root.browser] : [chromeApi]) {
		try {
			Object.defineProperty(target, 'privacy', { value: privacy, configurable: true, enumerable: true, writable: true });
		} catch {
			// 凍った物は触らない
		}
	}
}

/** {@link paradisExtensionShimMain} に渡すもの（main が文字列にして埋め込む）。 */
/** main だけが使う、ネイティブメッセージングの名前空間（chrome には出さない）。main の登録と同じ名前。 */
export const PARADIS_SHIM_NATIVE_MESSAGING_NAMESPACE = 'paradisNativeMessaging';

/**
 * chrome.runtime.connectNative・sendNativeMessage（P6）。manifest に nativeMessaging（後から許されるものも）がある拡張機能だけ。
 * ポートの id はここで決め、main はそのポートの出来事を、開いた文脈（この worker・このページ）だけへ届ける。メッセージは
 * JSON の文字のまま運ぶ（ホストには拡張機能が JSON にしたものがそのまま届く）。
 */
export function paradisInstallNativeMessaging(bridge: IParadisShimBridge, namespace: string): void {
	type ApiObject = Record<string, unknown>;
	type Callable = (...args: unknown[]) => unknown;
	const portEvent = 'onPortEvent';
	const disconnectedError = 'Attempting to use a disconnected port object';
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown; browser?: unknown };
	const chromeApi = root.chrome;
	const runtime = isObject(chromeApi) && isObject(chromeApi.runtime) ? chromeApi.runtime : undefined;
	if (!runtime) {
		return;
	}
	let manifest: unknown;
	try {
		manifest = isCallable(runtime.getManifest) ? runtime.getManifest.call(runtime) : undefined;
	} catch {
		manifest = undefined;
	}
	const declared = isObject(manifest) ? [manifest.permissions, manifest.optional_permissions].flatMap(list => Array.isArray(list) ? list : []) : [];
	if (!declared.includes('nativeMessaging')) {
		return;
	}
	const callWithLastError = (message: string | undefined, callback: () => void): void => {
		let defined = false;
		if (message !== undefined) {
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
			if (defined) {
				try {
					delete runtime.lastError;
				} catch {
					// ignore
				}
			}
		}
	};
	const serialize = (message: unknown): string => {
		const json: unknown = JSON.stringify(message);
		if (typeof json !== 'string') {
			throw new Error('Could not serialize message.');
		}
		return json;
	};
	const makeEvent = () => {
		const listeners = new Set<Callable>();
		return {
			listeners,
			api: {
				addListener: (callback: unknown) => {
					if (isCallable(callback)) {
						listeners.add(callback);
					}
				},
				removeListener: (callback: unknown) => {
					if (isCallable(callback)) {
						listeners.delete(callback);
					}
				},
				hasListener: (callback: unknown) => isCallable(callback) && listeners.has(callback),
				hasListeners: () => listeners.size > 0,
			},
		};
	};
	const dispatch = (listeners: Set<Callable>, args: unknown[]): void => {
		for (const listener of listeners) {
			try {
				listener(...args);
			} catch (error) {
				console.error(error);
			}
		}
	};
	interface IPortState {
		state: 'starting' | 'open' | 'closed';
		readonly queued: string[];
		readonly onMessage: Set<Callable>;
		readonly onDisconnect: Set<Callable>;
		readonly port: ApiObject;
	}
	const ports = new Map<string, IPortState>();
	let counter = 0;
	const endPort = (id: string, entry: IPortState, error: string | undefined): void => {
		entry.state = 'closed';
		entry.queued.length = 0;
		ports.delete(id);
		if (error !== undefined && entry.onDisconnect.size === 0) {
			console.error(`Unchecked runtime.lastError: ${error}`);
		}
		callWithLastError(error, () => dispatch(entry.onDisconnect, [entry.port]));
	};
	bridge.onEvent((eventNamespace, event, args) => {
		if (eventNamespace !== namespace || event !== portEvent) {
			return;
		}
		const [id, kind, data] = args;
		const entry = typeof id === 'string' ? ports.get(id) : undefined;
		if (!entry || typeof id !== 'string' || typeof data !== 'string') {
			return;
		}
		if (kind === 'message') {
			let message: unknown;
			try {
				message = JSON.parse(data);
			} catch {
				return;
			}
			dispatch(entry.onMessage, [message, entry.port]);
		} else if (kind === 'disconnect') {
			endPort(id, entry, data);
		}
	});
	let listening = false;
	const connectNative = (application: unknown): ApiObject => {
		if (typeof application !== 'string') {
			throw new TypeError('Error in invocation of runtime.connectNative(string application): No matching signature.');
		}
		if (!listening) {
			listening = true;
			bridge.listen(namespace, portEvent, true);
		}
		counter += 1;
		const id = `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2)}`;
		const onMessage = makeEvent();
		const onDisconnect = makeEvent();
		const port: ApiObject = {};
		const entry: IPortState = { state: 'starting', queued: [], onMessage: onMessage.listeners, onDisconnect: onDisconnect.listeners, port };
		Object.assign(port, {
			name: '',
			sender: undefined,
			onMessage: onMessage.api,
			onDisconnect: onDisconnect.api,
			postMessage: (message: unknown) => {
				if (entry.state === 'closed') {
					throw new Error(disconnectedError);
				}
				const json = serialize(message);
				if (entry.state === 'starting') {
					entry.queued.push(json);
				} else {
					void bridge.call(namespace, 'postMessage', [id, json]);
				}
			},
			disconnect: () => {
				const wasOpen = entry.state === 'open';
				if (entry.state === 'closed') {
					return;
				}
				entry.state = 'closed';
				entry.queued.length = 0;
				ports.delete(id);
				if (wasOpen) {
					void bridge.call(namespace, 'disconnect', [id]);
				}
			},
		});
		ports.set(id, entry);
		void bridge.call(namespace, 'connect', [id, application]).then(reply => {
			if (!reply.ok) {
				if (entry.state !== 'closed') {
					endPort(id, entry, reply.error);
				}
				return;
			}
			if (entry.state === 'closed') {
				// 起動している間に切った: main にも手放させる
				void bridge.call(namespace, 'disconnect', [id]);
				return;
			}
			entry.state = 'open';
			for (const json of entry.queued.splice(0)) {
				void bridge.call(namespace, 'postMessage', [id, json]);
			}
		});
		return port;
	};
	const sendNativeMessage = (application: unknown, message: unknown, callback?: unknown): unknown => {
		const done = isCallable(callback) ? callback : undefined;
		const run = async (): Promise<unknown> => {
			if (typeof application !== 'string') {
				throw new Error('Invalid native messaging host name specified.');
			}
			const reply = await bridge.call(namespace, 'sendNativeMessage', [application, serialize(message)]);
			if (!reply.ok) {
				throw new Error(reply.error);
			}
			return typeof reply.value === 'string' ? JSON.parse(reply.value) : undefined;
		};
		const promise = run();
		if (!done) {
			return promise;
		}
		promise.then(value => done(value), (error: unknown) => callWithLastError(error instanceof Error ? error.message : String(error), () => done()));
		return undefined;
	};
	const define = (target: ApiObject, key: string, value: unknown): void => {
		try {
			Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
		} catch {
			// 凍った本物のオブジェクト: そのままにする
		}
	};
	const targets = [runtime];
	const browserRuntime = isObject(root.browser) ? root.browser.runtime : undefined;
	if (isObject(browserRuntime) && browserRuntime !== runtime) {
		targets.push(browserRuntime);
	}
	for (const target of targets) {
		define(target, 'connectNative', connectNative);
		define(target, 'sendNativeMessage', sendNativeMessage);
	}
}

export const PARADIS_SHIM_USER_SCRIPTS_NAMESPACE = 'paradisUserScripts';

/**
 * chrome.userScripts と runtime.onUserScriptMessage・onUserScriptConnect（P9b）。manifest に userScripts（後から許されるものも）が
 * ある拡張機能だけ。chrome.userScripts は、利用者が Para Code の拡張機能の管理で「ユーザースクリプトを許可」した間だけ出す
 * （Chrome 138 以降と同じく、オフなら undefined。切り替えは main が知らせ、読み込み直さずに変わる）。登録と注入は main が行う。
 */
export function paradisInstallUserScripts(bridge: IParadisShimBridge, namespace: string): void {
	type ApiObject = Record<string, unknown>;
	type Callable = (...args: unknown[]) => unknown;
	const noReceiver = 'Could not establish connection. Receiving end does not exist.';
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown };
	const chromeApi = root.chrome;
	const runtime = isObject(chromeApi) && isObject(chromeApi.runtime) ? chromeApi.runtime : undefined;
	if (!isObject(chromeApi) || !runtime) {
		return;
	}
	let manifest: unknown;
	try {
		manifest = isCallable(runtime.getManifest) ? runtime.getManifest.call(runtime) : undefined;
	} catch {
		manifest = undefined;
	}
	const declared = isObject(manifest) ? [manifest.permissions, manifest.optional_permissions].flatMap(list => Array.isArray(list) ? list : []) : [];
	if (!declared.includes('userScripts')) {
		return;
	}
	const callWithLastError = (message: string | undefined, callback: () => void): void => {
		let defined = false;
		if (message !== undefined) {
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
			if (defined) {
				try {
					delete runtime.lastError;
				} catch {
					// ignore
				}
			}
		}
	};
	const copy = (value: unknown): unknown => {
		const json: unknown = JSON.stringify(value ?? null);
		if (typeof json !== 'string') {
			throw new Error('Could not serialize message.');
		}
		return JSON.parse(json);
	};
	// 最後の引数が関数なら callback、無ければ Promise（Chrome と同じ）
	const method = (name: string) => (...input: unknown[]): unknown => {
		const done = isCallable(input[input.length - 1]) ? input.pop() as Callable : undefined;
		const promise = bridge.call(namespace, name, input).then(reply => {
			if (!reply.ok) {
				throw new Error(reply.error);
			}
			return reply.value;
		});
		if (!done) {
			return promise;
		}
		promise.then(value => value === undefined ? done() : done(value), (error: unknown) => callWithLastError(error instanceof Error ? error.message : String(error), () => done()));
		return undefined;
	};
	const api: ApiObject = {
		ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' },
		register: method('register'),
		update: method('update'),
		unregister: method('unregister'),
		getScripts: method('getScripts'),
		configureWorld: method('configureWorld'),
		getWorldConfigurations: method('getWorldConfigurations'),
		resetWorldConfiguration: method('resetWorldConfiguration'),
	};
	let allowed = false;
	try {
		Object.defineProperty(chromeApi, 'userScripts', { configurable: true, enumerable: true, get: () => allowed ? api : undefined });
	} catch {
		return;
	}
	const makeEvent = () => {
		const listeners = new Set<Callable>();
		return {
			listeners,
			api: {
				addListener: (callback: unknown) => { if (isCallable(callback)) { listeners.add(callback); } },
				removeListener: (callback: unknown) => { if (isCallable(callback)) { listeners.delete(callback); } },
				hasListener: (callback: unknown) => isCallable(callback) && listeners.has(callback),
				hasListeners: () => listeners.size > 0,
			},
		};
	};
	const dispatch = (listeners: Set<Callable>, args: unknown[]): unknown[] => {
		const results: unknown[] = [];
		for (const listener of [...listeners]) {
			try {
				results.push(listener(...args));
			} catch (error) {
				console.error(error);
			}
		}
		return results;
	};
	const onMessage = makeEvent();
	const onConnect = makeEvent();
	for (const [key, event] of [['onUserScriptMessage', onMessage], ['onUserScriptConnect', onConnect]] as const) {
		try {
			Object.defineProperty(runtime, key, { value: event.api, configurable: true, enumerable: true, writable: true });
		} catch {
			// 凍った本物のオブジェクト
		}
	}
	interface IWorkerPort {
		closed: boolean;
		readonly port: ApiObject;
		readonly onMessage: Set<Callable>;
		readonly onDisconnect: Set<Callable>;
	}
	const ports = new Map<string, IWorkerPort>();
	const respond = (requestId: string, reply: Record<string, unknown>): void => {
		void bridge.call(namespace, 'respond', [requestId, reply]);
	};
	const onUserScriptEvent = (args: unknown[]): void => {
		const [kind] = args;
		if (kind === 'message') {
			const [, requestId, message, sender] = args;
			if (typeof requestId !== 'string') {
				return;
			}
			if (onMessage.listeners.size === 0) {
				respond(requestId, { error: noReceiver });
				return;
			}
			let responded = false;
			let keep = false;
			const sendResponse = (value?: unknown): void => {
				if (responded) {
					return;
				}
				responded = true;
				let safe: unknown;
				try {
					safe = copy(value);
				} catch (error) {
					respond(requestId, { error: error instanceof Error ? error.message : String(error) });
					return;
				}
				respond(requestId, { value: value === undefined ? undefined : safe });
			};
			for (const result of dispatch(onMessage.listeners, [message, sender, sendResponse])) {
				if (result === true) {
					keep = true;
				} else if (isObject(result) && isCallable((result as { then?: unknown }).then)) {
					// Promise を返す受け手（Chrome は解決した値を返事にする）
					keep = true;
					(result as unknown as Promise<unknown>).then(value => sendResponse(value), (error: unknown) => {
						if (!responded) {
							responded = true;
							respond(requestId, { error: error instanceof Error ? error.message : String(error) });
						}
					});
				}
			}
			if (!keep && !responded) {
				responded = true;
				respond(requestId, { closed: true });
			}
			return;
		}
		if (kind === 'connect') {
			const [, portId, name, sender] = args;
			if (typeof portId !== 'string') {
				return;
			}
			if (onConnect.listeners.size === 0) {
				void bridge.call(namespace, 'portDisconnect', [portId, noReceiver]);
				return;
			}
			const portOnMessage = makeEvent();
			const portOnDisconnect = makeEvent();
			const port: ApiObject = {};
			const entry: IWorkerPort = { closed: false, port, onMessage: portOnMessage.listeners, onDisconnect: portOnDisconnect.listeners };
			Object.assign(port, {
				name: typeof name === 'string' ? name : '',
				sender,
				onMessage: portOnMessage.api,
				onDisconnect: portOnDisconnect.api,
				postMessage: (message: unknown) => {
					if (entry.closed) {
						throw new Error('Attempting to use a disconnected port object');
					}
					void bridge.call(namespace, 'portPost', [portId, copy(message)]);
				},
				disconnect: () => {
					if (entry.closed) {
						return;
					}
					entry.closed = true;
					ports.delete(portId);
					void bridge.call(namespace, 'portDisconnect', [portId]);
				},
			});
			ports.set(portId, entry);
			dispatch(onConnect.listeners, [port]);
			return;
		}
		const [, portId, message] = args;
		const entry = typeof portId === 'string' ? ports.get(portId) : undefined;
		if (!entry || entry.closed) {
			return;
		}
		if (kind === 'portMessage') {
			dispatch(entry.onMessage, [message, entry.port]);
		} else if (kind === 'portDisconnect') {
			entry.closed = true;
			ports.delete(portId as string);
			dispatch(entry.onDisconnect, [entry.port]);
		}
	};
	bridge.onEvent((eventNamespace, event, args) => {
		if (eventNamespace !== namespace) {
			return;
		}
		if (event === 'onAllowedChanged') {
			allowed = args[0] === true;
		} else if (event === 'onUserScriptEvent') {
			onUserScriptEvent(args);
		}
	});
	// worker は起こされたときに届くよう、最初から受ける（受け手が無ければ「受け手が無い」と答える）
	bridge.listen(namespace, 'onAllowedChanged', true);
	bridge.listen(namespace, 'onUserScriptEvent', true);
	void bridge.call(namespace, 'state', []).then(reply => {
		if (reply.ok && isObject(reply.value)) {
			allowed = reply.value.allowed === true;
		}
	});
}

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
	readonly installInertApis: typeof paradisInstallInertApis;
	readonly installContentScriptRelayHub: typeof paradisInstallContentScriptRelayHub;
	readonly installNativeMessaging: typeof paradisInstallNativeMessaging;
	readonly nativeMessagingNamespace: string;
	readonly installPrivacy: typeof paradisInstallPrivacy;
	readonly privacyNamespace: string;
	readonly installTts: typeof paradisInstallTts;
	readonly ttsNamespace: string;
	readonly installUserScripts: typeof paradisInstallUserScripts;
	readonly userScriptsNamespace: string;
	readonly installCapture: typeof paradisInstallCapture;
	readonly relayKey: string;
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
	options.installInertApis(isWorker ? 'worker' : 'page');
	options.installNativeMessaging(bridge, options.nativeMessagingNamespace);
	options.installPrivacy(bridge, options.privacyNamespace);
	options.installTts(bridge, options.ttsNamespace);
	options.installUserScripts(bridge, options.userScriptsNamespace);
	options.installCapture();
	const deliverFromContentScript = options.installStorageRelay(bridge, isWorker ? 'worker' : 'page', options.relayNamespace);
	if (!isWorker) {
		// ページは中継に答えないが、中継のポートを拡張機能の onConnect に見せない
		options.installContentScriptRelayHub(options.relayKey);
		options.installStorageSync(bridge, options.syncConstants, options.syncNamespace);
		return;
	}
	// worker: 拡張機能自身の content script からの中継に答える（sync は main へ、storage の知らせは worker の受け手へ）
	// sync の口は中継の口を作った後にできる（sync の変化を中継の口から送るため）
	const relays: { sync?: ReturnType<typeof options.installStorageSync> } = {};
	const broadcast = options.installContentScriptRelayHub(options.relayKey, async (namespace, method, args, from) => {
		if (namespace === options.syncNamespace && relays.sync) {
			return relays.sync(method, args, from);
		}
		const [areaName, changes] = args;
		if (namespace === options.relayNamespace && method === 'report' && deliverFromContentScript && (areaName === 'local' || areaName === 'session') && isRecord(changes)) {
			deliverFromContentScript(areaName, changes);
			return { ok: true, value: undefined };
		}
		return { ok: false, error: `${namespace}.${method} is not available here` };
	});
	relays.sync = options.installStorageSync(bridge, options.syncConstants, options.syncNamespace, broadcast);
}
