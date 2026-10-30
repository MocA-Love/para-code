/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable no-restricted-globals */
/* eslint-disable no-restricted-syntax */
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.userScripts（P9b）の注入の preload。拡張機能を入れるセッションにだけ足す（拡張機能の管理が registerPreloadScript で
// 足す）。どのフレームでも読まれ、http・https の文書でだけ main に「このフレームで動かすユーザースクリプト」を同期で聞く。
// 何を動かすかは main が送り主のフレームから決める（利用者のタブで、エージェントのタブでも共有中でもなく、利用者が
// 「ユーザースクリプトを許可」した拡張機能の、URL に当たる登録だけ）。この preload は聞いて動かすだけ。
//  - USER_SCRIPT の world は、拡張機能・worldId・ページの origin ごとに main が番号を決める（world の security origin は
//    renderer の中で番号ごとに 1 つなので、origin ごとに分け、ページの origin のまま使う。拡張機能の origin にはしない）
//  - document_start は文書の根（<html>）ができた時、ページのスクリプトより前に動かす。document_end・document_idle は
//    動かす直前に、まだ動かしてよいかを main に聞き直す（その間に共有が始まったタブでは動かさない）
//  - world の設定で messaging を許した world にだけ、chrome.runtime.sendMessage・connect を足す（main を通って
//    拡張機能の runtime.onUserScriptMessage・onUserScriptConnect へ届く）
//
// この preload は束ねずに読まれる（build/next/standalone.ts）ので、ほかのファイルを読まない。名前は
// ../common/paradisBrowserExtensionUserScripts.ts のものと同じで、テストが一致を確かめる。

/** この preload が使う electron の口（electron-browser の層は electron の型を読まないので、ここで書く）。 */
interface IUserScriptsIpcRenderer {
	on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
	invoke(channel: string, request: unknown): Promise<unknown>;
	sendSync(channel: string, request?: unknown): unknown;
}
interface IUserScriptsWebFrame {
	executeJavaScript(code: string): Promise<unknown>;
	executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string; url?: string }[]): Promise<unknown>;
	setIsolatedWorldInfo(worldId: number, info: { securityOrigin?: string; csp?: string; name?: string }): void;
}
interface IUserScriptsContextBridge {
	exposeInIsolatedWorld(worldId: number, apiKey: string, api: unknown): void;
}

/** 「このフレームで動かすユーザースクリプト」の同期の問い。 */
export const PARADIS_USER_SCRIPTS_PRELOAD_QUERY = 'paradis:userScriptsQuery';
/** document_end・document_idle の前の「まだ動かしてよいか」の同期の問い。 */
export const PARADIS_USER_SCRIPTS_PRELOAD_RECHECK = 'paradis:userScriptsRecheck';
/** world からのメッセージ（sendMessage・connect・ポート）。 */
export const PARADIS_USER_SCRIPTS_PRELOAD_CALL = 'paradis:userScriptsCall';
/** main から world への知らせ（ポートのメッセージ・切断）。 */
export const PARADIS_USER_SCRIPTS_PRELOAD_EVENT = 'paradis:userScriptsEvent';
/** world に渡す橋の名前（messaging を許した world だけ）。 */
export const PARADIS_USER_SCRIPTS_BRIDGE_KEY = '__paradisUserScriptsBridge';

/** main の答えの 1 つの world。 */
export interface IParadisUserScriptsPreloadWorld {
	readonly world: number;
	readonly extensionId: string;
	readonly worldId?: string;
	readonly csp: string;
	readonly messaging: boolean;
	readonly name: string;
}

/** main の答えの 1 つのスクリプト。`world` が 'MAIN' ならページの world。 */
export interface IParadisUserScriptsPreloadScript {
	readonly runAt: 'document_start' | 'document_end' | 'document_idle';
	readonly world: number | 'MAIN';
	readonly code: string;
	readonly url: string;
}

/** main の答え。 */
export interface IParadisUserScriptsPreloadAnswer {
	readonly worlds: readonly IParadisUserScriptsPreloadWorld[];
	readonly scripts: readonly IParadisUserScriptsPreloadScript[];
}

/** world に渡す橋（contextBridge が関数を包んで渡す）。 */
export interface IParadisUserScriptsWorldBridge {
	sendMessage(message: unknown): Promise<{ readonly value?: unknown; readonly error?: string; readonly closed?: boolean }>;
	connect(portId: string, name: string): Promise<{ readonly error?: string }>;
	postMessage(portId: string, message: unknown): void;
	disconnect(portId: string): void;
	onEvent(handler: (event: { readonly kind: string; readonly portId: string; readonly message?: unknown; readonly error?: string }) => void): void;
}

/** 答えの形を確かめる（違えば undefined）。 */
export function paradisReadUserScriptsAnswer(value: unknown): IParadisUserScriptsPreloadAnswer | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const { worlds, scripts } = value as { worlds?: unknown; scripts?: unknown };
	if (!Array.isArray(worlds) || !Array.isArray(scripts) || scripts.length === 0) {
		return undefined;
	}
	const isWorld = (entry: unknown): entry is IParadisUserScriptsPreloadWorld => entry !== null && typeof entry === 'object'
		&& Number.isInteger((entry as { world?: unknown }).world) && typeof (entry as { extensionId?: unknown }).extensionId === 'string'
		&& typeof (entry as { csp?: unknown }).csp === 'string' && typeof (entry as { messaging?: unknown }).messaging === 'boolean' && typeof (entry as { name?: unknown }).name === 'string';
	const isScript = (entry: unknown): entry is IParadisUserScriptsPreloadScript => entry !== null && typeof entry === 'object'
		&& ['document_start', 'document_end', 'document_idle'].includes((entry as { runAt?: unknown }).runAt as string)
		&& ((entry as { world?: unknown }).world === 'MAIN' || Number.isInteger((entry as { world?: unknown }).world))
		&& typeof (entry as { code?: unknown }).code === 'string' && typeof (entry as { url?: unknown }).url === 'string';
	if (!worlds.every(isWorld) || !scripts.every(isScript)) {
		return undefined;
	}
	return { worlds, scripts };
}

/**
 * USER_SCRIPT の world で、ユーザースクリプトより先に動く。chrome.runtime の sendMessage・connect・id・getURL・lastError と
 * chrome.extension.inIncognitoContext を足す（Chrome の USER_SCRIPT の world で messaging を許したときと同じ）。
 * 文字にして world へ渡すので、本体の外を参照しない（テストが確かめる）。
 */
export function paradisInstallUserScriptWorldApis(extensionId: string, bridgeKey: string): void {
	type ApiObject = Record<string, unknown>;
	type Callable = (...args: unknown[]) => unknown;
	const isObject = (value: unknown): value is ApiObject => value !== null && typeof value === 'object';
	const isCallable = (value: unknown): value is Callable => typeof value === 'function';
	const root = globalThis as Record<string, unknown>;
	const bridge = root[bridgeKey] as IParadisUserScriptsWorldBridge | undefined;
	if (!bridge) {
		return;
	}
	try {
		delete root[bridgeKey];
	} catch {
		// contextBridge が消せない形で置いた。world の中だけのもの
	}
	const define = (target: ApiObject, key: string, value: unknown): void => {
		try {
			Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
		} catch {
			// 凍った物は触らない
		}
	};
	if (!isObject(root.chrome)) {
		define(root, 'chrome', {});
	}
	const chromeApi = root.chrome as ApiObject;
	const runtime: ApiObject = isObject(chromeApi.runtime) ? chromeApi.runtime : {};
	define(chromeApi, 'runtime', runtime);
	const extension: ApiObject = isObject(chromeApi.extension) ? chromeApi.extension : {};
	define(chromeApi, 'extension', extension);
	const withLastError = (message: string | undefined, callback: () => void): void => {
		let defined = false;
		if (message !== undefined) {
			try {
				Object.defineProperty(runtime, 'lastError', { configurable: true, enumerable: true, get: () => ({ message }) });
				defined = true;
			} catch {
				// 置き換えられない
			}
		}
		try {
			callback();
		} finally {
			if (defined) {
				try {
					delete runtime.lastError;
				} catch {
					// 消せない
				}
			}
		}
	};
	const makeEvent = () => {
		const listeners = new Set<Callable>();
		return {
			listeners,
			api: {
				addListener: (listener: unknown) => { if (isCallable(listener)) { listeners.add(listener); } },
				removeListener: (listener: unknown) => { if (isCallable(listener)) { listeners.delete(listener); } },
				hasListener: (listener: unknown) => isCallable(listener) && listeners.has(listener),
				hasListeners: () => listeners.size > 0,
			},
		};
	};
	const dispatch = (listeners: Set<Callable>, args: unknown[]): void => {
		for (const listener of [...listeners]) {
			try {
				listener(...args);
			} catch (error) {
				console.error(error);
			}
		}
	};
	const ownId = (value: unknown): boolean => value === undefined || value === null || value === extensionId;
	interface IPortState {
		state: 'starting' | 'open' | 'closed';
		readonly queued: unknown[];
		readonly onMessage: Set<Callable>;
		readonly onDisconnect: Set<Callable>;
		readonly port: ApiObject;
	}
	const ports = new Map<string, IPortState>();
	let counter = 0;
	const endPort = (id: string, entry: IPortState, error: string | undefined): void => {
		if (entry.state === 'closed') {
			return;
		}
		entry.state = 'closed';
		entry.queued.length = 0;
		ports.delete(id);
		withLastError(error, () => dispatch(entry.onDisconnect, [entry.port]));
	};
	bridge.onEvent(event => {
		const entry = ports.get(event.portId);
		if (!entry) {
			return;
		}
		if (event.kind === 'message' && entry.state === 'open') {
			dispatch(entry.onMessage, [event.message, entry.port]);
		} else if (event.kind === 'disconnect') {
			endPort(event.portId, entry, event.error);
		}
	});
	const connect = (...args: unknown[]): ApiObject => {
		let info: unknown = args[0];
		if (typeof args[0] === 'string' || args[0] === null) {
			if (!ownId(args[0])) {
				throw new Error('User scripts can only connect to their own extension.');
			}
			info = args[1];
		}
		const name = isObject(info) && typeof info.name === 'string' ? info.name : '';
		counter += 1;
		const id = `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2)}`;
		const onMessage = makeEvent();
		const onDisconnect = makeEvent();
		const port: ApiObject = {};
		const entry: IPortState = { state: 'starting', queued: [], onMessage: onMessage.listeners, onDisconnect: onDisconnect.listeners, port };
		Object.assign(port, {
			name,
			sender: undefined,
			onMessage: onMessage.api,
			onDisconnect: onDisconnect.api,
			postMessage: (message: unknown) => {
				if (entry.state === 'closed') {
					throw new Error('Attempting to use a disconnected port object');
				}
				// JSON で運ぶ（Chrome と同じく、JSON にできないものは断る）
				const copy: unknown = JSON.parse(JSON.stringify(message ?? null));
				if (entry.state === 'starting') {
					entry.queued.push(copy);
				} else {
					bridge.postMessage(id, copy);
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
					bridge.disconnect(id);
				}
			},
		});
		ports.set(id, entry);
		void bridge.connect(id, name).then(reply => {
			if (reply.error !== undefined) {
				endPort(id, entry, reply.error);
				return;
			}
			if (entry.state === 'closed') {
				bridge.disconnect(id);
				return;
			}
			entry.state = 'open';
			for (const message of entry.queued.splice(0)) {
				bridge.postMessage(id, message);
			}
		}, () => endPort(id, entry, 'Could not establish connection. Receiving end does not exist.'));
		return port;
	};
	const sendMessage = (...input: unknown[]): unknown => {
		const callback = isCallable(input[input.length - 1]) ? input.pop() as Callable : undefined;
		let message: unknown;
		if (input.length >= 2 && (typeof input[0] === 'string' || input[0] === null || input[0] === undefined)) {
			if (!ownId(input[0])) {
				const error = new Error('User scripts can only send messages to their own extension.');
				if (callback) {
					withLastError(error.message, () => callback());
					return undefined;
				}
				return Promise.reject(error);
			}
			message = input[1];
		} else {
			message = input[0];
		}
		let copy: unknown;
		try {
			copy = JSON.parse(JSON.stringify(message ?? null));
		} catch (error) {
			if (callback) {
				withLastError(String(error), () => callback());
				return undefined;
			}
			return Promise.reject(error);
		}
		const reply = bridge.sendMessage(copy);
		if (callback) {
			void reply.then(
				result => withLastError(result.error ?? (result.closed ? 'The message port closed before a response was received.' : undefined), () => result.value === undefined ? callback() : callback(result.value)),
				() => withLastError('Could not establish connection. Receiving end does not exist.', () => callback()),
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
	define(runtime, 'id', extensionId);
	define(runtime, 'getURL', (path: unknown) => `chrome-extension://${extensionId}/${String(path ?? '').replace(/^\/+/, '')}`);
	define(runtime, 'sendMessage', sendMessage);
	define(runtime, 'connect', connect);
	// tabs.sendMessage は USER_SCRIPT の world には届かない（Chrome と同じ。ポートを使う）
	define(runtime, 'onMessage', makeEvent().api);
	define(extension, 'inIncognitoContext', false);
}

/** 文書の根（<html>）ができたら呼ぶ（preload の時点ではまだ無い。ページのスクリプトより前に動く）。 */
function whenRootExists(run: () => void): void {
	if (document.documentElement) {
		run();
		return;
	}
	const observer = new MutationObserver(() => {
		if (document.documentElement) {
			observer.disconnect();
			run();
		}
	});
	observer.observe(document, { childList: true });
}

function installUserScripts(answer: IParadisUserScriptsPreloadAnswer): void {
	const electron = require('electron') as { contextBridge: IUserScriptsContextBridge; ipcRenderer: IUserScriptsIpcRenderer; webFrame: IUserScriptsWebFrame };
	const { contextBridge, ipcRenderer, webFrame } = electron;
	const handlers = new Map<number, (event: { readonly kind: string; readonly portId: string; readonly message?: unknown; readonly error?: string }) => void>();
	ipcRenderer.on(PARADIS_USER_SCRIPTS_PRELOAD_EVENT, (_event, payload: unknown) => {
		if (payload === null || typeof payload !== 'object') {
			return;
		}
		const { world, kind, portId, message, error } = payload as { world?: unknown; kind?: unknown; portId?: unknown; message?: unknown; error?: unknown };
		if (typeof world === 'number' && typeof kind === 'string' && typeof portId === 'string') {
			handlers.get(world)?.({ kind, portId, message, error: typeof error === 'string' ? error : undefined });
		}
	});
	const prepared = new Set<number>();
	const prepare = (world: IParadisUserScriptsPreloadWorld): void => {
		if (prepared.has(world.world)) {
			return;
		}
		prepared.add(world.world);
		webFrame.setIsolatedWorldInfo(world.world, { securityOrigin: location.origin, csp: world.csp, name: world.name });
		if (!world.messaging) {
			return;
		}
		const call = async (request: Record<string, unknown>): Promise<unknown> => {
			try {
				return await ipcRenderer.invoke(PARADIS_USER_SCRIPTS_PRELOAD_CALL, { ...request, world: world.world, extensionId: world.extensionId, worldId: world.worldId });
			} catch {
				return { error: 'Could not establish connection. Receiving end does not exist.' };
			}
		};
		const bridge: IParadisUserScriptsWorldBridge = {
			sendMessage: message => call({ op: 'sendMessage', message }) as Promise<{ value?: unknown; error?: string; closed?: boolean }>,
			connect: (portId, name) => call({ op: 'connect', portId, name }) as Promise<{ error?: string }>,
			postMessage: (portId, message) => void call({ op: 'postMessage', portId, message }),
			disconnect: portId => void call({ op: 'disconnect', portId }),
			onEvent: handler => {
				handlers.set(world.world, handler);
			},
		};
		contextBridge.exposeInIsolatedWorld(world.world, PARADIS_USER_SCRIPTS_BRIDGE_KEY, bridge);
		void webFrame.executeJavaScriptInIsolatedWorld(world.world, [{ code: `(${paradisInstallUserScriptWorldApis.toString()})(${JSON.stringify(world.extensionId)}, ${JSON.stringify(PARADIS_USER_SCRIPTS_BRIDGE_KEY)});` }]);
	};
	const worlds = new Map(answer.worlds.map(world => [world.world, world]));
	const run = (runAt: IParadisUserScriptsPreloadScript['runAt']): void => {
		for (const script of answer.scripts) {
			if (script.runAt !== runAt) {
				continue;
			}
			// 1 つが失敗しても、ほかは動かす（失敗は world の中の console に出る）
			if (script.world === 'MAIN') {
				void webFrame.executeJavaScript(`${script.code}\n//# sourceURL=${script.url}`).catch(() => undefined);
				continue;
			}
			const world = worlds.get(script.world);
			if (world) {
				prepare(world);
				void webFrame.executeJavaScriptInIsolatedWorld(script.world, [{ code: script.code, url: script.url }]).catch(() => undefined);
			}
		}
	};
	const stillAllowed = (): boolean => {
		try {
			return ipcRenderer.sendSync(PARADIS_USER_SCRIPTS_PRELOAD_RECHECK) === true;
		} catch {
			return false;
		}
	};
	const has = (runAt: IParadisUserScriptsPreloadScript['runAt']) => answer.scripts.some(script => script.runAt === runAt);
	if (has('document_start')) {
		whenRootExists(() => run('document_start'));
	}
	let endDone = false;
	const end = (): void => {
		if (endDone) {
			return;
		}
		endDone = true;
		const allowed = stillAllowed();
		if (allowed && has('document_end')) {
			run('document_end');
		}
		if (!allowed || !has('document_idle')) {
			return;
		}
		// document_idle: load の時か、DOMContentLoaded の 200 ミリ秒後の早いほう（Chrome と同じ）
		let idleDone = false;
		const idle = (): void => {
			if (!idleDone) {
				idleDone = true;
				if (stillAllowed()) {
					run('document_idle');
				}
			}
		};
		if (document.readyState === 'complete') {
			idle();
		} else {
			window.addEventListener('load', idle, { once: true });
			setTimeout(idle, 200);
		}
	};
	if (has('document_end') || has('document_idle')) {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', end, { once: true });
		} else {
			end();
		}
	}
}

/** http・https の文書でだけ main に聞く（拡張機能のページ・about:blank などでは聞かない）。 */
export function paradisShouldAskForUserScripts(protocol: string): boolean {
	return protocol === 'http:' || protocol === 'https:';
}

// テスト（Node で読む）では動かさない。sandbox の preload では process は包みの引数で渡り、globalThis には無い
if (typeof process !== 'undefined' && (process.versions?.electron || process.type === 'renderer') && typeof location !== 'undefined' && paradisShouldAskForUserScripts(location.protocol)) {
	let answer: IParadisUserScriptsPreloadAnswer | undefined;
	try {
		answer = paradisReadUserScriptsAnswer((require('electron') as { ipcRenderer: IUserScriptsIpcRenderer }).ipcRenderer.sendSync(PARADIS_USER_SCRIPTS_PRELOAD_QUERY));
	} catch {
		answer = undefined;
	}
	if (answer) {
		installUserScripts(answer);
	}
}
