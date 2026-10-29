/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable no-restricted-globals */
/* eslint-disable no-restricted-syntax */
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/preload/browser-extension-web-store-bridge.ts, src/preload/browser-extension-web-store-main-world.ts, src/preload/browser-extension-web-store-wording.ts
// The chrome.webstorePrivate shapes follow Chromium's webstore_private.json; the approach is informed by electron-chrome-web-store (MIT, Samuel Maddock), as Orca does.

// Chrome ウェブストアのページの「Para Code に追加」（P7b）の preload。拡張機能を入れるセッションにだけ足す（拡張機能の管理が
// registerPreloadScript で足す）。どのフレームでも読まれるが、動くのは一番外の文書が https://chromewebstore.google.com の
// ときだけで、その上 main が「このタブでストアの橋を出してよいか」に答えたときだけ（エージェントと共有中のタブ・エージェントの
// タブ・拡張機能を入れないタブでは出さない）。
//
// この preload は束ねずに読まれる（build/next/standalone.ts）ので、ほかのファイルを読まない。名前は
// ../common/paradisBrowserExtensionWebStore.ts と ../electron-main/paradisBrowserExtensionWebStoreBridge.ts のものと同じで、
// テストが一致を確かめる。
//
// ページの JS はこの橋を呼べる（ストアのボタンは JS で webstorePrivate を呼ぶ）。それでも入れるかを決めるのは main で、
// main は送り主のフレームを確かめ、ストアから落として署名を確かめた中身の権限を main のダイアログで見せてから入れる。
// ページは main のダイアログを押せない。

/** この preload が使う electron の口（electron-browser の層は electron の型を読まないので、ここで書く）。 */
interface IWebStoreContextBridge {
	executeInMainWorld(script: { func: (...args: never[]) => unknown; args?: unknown[] }): unknown;
}
interface IWebStoreIpcRenderer {
	on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
	invoke(channel: string, request: unknown): Promise<unknown>;
	sendSync(channel: string): unknown;
}

/** ストアの origin（前方一致にすると似せた名前の host に入れる力を渡すので、完全一致で比べる）。 */
export const PARADIS_WEB_STORE_PRELOAD_ORIGIN = 'https://chromewebstore.google.com';
/** main への呼び出し（{ method, args } → { value?, error? }）。 */
export const PARADIS_WEB_STORE_PRELOAD_CHANNEL = 'paradis:webStore';
/** main からストアのページへのイベント（management.onInstalled・onUninstalled）。 */
export const PARADIS_WEB_STORE_PRELOAD_EVENT_CHANNEL = 'paradis:webStoreEvent';
/** 「このタブでストアの橋を出してよいか」の同期の問い。 */
export const PARADIS_WEB_STORE_PRELOAD_QUERY = 'paradis:webStoreAllowed';

/** main の答え。`value` はページの callback へ、`error` は callback の間だけ runtime.lastError になる。 */
export interface IParadisWebStoreBridgeReply {
	readonly value?: unknown;
	readonly error?: string;
}

/** main world に渡す橋（contextBridge が関数を包んで渡す）。 */
export interface IParadisWebStoreMainWorldBridge {
	call(method: string, args: unknown[]): Promise<IParadisWebStoreBridgeReply>;
	onEvent(handler: (event: string, args: unknown[]) => void): void;
}

/**
 * ストアのページの main world で動き、chrome.webstorePrivate と、ストアが使う chrome.management の呼び出しを足す。
 * contextBridge.executeInMainWorld が関数を文字にして渡すので、本体の外を参照しない（テストが確かめる）。
 */
export function paradisInstallWebStoreApis(bridge: IParadisWebStoreMainWorldBridge, chromeVersion: string): void {
	type ApiObject = Record<string, unknown>;
	type Callable = (...args: unknown[]) => unknown;
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as { chrome?: unknown };
	const define = (target: ApiObject, key: string, value: unknown): void => {
		try {
			Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
		} catch {
			try {
				target[key] = value;
			} catch {
				// 凍った物は触らない
			}
		}
	};
	const ensureObject = (target: ApiObject, key: string): ApiObject => {
		const existing = target[key];
		if (isObject(existing)) {
			return existing;
		}
		const created: ApiObject = {};
		define(target, key, created);
		return created;
	};
	if (!isObject(root.chrome)) {
		define(root as ApiObject, 'chrome', {});
	}
	const chromeApi = isObject(root.chrome) ? root.chrome : {};
	const runtime = ensureObject(chromeApi, 'runtime');
	const extension = ensureObject(chromeApi, 'extension');
	const withLastError = (message: string | undefined, callback: () => void): void => {
		const defined: ApiObject[] = [];
		if (message !== undefined) {
			for (const target of [runtime, extension]) {
				try {
					Object.defineProperty(target, 'lastError', { configurable: true, enumerable: true, get: () => ({ message }) });
					defined.push(target);
				} catch {
					// 置き換えられない lastError。callback は呼ぶ
				}
			}
		}
		try {
			callback();
		} finally {
			for (const target of defined) {
				try {
					delete target.lastError;
				} catch {
					// 消せない
				}
			}
		}
	};
	// Chrome と同じく、最後の引数が関数なら callback、無ければ Promise
	const settle = (input: unknown[], reply: Promise<IParadisWebStoreBridgeReply>): unknown => {
		const last = input[input.length - 1];
		if (isCallable(last)) {
			void reply.then(
				result => withLastError(result.error, () => result.value === undefined ? last() : last(result.value)),
				() => withLastError('Para Code could not handle this request', () => last()),
			);
			return undefined;
		}
		return reply.then(result => {
			if (result.error !== undefined) {
				throw new Error(result.error);
			}
			return result.value;
		});
	};
	const withoutCallback = (input: unknown[]): unknown[] => isCallable(input[input.length - 1]) ? input.slice(0, -1) : input;
	const remote = (method: string) => (...input: unknown[]): unknown => settle(input, bridge.call(method, withoutCallback(input)));
	const local = (value: unknown) => (...input: unknown[]): unknown => settle(input, Promise.resolve({ value }));
	const listeners = new Map<string, Set<Callable>>();
	const makeEvent = (name: string): ApiObject => {
		const set = new Set<Callable>();
		listeners.set(name, set);
		return {
			addListener: (listener: unknown) => { if (isCallable(listener)) { set.add(listener); } },
			removeListener: (listener: unknown) => { if (isCallable(listener)) { set.delete(listener); } },
			hasListener: (listener: unknown) => isCallable(listener) && set.has(listener),
			hasListeners: () => set.size > 0,
		};
	};
	define(chromeApi, 'webstorePrivate', {
		Result: {
			EMPTY_STRING: '', SUCCESS: 'success', USER_CANCELLED: 'user_cancelled', INVALID_ID: 'invalid_id', MANIFEST_ERROR: 'manifest_error', ICON_ERROR: 'icon_error',
			INVALID_ICON_URL: 'invalid_icon_url', ALREADY_INSTALLED: 'already_installed', INSTALL_IN_PROGRESS: 'install_in_progress', INSTALL_ERROR: 'install_error',
			UNKNOWN_ERROR: 'unknown_error', UNSUPPORTED_EXTENSION_TYPE: 'unsupported_extension_type',
		},
		ExtensionInstallStatus: { INSTALLABLE: 'installable', ENABLED: 'enabled', DISABLED: 'disabled', BLOCKED_BY_POLICY: 'blocked_by_policy', DEPRECATED_MANIFEST_VERSION: 'deprecated_manifest_version' },
		MV2DeprecationStatus: { INACTIVE: 'inactive', WARNING: 'warning', SOFT_DISABLE: 'soft_disable', HARD_DISABLE: 'hard_disable' },
		WebGlStatus: { WEBGL_ALLOWED: 'webgl_allowed', WEBGL_BLOCKED: 'webgl_blocked' },
		beginInstallWithManifest3: remote('beginInstallWithManifest3'),
		completeInstall: remote('completeInstall'),
		getExtensionStatus: remote('getExtensionStatus'),
		isInIncognitoMode: local(false),
		getFullChromeVersion: local({ version_number: chromeVersion }),
		getBrowserLogin: local({ login: '' }),
		getStoreLogin: local(''),
		setStoreLogin: local(undefined),
		getReferrerChain: local(''),
		getMV2DeprecationStatus: local('hard_disable'),
		isPendingCustodianApproval: local(false),
		enableAppLauncher: local(undefined),
		getIsLauncherEnabled: local(false),
		getWebGLStatus: local('webgl_allowed'),
	});
	const management = ensureObject(chromeApi, 'management');
	define(management, 'getAll', remote('management.getAll'));
	define(management, 'uninstall', remote('management.uninstall'));
	define(management, 'setEnabled', remote('management.setEnabled'));
	define(management, 'onInstalled', makeEvent('onInstalled'));
	define(management, 'onUninstalled', makeEvent('onUninstalled'));
	bridge.onEvent((event, args) => {
		for (const listener of listeners.get(event) ?? []) {
			try {
				listener(...args);
			} catch (error) {
				console.error(error);
			}
		}
	});
}

/**
 * ストアのページの main world で動き、「Chrome に追加」の文言を「Para Code に追加」にし、「Chrome に切り替え」の帯を隠す
 * （ここでは入れられるので）。本体の外を参照しない。「Chrome ウェブストア」という名前はそのまま。
 */
export function paradisAdaptWebStoreWording(): void {
	const replacements: [RegExp, string][] = [
		[/\bAdd to Chrome\b/g, 'Add to Para Code'],
		[/\bRemove from Chrome\b/g, 'Remove from Para Code'],
		[/ has been removed from Chrome\./g, ' has been removed from Para Code.'],
		[/Chrome に追加/g, 'Para Code に追加'],
		[/Chrome から削除/g, 'Para Code から削除'],
	];
	// 帯（「拡張機能とテーマをインストールするには、Chrome に切り替えてください」と「Chrome をインストール」）と、
	// 右上に出る小さな窓（「Chrome に切り替えませんか？」と「いいえ、結構です」「はい」。role="dialog"）の文
	const switchBannerTexts = ['Switch to Chrome to install extensions and themes', 'Switch to Chrome?', 'Chrome に切り替えてください', 'Chrome に切り替えませんか'];
	const hiddenAttribute = 'data-paradis-hidden-switch-banner';
	const rewrite = (value: string): string => replacements.reduce((text, [pattern, next]) => text.replace(pattern, next), value);
	const isSwitchBanner = (value: string) => switchBannerTexts.some(text => value.includes(text));
	// 帯の箱は「Chrome をインストール」のボタンも持ち、ストアはほかの知らせにも同じ箱を使うので、切り替えの文がある間だけ隠す
	const hideSwitchBanner = (text: Node): void => {
		const dialog = text.parentElement?.closest('[role="dialog"]');
		let box: HTMLElement | null = dialog instanceof HTMLElement ? dialog : text.parentElement;
		while (!dialog && box && !/Install Chrome|Chrome をインストール/.test(box.textContent ?? '')) {
			box = box.parentElement;
		}
		if (box && box !== document.body) {
			box.setAttribute(hiddenAttribute, '');
			box.style.setProperty('display', 'none', 'important');
		}
	};
	const restoreReusedBanners = (): void => {
		for (const box of document.querySelectorAll<HTMLElement>(`[${hiddenAttribute}]`)) {
			if (!isSwitchBanner(box.textContent ?? '')) {
				box.removeAttribute(hiddenAttribute);
				box.style.removeProperty('display');
			}
		}
	};
	const relabelText = (node: Node): void => {
		const value = node.nodeValue ?? '';
		if (isSwitchBanner(value)) {
			hideSwitchBanner(node);
			return;
		}
		const next = rewrite(value);
		if (next !== value) {
			node.nodeValue = next;
		}
	};
	const relabelElement = (element: Element): void => {
		for (const name of ['aria-label', 'title']) {
			const value = element.getAttribute(name);
			if (value) {
				const next = rewrite(value);
				if (next !== value) {
					element.setAttribute(name, next);
				}
			}
		}
	};
	const relabelTree = (root: Node): void => {
		if (root.nodeType === Node.TEXT_NODE) {
			relabelText(root);
			return;
		}
		if (!(root instanceof Element) && root !== document) {
			return;
		}
		if (root instanceof Element) {
			relabelElement(root);
		}
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.nodeType === Node.TEXT_NODE) {
				relabelText(node);
			} else if (node instanceof Element) {
				relabelElement(node);
			}
		}
	};
	// ストアは 1 枚のページのアプリで、状態が変わるたびにボタンを描き直す
	new MutationObserver(records => {
		for (const record of records) {
			if (record.type === 'characterData') {
				relabelText(record.target);
			} else if (record.type === 'attributes' && record.target instanceof Element) {
				relabelElement(record.target);
			} else {
				record.addedNodes.forEach(relabelTree);
			}
		}
		restoreReusedBanners();
	}).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title'] });
	relabelTree(document);
}

/** この文書でストアの橋を出すか（一番外の文書がストアのときだけ main に尋ねる。ほかのページは尋ねもしない）。 */
export function paradisShouldInstallWebStoreBridge(origin: string, isTopFrame: boolean, ask: () => unknown): boolean {
	if (!isTopFrame || origin !== PARADIS_WEB_STORE_PRELOAD_ORIGIN) {
		return false;
	}
	try {
		return ask() === true;
	} catch {
		return false;
	}
}

function installBridge(): void {
	// 束ねない preload なので、electron は require で読む（sandbox の preload で使える）
	const electron = require('electron') as { contextBridge: IWebStoreContextBridge; ipcRenderer: IWebStoreIpcRenderer };
	const { contextBridge, ipcRenderer } = electron;
	let dispatch: ((event: string, args: unknown[]) => void) | undefined;
	ipcRenderer.on(PARADIS_WEB_STORE_PRELOAD_EVENT_CHANNEL, (_event, payload: unknown) => {
		if (payload !== null && typeof payload === 'object' && typeof (payload as { event?: unknown }).event === 'string' && Array.isArray((payload as { args?: unknown }).args)) {
			dispatch?.((payload as { event: string }).event, (payload as { args: unknown[] }).args);
		}
	});
	const bridge: IParadisWebStoreMainWorldBridge = {
		call: async (method, args) => {
			try {
				return await ipcRenderer.invoke(PARADIS_WEB_STORE_PRELOAD_CHANNEL, { method, args }) as IParadisWebStoreBridgeReply;
			} catch {
				return { error: 'Para Code could not handle this request' };
			}
		},
		onEvent: handler => {
			dispatch = handler;
		},
	};
	const chromeVersion = typeof process !== 'undefined' ? process.versions?.chrome ?? '' : '';
	contextBridge.executeInMainWorld({ func: paradisInstallWebStoreApis, args: [bridge, chromeVersion] });
	contextBridge.executeInMainWorld({ func: paradisAdaptWebStoreWording });
}

// テスト（Node で読む）では動かさない。sandbox の preload では process は包みの引数で渡り、globalThis には無い
if (typeof process !== 'undefined' && (process.versions?.electron || process.type === 'renderer') && typeof location !== 'undefined'
	&& paradisShouldInstallWebStoreBridge(location.origin, typeof window !== 'undefined' && window.top === window, () => (require('electron') as { ipcRenderer: IWebStoreIpcRenderer }).ipcRenderer.sendSync(PARADIS_WEB_STORE_PRELOAD_QUERY))) {
	installBridge();
}
