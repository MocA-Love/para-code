/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-worker-api-host.ts, src/main/browser/extensions/browser-extension-api-host.ts, src/main/browser/extensions/browser-extension-contexts.ts, src/main/browser/extensions/browser-extension-worker-event-stream.ts, src/main/browser/extensions/browser-extension-api-request.ts, src/main/browser/extensions/browser-extension-namespace-registry.ts

// 詰め物（paradisBrowserExtensionShim.ts）の呼び出しを受ける main 側。拡張機能を読み込むセッションごとに
// 私用スキームの受け手を立て、呼び出し元を確かめてから名前空間の関数へ渡し、イベントを届ける。
//
// 呼び出し元の確かめ方: 受け手のセッションが呼び出し元のセッション。Electron が付ける呼び出し元の origin
// （initiatorOrigin。ページが書き換えられない）がそのセッションに読み込んだ拡張機能を指し、本文のトークンが
// その拡張機能のもの（拡張機能自身のファイルからしか読めない）と一致しなければ断る。ウェブページからの要求は
// 本文を読む前に断る（main に負担をかけさせない）。
//
// イベント: 拡張機能の文脈（worker と各ページ）がそれぞれイベントの応答を 1 本開き、受け手を登録した
// イベントだけが届く。worker は止まることがあるので、止まっている間のイベントは溜めて worker を起こし、
// 受け手が登録し直されたら出す。

import { randomBytes } from 'crypto';
import type { Session, ServiceWorkerMain } from 'electron';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import {
	IParadisExtensionApiEvent,
	PARADIS_EXTENSION_API_CALL_URL,
	PARADIS_EXTENSION_API_EVENTS_URL,
	PARADIS_EXTENSION_API_SCHEME,
	ParadisExtensionApiReply,
	paradisDecodeExtensionWire,
	paradisEncodeExtensionWire,
} from '../common/paradisBrowserExtensionApiWire.js';

/** 拡張機能（Electron の Extension の、ここで使うところ）。 */
export interface IParadisApiExtension {
	readonly id: string;
	readonly version: string;
	readonly manifest: Record<string, unknown>;
}

/** 呼び出し元。本文からではなく、受け手のセッションとトークンから決める。 */
export interface IParadisExtensionApiCaller {
	readonly extension: IParadisApiExtension;
	readonly session: ParadisApiSession;
	/** 有効にする場所（`default` / `profile:<id>`）。 */
	readonly place: string;
	/** 文脈の名前（worker は 'worker'）。 */
	readonly connection: string;
	readonly fromWorker: boolean;
}

/** 関数が投げると、その文が拡張機能へ（失敗・runtime.lastError として）届く。 */
export class ParadisExtensionApiError extends Error { }

export interface IParadisExtensionApiMethod {
	invoke(caller: IParadisExtensionApiCaller, args: readonly unknown[]): unknown;
}

export interface IParadisExtensionApiNamespace {
	/** manifest の permissions にこのどれかが要る（無ければ断る）。 */
	readonly permission?: string | readonly string[];
	readonly methods: Readonly<Record<string, IParadisExtensionApiMethod>>;
	readonly events: readonly string[];
}

/**
 * 引数のタプルを確かめてから関数へ渡す。`check` は形が正しければタプルを、違えば undefined を返す。
 * main では npm のパッケージ（zod など）を静的に読まない。配布版の main の束は npm を外に残し、ESM が
 * 本体より先に解決しようとして起動前に止まるため（paracode-68 と同じ事故）。
 */
export function paradisDefineExtensionMethod<T extends unknown[]>(check: (args: readonly unknown[]) => T | undefined, handle: (caller: IParadisExtensionApiCaller, ...args: T) => unknown): IParadisExtensionApiMethod {
	return {
		invoke: (caller, rawArgs) => {
			const args = check(rawArgs);
			if (args === undefined) {
				throw new ParadisExtensionApiError('Invalid arguments');
			}
			return handle(caller, ...args);
		},
	};
}

/** 受け手に要るセッションの一部（テストでは偽物を渡す）。 */
export type ParadisApiSession = Pick<Session, 'storagePath'> & {
	readonly protocol: Pick<Session['protocol'], 'handle' | 'unhandle'>;
	readonly extensions: Pick<Session['extensions'], 'getExtension'> & { on(event: 'extension-unloaded', listener: (event: unknown, extension: { readonly id: string }) => void): unknown; removeListener(event: 'extension-unloaded', listener: (event: unknown, extension: { readonly id: string }) => void): unknown };
	readonly serviceWorkers: Pick<Session['serviceWorkers'], 'startWorkerForScope' | 'getWorkerFromVersionID'> & {
		on(event: 'running-status-changed', listener: (details: { readonly versionId: number; readonly runningStatus: string }) => void): unknown;
		on(event: 'console-message', listener: (event: unknown, details: IParadisWorkerConsoleMessage) => void): unknown;
		removeListener(event: 'running-status-changed', listener: (details: { readonly versionId: number; readonly runningStatus: string }) => void): unknown;
		removeListener(event: 'console-message', listener: (event: unknown, details: IParadisWorkerConsoleMessage) => void): unknown;
	};
};

/** service worker の console の 1 行（Electron の serviceWorkers の console-message の、ここで使うところ）。 */
export interface IParadisWorkerConsoleMessage {
	readonly message?: unknown;
	readonly level?: unknown;
	readonly sourceUrl?: unknown;
}

type RunningWorker = Pick<ServiceWorkerMain, 'scope' | 'versionId' | 'isDestroyed' | 'startTask'>;

/** 開いているイベントの応答。worker が止まると send が投げる。 */
interface IEventStream {
	send(event: IParadisExtensionApiEvent): void;
	close(): void;
}

interface IQueuedEvent {
	readonly key: string;
	readonly event: IParadisExtensionApiEvent;
	readonly queuedAt: number;
}

/** worker の文脈。受け手の登録は worker が止まっても残す（イベントが来たら起こす）。 */
interface IWorkerContext {
	readonly scope: string;
	readonly events: Set<string>;
	running: RunningWorker | undefined;
	stream: IEventStream | undefined;
	queue: IQueuedEvent[];
	starting: boolean;
	/** 最後に動き出してから worker の console に出たエラー（新しいものが後ろ。起動の失敗の理由を探すのに使う）。 */
	consoleErrors: string[];
	/** 直近の起動の失敗の理由の文言。動き出したら消す。 */
	startFailure: { detail: string; fromConsole: boolean } | undefined;
}

/** ページの文脈（ページが閉じればイベントの応答も閉じる）。 */
interface IPageContext {
	readonly events: Set<string>;
	stream: IEventStream | undefined;
}

interface IExtensionContexts {
	readonly worker: IWorkerContext;
	readonly pages: Map<string, IPageContext>;
}

interface ISessionState {
	readonly session: ParadisApiSession;
	readonly place: string;
	readonly extensions: Map<string, IExtensionContexts>;
}

/** イベントの宛先。`exceptConnection` の文脈には送らない（自分で届けた書き込みなど）。 */
export interface IParadisExtensionEventTarget {
	readonly session: ParadisApiSession;
	readonly extensionId: string;
	readonly exceptConnection?: string;
}

// 1 回の呼び出しの本文の上限（storage.sync は 100 KB まで。大きな本文を送らせて main に読ませない）
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_EVENTS = 100;
const QUEUED_EVENT_TTL_MS = 30_000;
const MAX_PAGE_CONNECTIONS = 200;
const MAX_CONSOLE_ERRORS = 5;

type ParsedRequest =
	| { readonly type: 'call'; readonly namespace: string; readonly method: string; readonly args: readonly unknown[] }
	| { readonly type: 'listen'; readonly namespace: string; readonly event: string; readonly active: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 呼び出しの形を確かめる（違えば undefined）。 */
function parseRequest(value: unknown): ParsedRequest | undefined {
	if (!isRecord(value) || typeof value.namespace !== 'string') {
		return undefined;
	}
	if (value.type === 'call' && typeof value.method === 'string' && Array.isArray(value.args)) {
		// 本文の userGesture などは読まない（利用者の操作かは main が入力の記録で決める。拡張機能は本文を自由に書ける）
		return { type: 'call', namespace: value.namespace, method: value.method, args: value.args };
	}
	if (value.type === 'listen' && typeof value.event === 'string' && typeof value.active === 'boolean') {
		return { type: 'listen', namespace: value.namespace, event: value.event, active: value.active };
	}
	return undefined;
}

const CONNECTION_PATTERN = /^(worker|page-[A-Za-z0-9-]{1,64})$/;

function eventKey(namespace: string, event: string): string {
	return `${namespace}.${event}`;
}

function chromeExtensionOrigin(id: string): string {
	return `chrome-extension://${id}`;
}

/** `chrome-extension://<id>` の id（それ以外は undefined）。 */
function extensionIdOfOrigin(origin: unknown): string | undefined {
	return typeof origin === 'string' ? /^chrome-extension:\/\/(?<id>[a-p]{32})$/.exec(origin)?.groups?.id : undefined;
}

function refuse(status: number): Response {
	return new Response(null, { status });
}

function hasPermission(extension: IParadisApiExtension, permission: string | readonly string[] | undefined, granted: readonly string[]): boolean {
	if (permission === undefined) {
		return true;
	}
	const declared = extension.manifest.permissions;
	// manifest の権限と、後から許した権限（permissions.request、場所ごと）
	return [permission].flat().some(name => (Array.isArray(declared) && declared.includes(name)) || granted.includes(name));
}

export class ParadisExtensionApiHost implements IDisposable {

	private readonly _namespaces = new Map<string, IParadisExtensionApiNamespace>();
	private readonly _tokens = new Map<string, string>();
	private readonly _states = new Map<ParadisApiSession, ISessionState>();
	private _grantedPermissions: (extensionId: string, place: string) => readonly string[] = () => [];

	constructor(private readonly _logService: { warn(message: string, ...args: unknown[]): void }) { }

	dispose(): void {
		for (const state of this._states.values()) {
			this._forgetSession(state);
		}
		this._states.clear();
	}

	/** 後から許した権限の引き方（permissions.request、場所ごと）。名前空間の権限の確かめに使う。 */
	setGrantedPermissionsLookup(lookup: (extensionId: string, place: string) => readonly string[]): void {
		this._grantedPermissions = lookup;
	}

	/** 名前空間を登録する（詰め物の一覧 PARADIS_SHIM_SURFACE と揃える）。 */
	registerNamespace(name: string, namespace: IParadisExtensionApiNamespace): void {
		this._namespaces.set(name, namespace);
	}

	/** 拡張機能のこの起動のトークン（写しのトークンのファイルへ書く。拡張機能自身のファイルからしか読めない）。 */
	tokenFor(extensionId: string): string {
		let token = this._tokens.get(extensionId);
		if (!token) {
			token = randomBytes(32).toString('hex');
			this._tokens.set(extensionId, token);
		}
		return token;
	}

	/** 拡張機能を読み込むセッションに受け手を立てる。外すときは返り値を dispose する。 */
	attachSession(session: ParadisApiSession, place: string): IDisposable {
		const existing = this._states.get(session);
		if (existing) {
			return toDisposable(() => { });
		}
		const state: ISessionState = { session, place, extensions: new Map() };
		this._states.set(session, state);
		const disposables = new DisposableStore();
		session.protocol.handle(PARADIS_EXTENSION_API_SCHEME, request => this._states.get(session) === state ? this._handle(state, request) : Promise.resolve(refuse(403)));
		const onStatus = ({ versionId, runningStatus }: { readonly versionId: number; readonly runningStatus: string }) => {
			if (this._states.get(session) !== state) {
				return;
			}
			if (runningStatus === 'starting' || runningStatus === 'running') {
				const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
				const id = worker ? extensionIdOfOrigin(worker.scope.replace(/\/$/, '')) : undefined;
				if (worker && id !== undefined && session.extensions.getExtension(id)) {
					const context = this._contextsFor(state, id).worker;
					context.running = worker;
					if (runningStatus === 'running') {
						context.startFailure = undefined;
						context.consoleErrors = [];
					}
				}
			} else if (runningStatus === 'stopped') {
				// 止まった worker は送ったものを落とす。外しておくと、次のイベントで起こして溜める
				for (const [extensionId, contexts] of state.extensions) {
					const running = contexts.worker.running;
					if (running && (running.isDestroyed() || running.versionId === versionId)) {
						contexts.worker.running = undefined;
						this._detachStream(contexts.worker);
						this._notifyContextClosed(session, extensionId, 'worker');
					}
				}
			}
		};
		session.serviceWorkers.on('running-status-changed', onStatus);
		const onConsole = (_event: unknown, details: IParadisWorkerConsoleMessage) => this._noteWorkerConsole(state, details);
		session.serviceWorkers.on('console-message', onConsole);
		const onUnloaded = (_event: unknown, extension: { readonly id: string }) => this.forgetExtension(session, extension.id);
		session.extensions.on('extension-unloaded', onUnloaded);
		disposables.add(toDisposable(() => {
			session.serviceWorkers.removeListener('running-status-changed', onStatus);
			session.serviceWorkers.removeListener('console-message', onConsole);
			session.extensions.removeListener('extension-unloaded', onUnloaded);
			if (this._states.get(session) === state) {
				this._forgetSession(state);
				this._states.delete(session);
			}
			try {
				session.protocol.unhandle(PARADIS_EXTENSION_API_SCHEME);
			} catch {
				// 既に外れている
			}
		}));
		return disposables;
	}

	/** 外した拡張機能の文脈を忘れる（イベントの応答を閉じる）。 */
	forgetExtension(session: ParadisApiSession, extensionId: string): void {
		this._notifyContextClosed(session, extensionId, undefined);
		const contexts = this._states.get(session)?.extensions.get(extensionId);
		if (!contexts) {
			return;
		}
		this._detachStream(contexts.worker);
		for (const page of contexts.pages.values()) {
			page.stream?.close();
		}
		this._states.get(session)?.extensions.delete(extensionId);
	}

	private readonly _contextClosedListeners = new Set<(session: ParadisApiSession, extensionId: string, connection: string | undefined) => void>();

	/** 拡張機能の文脈が終わった（ページが閉じた・worker が止まった。`connection` が undefined なら拡張機能を外した）。 */
	onDidCloseContext(listener: (session: ParadisApiSession, extensionId: string, connection: string | undefined) => void): IDisposable {
		this._contextClosedListeners.add(listener);
		return toDisposable(() => this._contextClosedListeners.delete(listener));
	}

	private _notifyContextClosed(session: ParadisApiSession, extensionId: string, connection: string | undefined): void {
		for (const listener of [...this._contextClosedListeners]) {
			try {
				listener(session, extensionId, connection);
			} catch (error) {
				this._logService.warn('[paradis] a browser extension context listener failed', error);
			}
		}
	}

	/**
	 * イベントを 1 つの文脈（worker か、そのページ）だけへ届ける（ネイティブメッセージングのポートは開いた文脈のもの）。
	 * worker は止まっていれば起こし、受け手が登録し直されたら出す。
	 */
	emitToConnection(session: ParadisApiSession, extensionId: string, connection: string, namespace: string, event: string, args: readonly unknown[]): void {
		const state = this._states.get(session);
		const contexts = state?.extensions.get(extensionId);
		if (!state || !contexts) {
			return;
		}
		const key = eventKey(namespace, event);
		const payload: IParadisExtensionApiEvent = { namespace, event, args };
		if (connection === 'worker') {
			if (contexts.worker.events.has(key)) {
				this._deliverToWorker(state, contexts.worker, key, payload);
			} else {
				this._queue(state, contexts.worker, key, payload);
			}
			return;
		}
		const page = contexts.pages.get(connection);
		if (page?.events.has(key)) {
			try {
				page.stream?.send(payload);
			} catch {
				page.stream = undefined;
			}
		}
	}

	/** worker を生かしておく（ネイティブメッセージングのポートが開いている間。Chrome と同じ）。終わったら end を呼ぶ。 */
	keepWorkerAlive(session: ParadisApiSession, extensionId: string): { end(): void } | undefined {
		const running = this._states.get(session)?.extensions.get(extensionId)?.worker.running;
		let task: { end(): void } | undefined;
		try {
			task = running && !running.isDestroyed() ? running.startTask() : undefined;
		} catch {
			return undefined;
		}
		if (!task) {
			return undefined;
		}
		const started = task;
		let ended = false;
		return {
			end: () => {
				if (ended) {
					return;
				}
				ended = true;
				try {
					started.end();
				} catch {
					// worker が先に止まった・入れ替わった（Electron は「Service worker was not found」で投げる）
				}
			},
		};
	}

	/** イベントを、受け手を登録した文脈へ届ける。止まっている worker は起こして、登録し直されたら出す。 */
	emit(target: IParadisExtensionEventTarget, namespace: string, event: string, args: readonly unknown[]): void {
		const state = this._states.get(target.session);
		const contexts = state?.extensions.get(target.extensionId);
		if (!state || !contexts) {
			return;
		}
		const key = eventKey(namespace, event);
		const payload: IParadisExtensionApiEvent = { namespace, event, args };
		for (const [connection, page] of contexts.pages) {
			if (connection !== target.exceptConnection && page.events.has(key)) {
				try {
					page.stream?.send(payload);
				} catch {
					page.stream = undefined;
				}
			}
		}
		if (target.exceptConnection !== 'worker' && contexts.worker.events.has(key)) {
			this._deliverToWorker(state, contexts.worker, key, payload);
		}
	}

	/**
	 * 利用者の操作のイベント（action.onClicked など）。`emit` と同じく届けるが、worker がまだ受け手を登録していない
	 * （止まっている・一度も評価に成功していない）ときも捨てずに溜めて worker を起こし、受け手が登録されたら出す。
	 * service worker の無い拡張機能では溜めない。
	 */
	emitWakingWorker(target: IParadisExtensionEventTarget, namespace: string, event: string, args: readonly unknown[]): void {
		const state = this._states.get(target.session);
		const extension = state?.session.extensions.getExtension(target.extensionId) as IParadisApiExtension | null | undefined;
		const background = extension?.manifest.background;
		const key = eventKey(namespace, event);
		const contexts = state?.extensions.get(target.extensionId);
		if (!state || target.exceptConnection === 'worker' || !isRecord(background) || typeof background.service_worker !== 'string' || contexts?.worker.events.has(key)) {
			this.emit(target, namespace, event, args);
			return;
		}
		this.emit({ ...target, exceptConnection: target.exceptConnection ?? 'worker' }, namespace, event, args);
		this._queue(state, this._contextsFor(state, target.extensionId).worker, key, { namespace, event, args });
	}

	/** 直近に worker を起動できなかった理由（無ければ undefined）。どのセッションでもよい（管理画面に出す）。 */
	workerStartError(extensionId: string): string | undefined {
		for (const state of this._states.values()) {
			const failure = state.extensions.get(extensionId)?.worker.startFailure;
			if (failure) {
				return failure.detail;
			}
		}
		return undefined;
	}

	/** worker の console のエラーを覚える。起動に失敗した後に届いた理由は、そこで記録する。 */
	private _noteWorkerConsole(state: ISessionState, details: IParadisWorkerConsoleMessage): void {
		if (this._states.get(state.session) !== state || (details.level !== 3 && details.level !== 'error')) {
			return;
		}
		const id = typeof details.sourceUrl === 'string' ? /^chrome-extension:\/\/(?<id>[a-p]{32})\//.exec(details.sourceUrl)?.groups?.id : undefined;
		if (id === undefined || !state.session.extensions.getExtension(id)) {
			return;
		}
		const context = this._contextsFor(state, id).worker;
		const message = String(details.message).slice(0, 500);
		context.consoleErrors.push(message);
		if (context.consoleErrors.length > MAX_CONSOLE_ERRORS) {
			context.consoleErrors.shift();
		}
		const failure = context.startFailure;
		if (failure && !failure.fromConsole) {
			failure.detail = message;
			failure.fromConsole = true;
			this._logService.warn(`[paradis] could not start a browser extension worker (${id}): ${message}`);
		}
	}

	/**
	 * 同じ場所（`default` / `profile:<id>`）を使うすべてのセッションへ届ける（storage.sync は場所ごとに 1 つで、
	 * Global と各ワークスペースのセッションが同じ中身を見るため）。`except` の文脈には送らない。
	 */
	emitToPlace(place: string, extensionId: string, namespace: string, event: string, args: readonly unknown[], except?: { readonly session: ParadisApiSession; readonly connection: string }): void {
		for (const state of this._states.values()) {
			if (state.place === place) {
				this.emit({ session: state.session, extensionId, exceptConnection: except?.session === state.session ? except.connection : undefined }, namespace, event, args);
			}
		}
	}

	/**
	 * worker が起動するときに出すイベント（runtime.onInstalled など）。worker の最上位の受け手は少し後に
	 * main へ届くので、まだ登録されていなければ溜めて待つ（届かないものは期限で捨てる）。
	 */
	emitToWorkerWhenListening(session: ParadisApiSession, extensionId: string, namespace: string, event: string, args: readonly unknown[]): void {
		const state = this._states.get(session);
		if (!state) {
			return;
		}
		const contexts = this._contextsFor(state, extensionId);
		const key = eventKey(namespace, event);
		const payload: IParadisExtensionApiEvent = { namespace, event, args };
		if (contexts.worker.events.has(key)) {
			this._deliverToWorker(state, contexts.worker, key, payload);
		} else {
			this._queue(state, contexts.worker, key, payload);
		}
	}

	private _contextsFor(state: ISessionState, extensionId: string): IExtensionContexts {
		let contexts = state.extensions.get(extensionId);
		if (!contexts) {
			contexts = {
				worker: { scope: `${chromeExtensionOrigin(extensionId)}/`, events: new Set(), running: undefined, stream: undefined, queue: [], starting: false, consoleErrors: [], startFailure: undefined },
				pages: new Map(),
			};
			state.extensions.set(extensionId, contexts);
		}
		return contexts;
	}

	private _forgetSession(state: ISessionState): void {
		for (const contexts of state.extensions.values()) {
			this._detachStream(contexts.worker);
			for (const page of contexts.pages.values()) {
				page.stream?.close();
			}
		}
		state.extensions.clear();
	}

	private _detachStream(context: IWorkerContext, stream?: IEventStream): void {
		if (!context.stream || (stream && context.stream !== stream)) {
			return;
		}
		const closing = context.stream;
		context.stream = undefined;
		closing.close();
	}

	private _deliverToWorker(state: ISessionState, context: IWorkerContext, key: string, payload: IParadisExtensionApiEvent): void {
		if (!this._sendToWorker(context, payload)) {
			this._queue(state, context, key, payload);
		}
	}

	private _sendToWorker(context: IWorkerContext, payload: IParadisExtensionApiEvent): boolean {
		const stream = context.stream;
		if (!stream) {
			return false;
		}
		try {
			stream.send(payload);
		} catch {
			this._detachStream(context, stream);
			return false;
		}
		// Chrome はイベントのたびに worker の待ち時間を延ばす。task の始めと終わりで同じことをする
		try {
			if (context.running && !context.running.isDestroyed()) {
				context.running.startTask().end();
			}
		} catch {
			// 止まりかけている
		}
		return true;
	}

	private _queue(state: ISessionState, context: IWorkerContext, key: string, payload: IParadisExtensionApiEvent): void {
		context.queue.push({ key, event: payload, queuedAt: Date.now() });
		if (context.queue.length > MAX_QUEUED_EVENTS) {
			context.queue.shift();
		}
		this._startWorker(state, context);
	}

	/** 受け手が登録し直された worker へ、溜めていたイベントを出す。 */
	private _flushQueue(context: IWorkerContext, key: string): void {
		if (!context.stream) {
			return;
		}
		const now = Date.now();
		context.queue = context.queue.filter(queued => now - queued.queuedAt <= QUEUED_EVENT_TTL_MS && (queued.key !== key || !this._sendToWorker(context, queued.event)));
	}

	private _startWorker(state: ISessionState, context: IWorkerContext): void {
		if (context.starting || context.stream) {
			return;
		}
		context.starting = true;
		// 起動の失敗の理由は、この起動から後に出たエラーだけから選ぶ（前に動いていたときのエラーを理由にしない）
		context.consoleErrors = [];
		state.session.serviceWorkers.startWorkerForScope(context.scope)
			.then(worker => {
				context.running = worker;
				context.startFailure = undefined;
			}, error => {
				// Electron の答えは「Failed to start service worker.」だけ。worker の評価で投げた例外は console に出るので、
				// 最後に動き出してから出たエラーがあればそれを理由にする（後から届いたら _noteWorkerConsole が記録する）
				const fromConsole = context.consoleErrors.at(-1);
				const detail = fromConsole ?? (error instanceof Error ? error.message : String(error));
				context.startFailure = { detail, fromConsole: fromConsole !== undefined };
				this._logService.warn(`[paradis] could not start a browser extension worker (${context.scope.slice('chrome-extension://'.length, -1)}): ${detail}`);
			})
			.finally(() => context.starting = false);
	}

	private async _handle(state: ISessionState, request: Request): Promise<Response> {
		if (request.method !== 'POST') {
			return refuse(405);
		}
		// 本文を読む前に、呼び出し元がこのセッションに読み込んだ拡張機能かを見る
		const extensionId = extensionIdOfOrigin((request as Request & { readonly initiatorOrigin?: unknown }).initiatorOrigin);
		const extension = extensionId !== undefined ? state.session.extensions.getExtension(extensionId) : null;
		if (!extension || extensionId === undefined) {
			return refuse(403);
		}
		// トークンと文脈の名前は URL にある。本文を読む前に確かめる
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			return refuse(400);
		}
		const token = url.searchParams.get('t');
		const connection = url.searchParams.get('c');
		if (token === null || this._tokens.get(extensionId) !== token || this._states.get(state.session) !== state) {
			return refuse(403);
		}
		if (connection === null || !CONNECTION_PATTERN.test(connection)) {
			return refuse(400);
		}
		const headers = { 'access-control-allow-origin': chromeExtensionOrigin(extensionId), 'cache-control': 'no-store' };
		const contexts = this._contextsFor(state, extensionId);
		const fromWorker = connection === 'worker';
		const endpoint = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
		if (endpoint === PARADIS_EXTENSION_API_EVENTS_URL) {
			return this._openEventStream(contexts, connection, headers, state.session, extensionId);
		}
		if (endpoint !== PARADIS_EXTENSION_API_CALL_URL) {
			return refuse(404);
		}
		const text = await this._readBounded(request);
		if (text === undefined) {
			return refuse(413);
		}
		let rawRequest: unknown;
		try {
			const body = paradisDecodeExtensionWire(text);
			rawRequest = isRecord(body) ? body.request : undefined;
		} catch {
			return refuse(400);
		}
		const caller: IParadisExtensionApiCaller = { extension, session: state.session, place: state.place, connection, fromWorker };
		// 呼び出しが開いている間だけ worker を生かしておく（呼び出しの間に worker が入れ替わっても、答えは返す）
		const task = fromWorker ? this.keepWorkerAlive(state.session, extension.id) : undefined;
		try {
			const reply = await this._invoke(caller, contexts, rawRequest);
			return new Response(paradisEncodeExtensionWire(reply), { headers: { ...headers, 'content-type': 'application/json' } });
		} finally {
			task?.end();
		}
	}

	private async _readBounded(request: Request): Promise<string | undefined> {
		if (!request.body) {
			return '';
		}
		const reader = request.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (; ;) {
			const read = await reader.read();
			if (read.done) {
				return Buffer.concat(chunks).toString('utf8');
			}
			size += read.value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(read.value);
		}
	}

	private _openEventStream(contexts: IExtensionContexts, connection: string, headers: Record<string, string>, sessionOfContexts: ParadisApiSession, extensionIdOfContexts: string | undefined): Response {
		const encoder = new TextEncoder();
		let opened: IEventStream | undefined;
		const isWorker = connection === 'worker';
		const body = new ReadableStream<Uint8Array>({
			start: controller => {
				opened = {
					send: event => controller.enqueue(encoder.encode(`${paradisEncodeExtensionWire(event)}\n`)),
					close: () => {
						try {
							controller.close();
						} catch {
							// 閉じている・worker が止まって取り消された
						}
					},
				};
				if (isWorker) {
					// 新しい応答が古いものに代わる（1 つの拡張機能の worker はセッションに 1 つ）
					if (contexts.worker.stream !== opened) {
						contexts.worker.stream?.close();
					}
					contexts.worker.stream = opened;
				} else {
					let page = contexts.pages.get(connection);
					if (!page) {
						if (contexts.pages.size >= MAX_PAGE_CONNECTIONS) {
							// 閉じたページの応答が残り続けないよう、古いものから外す
							const [oldest] = contexts.pages.keys();
							contexts.pages.get(oldest)?.stream?.close();
							contexts.pages.delete(oldest);
							// 追い出したページの文脈も終わったものとして知らせる（ネイティブメッセージングのホストを残さない）
							if (extensionIdOfContexts !== undefined) {
								this._notifyContextClosed(sessionOfContexts, extensionIdOfContexts, oldest);
							}
						}
						page = { events: new Set(), stream: undefined };
						contexts.pages.set(connection, page);
					}
					page.stream?.close();
					page.stream = opened;
				}
			},
			// 文脈が止まる・閉じると fetch が取り消される。それで届け先が無くなったと分かる
			cancel: () => {
				if (isWorker) {
					if (opened) {
						this._detachStream(contexts.worker, opened);
					}
				} else if (contexts.pages.get(connection)?.stream === opened) {
					contexts.pages.delete(connection);
					// ページが閉じた（そのページが開いたネイティブメッセージングのポートを閉じる）
					if (extensionIdOfContexts !== undefined) {
						this._notifyContextClosed(sessionOfContexts, extensionIdOfContexts, connection);
					}
				}
			},
		});
		return new Response(body, { headers: { ...headers, 'content-type': 'application/x-ndjson' } });
	}

	private async _invoke(caller: IParadisExtensionApiCaller, contexts: IExtensionContexts, rawRequest: unknown): Promise<ParadisExtensionApiReply> {
		try {
			const request = parseRequest(rawRequest);
			if (!request) {
				throw new ParadisExtensionApiError('Malformed extension API request');
			}
			const namespace = this._namespaces.get(request.namespace);
			if (!namespace) {
				throw new ParadisExtensionApiError(`chrome.${request.namespace} is not available`);
			}
			if (!hasPermission(caller.extension, namespace.permission, this._grantedPermissions(caller.extension.id, caller.place))) {
				throw new ParadisExtensionApiError(`This API requires the "${[namespace.permission].flat()[0]}" permission`);
			}
			if (request.type === 'listen') {
				if (!namespace.events.includes(request.event)) {
					throw new ParadisExtensionApiError(`Unknown event ${request.namespace}.${request.event}`);
				}
				const key = eventKey(request.namespace, request.event);
				if (caller.fromWorker) {
					if (request.active) {
						contexts.worker.events.add(key);
						this._flushQueue(contexts.worker, key);
					} else {
						contexts.worker.events.delete(key);
					}
				} else {
					const page = contexts.pages.get(caller.connection);
					if (page) {
						if (request.active) {
							page.events.add(key);
						} else {
							page.events.delete(key);
						}
					}
				}
				return { ok: true, value: undefined };
			}
			const method = Object.prototype.hasOwnProperty.call(namespace.methods, request.method) ? namespace.methods[request.method] : undefined;
			if (!method) {
				throw new ParadisExtensionApiError(`chrome.${request.namespace}.${request.method} is not available`);
			}
			return { ok: true, value: await method.invoke(caller, request.args) };
		} catch (error) {
			if (!(error instanceof ParadisExtensionApiError)) {
				this._logService.warn('[paradis] a browser extension API call failed', error);
			}
			return { ok: false, error: error instanceof Error && error.message ? error.message : 'Extension API call failed' };
		}
	}
}
