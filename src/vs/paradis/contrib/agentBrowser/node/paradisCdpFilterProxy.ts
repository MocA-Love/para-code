/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDPメッセージレベルのフィルタリングプロキシ（Supersetの cdp-filter-proxy.ts の移植）。
// 上流はPara Code（Electron）本体のremote-debuggingエンドポイント＝全webContentsが見える
// 生のCDPなので、ここで「バインド済みページのtargetId（とその子孫）以外は見えない・触れない」
// ことを保証する。呼び出し元の識別（トークン解決）はゲートウェイ側（paradisCdpGateway.ts）の
// 責務で、このモジュールは接続確立後のメッセージフィルタのみを担う。
//
// 不変条件:
//   - ブラウザレベル接続（/devtools/browser/…）: クライアントはバインド済みセット内の
//     targetIdしか観測できない。Target.attachToTarget は範囲内だけ許可し、
//     activateTarget / createTarget は常に拒否（Para Codeでは
//     MCPからの新規タブ生成を提供しない）。Target.closeTarget / Page.close も常に拒否
//     （共有中のWebContentsView自体が破棄されるため。ALWAYS_DENIED_METHODS参照）。
//     Target.getTargets の結果も絞り込む。
//   - ウィンドウサイズ操作系（Browser.getWindowForTarget / setContentsSize 等）は
//     Electron未実装（-32601素通し）にせず、-32000で理由と代替（emulate）を明示して拒否。
//   - セッションスコープの Page.captureScreenshot は、対象がバインド済みprimaryページ
//     なら electron-main の BrowserView.captureScreenshot()（非表示時の回避策付き）へ
//     委譲してCDPレスポンスを合成する。対応外・委譲失敗は理由付きで明示拒否する。
//   - 許可した Input.* はupstreamへ流さず、exact BrowserView debugger rootへ直接配送する。
//   - ページレベル接続（/devtools/page/<id>…）: 単一ページセッションの透過転送。
//     スコープはゲートウェイのtargetIdチェックで担保済み。
//   - `Target.setAutoAttach` / `Target.setDiscoverTargets` の `filter` は除去する
//     （puppeteer/cdp-useがElectronの`webview`型ターゲットで固まる問題の回避。Superset知見）。
//   - `type: "webview"` は `page` に書き換える（puppeteerの browser.pages() は
//     type==='page' しか数えないため）。
//   - スコープ外ターゲットへの auto-attach イベントは握りつぶすが、
//     `waitForDebuggerOnStart` で一時停止したまま放置しないよう、内部リクエストで
//     `Runtime.runIfWaitingForDebugger` + `Target.detachFromTarget` を送って解放する
//     （上流はアプリ全体なので、放置すると新規ウィンドウ等が固まる恐れがある）。

import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type * as wsTypes from 'ws';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX, BROWSER_VIEW_SCREENSHOT_MAX_EDGE, BROWSER_VIEW_SCREENSHOT_MAX_PIXELS, BROWSER_VIEW_SCREENSHOT_TIMEOUT_MS } from '../../../../platform/browserView/common/browserViewScreenshot.js';
import { IParadisCdpScreenshotOptions } from '../common/paradisAgentBrowser.js';
import { IParadisCdpInputQueueOperation } from './paradisCdpInputQueue.js';

/** 動的import済みの `ws` モジュール（ゲートウェイが1回だけロードして渡す）。 */
export interface IParadisWsModule {
	readonly WebSocket: typeof wsTypes.WebSocket;
	readonly WebSocketServer: typeof wsTypes.WebSocketServer;
}

/**
 * ブラウザレベルフィルタのバインディング契約。
 * boundTargetIds() は毎回再評価される（バインド変更後の接続は強制切断されるが、
 * 切断が届く前のメッセージにも最新のセットが効くようにする）。
 */
export interface IParadisBoundContext {
	/** 現在バインドされているtargetIdのセット。 */
	boundTargetIds(): ReadonlySet<string>;
	/** This WebSocket's gateway-issued generation is still the live token authority. */
	isCurrentLease(): boolean;
	/** 接続確立時に呼ばれる（バインド変更時の強制切断用に登録する）。 */
	onOpen(ws: wsTypes.WebSocket): void;
	/** Same pane authority shared by page- and browser-level WebSocket connections. */
	readonly rawScreenshotCoordinator: ParadisRawScreenshotCoordinator;
	/**
	 * バインド済みprimaryページのスクリーンショットを、electron-mainのupstream実装
	 * `BrowserView.captureScreenshot()`（非表示時の回避策付き）へ委譲して撮る。
	 * 戻り値はbase64エンコード済み画像データ。ビュー消滅・世代変更・capture失敗は
	 * `PARA_BROWSER_RETRYABLE` errorとしてrejectする。
	 */
	captureBoundPageScreenshot(options: IParadisCdpScreenshotOptions): Promise<string | undefined>;
	/** Whether the currently bound BrowserView is visible to the user. */
	isBoundPageVisible(): Promise<boolean>;
	dispatchBoundPageInput(expectedTargetId: string, method: string, paramsJson: string, isRouteCurrent?: () => boolean): IParadisCdpInputQueueOperation;
	closeInputConnection(): void;
}

interface IJsonRpcMsg {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
	sessionId?: string;
}

interface IParadisClientCommand extends IJsonRpcMsg {
	readonly id: number;
	readonly method: string;
	readonly params?: Record<string, unknown>;
	readonly sessionId?: string;
}

interface IParadisPendingRequest {
	readonly method: string;
	readonly sessionId: string | undefined;
	readonly targetId: string | undefined;
	readonly byteLength: number;
}

const MAX_CDP_PENDING_REQUESTS = 1_024;
// Debugger metadata can legitimately contain multi-megabyte inline source maps in a single
// frame. Keep every transport stage on the same bounded ceiling so a valid frame accepted by
// the parser is not rejected by an earlier queue or later backpressure check.
const MAX_CDP_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_CDP_SCREENSHOT_FRAME_BYTES = MAX_CDP_FRAME_BYTES;
const MAX_CDP_CONNECTING_QUEUE_BYTES = MAX_CDP_FRAME_BYTES;
const MAX_CDP_OPEN_BUFFERED_BYTES = MAX_CDP_FRAME_BYTES;
const MAX_CDP_METHOD_LENGTH = 256;
const MAX_CDP_IDENTIFIER_LENGTH = 512;
const MAX_CDP_ROUTING_ENTRIES = 4_096;
const MAX_CDP_PENDING_POLICY_BYTES = 1024 * 1024;
const PARADIS_CDP_PRE_INPUT_BARRIER_TIMEOUT_MS = 5_000;

interface IParadisForwardedRequestBarrier {
	readonly sessionId: string | undefined;
	readonly settled: Promise<void>;
	resolve(): void;
}

function registerForwardedRequestBarrier(
	barriers: Map<number, IParadisForwardedRequestBarrier>,
	id: number,
	sessionId: string | undefined,
): boolean {
	if (barriers.has(id) || barriers.size >= MAX_CDP_PENDING_REQUESTS) {
		return false;
	}
	let resolve!: () => void;
	const settled = new Promise<void>(onResolve => resolve = onResolve);
	barriers.set(id, { sessionId, settled, resolve });
	return true;
}

function completeForwardedRequestBarrier(
	barriers: Map<number, IParadisForwardedRequestBarrier>,
	id: number,
	sessionId: string | undefined,
): void {
	const barrier = barriers.get(id);
	if (!barrier || barrier.sessionId !== sessionId) {
		return;
	}
	barriers.delete(id);
	barrier.resolve();
}

function clearForwardedRequestBarriers(barriers: Map<number, IParadisForwardedRequestBarrier>): void {
	for (const barrier of barriers.values()) {
		barrier.resolve();
	}
	barriers.clear();
}

async function waitForPriorForwardedRequests(
	barriers: readonly Promise<void>[],
	connectionClosed: Promise<void>,
): Promise<'ready' | 'closed' | 'timeout'> {
	if (barriers.length === 0) {
		return 'ready';
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.all(barriers).then(() => 'ready' as const),
			connectionClosed.then(() => 'closed' as const),
			new Promise<'timeout'>(resolve => timeout = setTimeout(() => resolve('timeout'), PARADIS_CDP_PRE_INPUT_BARRIER_TIMEOUT_MS)),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}

function rawDataByteLength(data: wsTypes.RawData): number {
	if (Array.isArray(data)) {
		return data.reduce((total, chunk) => total + chunk.byteLength, 0);
	}
	return data.byteLength;
}

function rawDataText(data: wsTypes.RawData): string {
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}
	return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

function payloadByteLength(data: wsTypes.RawData | string): number {
	return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : rawDataByteLength(data);
}

function sendWithBoundedBackpressure(socket: wsTypes.WebSocket, data: wsTypes.RawData | string, allowScreenshotFrame = false, forceText = false): boolean {
	const bytes = payloadByteLength(data);
	const frameLimit = allowScreenshotFrame ? MAX_CDP_SCREENSHOT_FRAME_BYTES : MAX_CDP_FRAME_BYTES;
	const bufferedLimit = allowScreenshotFrame ? MAX_CDP_SCREENSHOT_FRAME_BYTES : MAX_CDP_OPEN_BUFFERED_BYTES;
	const bufferedAmount = Number.isSafeInteger(socket.bufferedAmount) && socket.bufferedAmount >= 0 ? socket.bufferedAmount : bufferedLimit + 1;
	if (bytes > frameLimit || bufferedAmount + bytes > bufferedLimit) {
		return false;
	}
	try {
		// CDPはテキスト専用プロトコル。Bufferをそのまま送るとwsがバイナリフレーム化し、
		// Chromium DevToolsエンドポイントが最初のバイナリフレーム受信で接続を切断する。
		// ページ経路はRawData(Buffer)を素通しするため、テキストフレームを強制する。
		if (forceText) {
			socket.send(data, { binary: false });
		} else {
			socket.send(data);
		}
		return true;
	} catch {
		return false;
	}
}

function boundedIdentifier(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_CDP_IDENTIFIER_LENGTH ? value : undefined;
}

function hasBoundedRoutingIdentifiers(value: unknown): boolean {
	if (!isRecord(value)) {
		return true;
	}
	for (const key of ['sessionId', 'targetId', 'openerId', 'browserContextId'] as const) {
		if (value[key] !== undefined && boundedIdentifier(value[key]) === undefined) {
			return false;
		}
	}
	return value.targetInfo === undefined || hasBoundedRoutingIdentifiers(value.targetInfo);
}

function logNonThrowing(logService: ILogService, level: 'trace' | 'debug' | 'warn', message: string): void {
	try { logService[level](message); } catch { /* diagnostics must not interrupt transport cleanup */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseClientCommand(data: wsTypes.RawData): IParadisClientCommand | undefined {
	if (rawDataByteLength(data) > MAX_CDP_FRAME_BYTES) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(rawDataText(data));
	} catch {
		return undefined;
	}
	if (!isRecord(value)
		|| !Number.isSafeInteger(value.id)
		|| (value.id as number) < 0
		|| typeof value.method !== 'string'
		|| value.method.length === 0
		|| value.method.length > MAX_CDP_METHOD_LENGTH
		|| (value.params !== undefined && !isRecord(value.params))
		|| !hasBoundedRoutingIdentifiers(value.params)
		|| (value.sessionId !== undefined && boundedIdentifier(value.sessionId) === undefined)) {
		return undefined;
	}
	return value as unknown as IParadisClientCommand;
}

function parseJsonRecord(data: wsTypes.RawData, maxBytes = MAX_CDP_FRAME_BYTES): IJsonRpcMsg | undefined {
	if (rawDataByteLength(data) > maxBytes) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(rawDataText(data));
	} catch {
		return undefined;
	}
	return isRecord(value)
		&& hasBoundedRoutingIdentifiers(value.params)
		&& hasBoundedRoutingIdentifiers(value.result)
		? value as IJsonRpcMsg
		: undefined;
}

/**
 * 常に拒否するCDPメソッド → クライアント（LLM）向け説明メッセージ。
 * アプリ全体・共有パーティション・共有ページの生存に波及するものを列挙する
 * （Superset permissions.ts のdenylistの部分移植）。
 * ルートフレーム・セッションフレームの双方に効く（sessionId判定より先に評価される）。
 */
const ALWAYS_DENIED_METHODS = new Map<string, string>([
	// アプリ全体の生存に波及（Para Code本体が終了/クラッシュしてしまう）
	['Browser.close', 'Browser.close is not permitted by the Para Code CDP gateway.'],
	['Browser.crash', 'Browser.crash is not permitted by the Para Code CDP gateway.'],
	['Browser.crashGpuProcess', 'Browser.crashGpuProcess is not permitted by the Para Code CDP gateway.'],
	['Target.createTarget', 'Target.createTarget is not permitted: pages must be opened and shared from the Para Code UI.'],
	['Target.activateTarget', 'Target.activateTarget is not permitted: CDP automation must not move focus away from the user.'],
	['Target.createBrowserContext', 'Target.createBrowserContext is not permitted by the Para Code CDP gateway.'],
	['Target.disposeBrowserContext', 'Target.disposeBrowserContext is not permitted by the Para Code CDP gateway.'],
	['Target.setRemoteLocations', 'Target.setRemoteLocations is not permitted by the Para Code CDP gateway.'],
	['Target.exposeDevToolsProtocol', 'Target.exposeDevToolsProtocol is not permitted by the Para Code CDP gateway.'],
	['Target.openDevTools', 'Target.openDevTools is not permitted by the Para Code CDP gateway.'],
	['Target.sendMessageToTarget', 'Target.sendMessageToTarget is not permitted because its nested JSON-RPC payload cannot bypass the Para Code CDP policy.'],
	// 共有ページの生存に波及（バインド済みWebContentsView自体が破棄され、Para Code側の
	// エディタからもページが失われる）。close_page ツールはこの2つに乗る
	['Target.closeTarget', 'Target.closeTarget is not permitted: the target is a page shared from the Para Code UI, and closing it would destroy the shared browser view. Ask the user to close the page from Para Code instead.'],
	['Page.close', 'Page.close is not permitted: the page is shared from the Para Code UI. Ask the user to close it from Para Code instead.'],
	['Page.setWebLifecycleState', 'Page.setWebLifecycleState is not permitted: the lifecycle of the shared page is managed by Para Code.'],
	// 共有Cookie/ストレージパーティション全体に波及（lighthouse_audit の既定フローが
	// clearDataForOrigin を撃つため、明示的に拒否して事故を防ぐ）
	['Storage.clearDataForOrigin', 'Storage.clearDataForOrigin is not permitted: the embedded browser shares a cookie/storage partition across Para Code, so clearing data would affect other pages too.'],
	['Storage.clearDataForStorageKey', 'Storage.clearDataForStorageKey is not permitted: the embedded browser shares a cookie/storage partition across Para Code, so clearing data would affect other pages too.'],
	['Storage.clearCookies', 'Storage.clearCookies is not permitted: the embedded browser shares a cookie partition across Para Code, so clearing cookies would affect other pages too.'],
	['Network.clearBrowserCookies', 'Network.clearBrowserCookies is not permitted: the embedded browser shares a cookie partition across Para Code, so clearing cookies would affect other pages too.'],
	['Network.clearBrowserCache', 'Network.clearBrowserCache is not permitted: the embedded browser shares a cache across Para Code, so clearing it would affect other pages too.'],
]);

const SHARED_STATE_DENIED_METHODS = new Set([
	'Storage.getCookies',
	'Storage.setCookies',
	'Network.getAllCookies',
	'Network.getCookies',
	'Network.setCookie',
	'Network.setCookies',
	'Network.deleteCookies',
	'Page.setDownloadBehavior',
]);

const SHARED_STATE_DENIED_DOMAINS = [
	'Browser.',
	'CacheStorage.',
	'DOMStorage.',
	'IndexedDB.',
	'Security.',
	'ServiceWorker.',
	'Storage.',
] as const;

const BROWSER_ROOT_ALLOWED_METHODS = new Set([
	'Browser.getVersion',
	'Target.getBrowserContexts',
	'Target.setDiscoverTargets',
	'Target.setAutoAttach',
	'Target.getTargets',
	'Target.getTargetInfo',
	'Target.attachToTarget',
	'Target.detachFromTarget',
]);

const BROWSER_SESSION_ALLOWED_TARGET_METHODS = new Set([
	'Target.setAutoAttach',
	'Target.getTargetInfo',
	'Target.attachToTarget',
	'Target.detachFromTarget',
]);

function sharedStateDeniedMessage(method: string): string | undefined {
	if (SHARED_STATE_DENIED_DOMAINS.some(domain => method.startsWith(domain)) || SHARED_STATE_DENIED_METHODS.has(method)) {
		return `${method} is not permitted: this CDP connection is scoped to one Para Code browser pane and cannot access shared browser state.`;
	}
	return undefined;
}

/**
 * ウィンドウ/コンテンツサイズ操作系のCDPメソッド → 明示エラーメッセージ。
 * Electron自体がこれらを未実装（-32601）だが、素通しすると chrome-devtools-mcp の
 * resize_page が原因不明のエラーで失敗するため、-32000 で「なぜ使えないか・代わりに
 * 何を使うべきか」をLLMが読める形で返す。
 */
const LAYOUT_MANAGED_DENIED_MESSAGE = 'the Para Code embedded browser view is laid out by the workbench, so its window/content size cannot be changed over CDP (the resize_page tool is not supported). To change the page viewport, use the emulate tool (Emulation.setDeviceMetricsOverride) instead.';
const LAYOUT_MANAGED_DENIED_METHODS = new Set([
	'Browser.getWindowForTarget',
	'Browser.getWindowBounds',
	'Browser.setWindowBounds',
	'Browser.setContentsSize',
]);

const MAX_DELEGATED_CLIP_EDGE = BROWSER_VIEW_SCREENSHOT_MAX_EDGE;
const MAX_DELEGATED_CLIP_PIXELS = BROWSER_VIEW_SCREENSHOT_MAX_PIXELS;

/**
 * セッションスコープの `Page.captureScreenshot` パラメータを、electron-main委譲用の
 * オプション（{@link IParadisCdpScreenshotOptions}）へマッピングする。
 * PNG/JPEGのviewport、full-page、scale 1 clipを委譲用optionへ分類する。
 * WebPは表示中に限るraw互換経路、`fromSurface: false`、非unit scale、malformed/巨大clipは
 * 理由付きの明示拒否へ分類し、委譲失敗を含めてsilent raw fallbackを許可しない。
 */
export type IParadisCaptureScreenshotParameterPolicy =
	| { readonly kind: 'delegate'; readonly options: IParadisCdpScreenshotOptions }
	| { readonly kind: 'raw-webp' }
	| { readonly kind: 'reject'; readonly reason: string };

export interface IParadisCaptureScreenshotRequest {
	readonly id: number;
	readonly sessionId?: string;
	readonly params?: Record<string, unknown>;
}

export type IParadisCaptureScreenshotResponse = {
	readonly id: number;
	readonly sessionId?: string;
	readonly result?: { readonly data: string };
	readonly error?: { readonly code: number; readonly message: string };
};

export type IParadisCaptureScreenshotResolution =
	| { readonly kind: 'forward' }
	| { readonly kind: 'respond'; readonly response: IParadisCaptureScreenshotResponse };

interface IParadisRawScreenshotEntry {
	readonly owner: object;
	readonly request: IParadisCaptureScreenshotRequest;
	timer: ReturnType<typeof setTimeout> | undefined;
	readonly startedAt: number;
	readonly onComplete: ((durationMs: number) => void) | undefined;
	timedOut: boolean;
	closing: boolean;
}

export interface IParadisRawScreenshotLifecycleCallbacks {
	readonly onTimeout: (request: IParadisCaptureScreenshotRequest) => void;
	readonly onComplete?: (durationMs: number) => void;
}

/** Bounds the one deliberate raw-CDP exception (visible WebP) without allowing overlap after timeout. */
export class ParadisRawScreenshotCoordinator {
	private _active: IParadisRawScreenshotEntry | undefined;
	private _disposed = false;

	constructor(private readonly timeoutMs = BROWSER_VIEW_SCREENSHOT_TIMEOUT_MS) { }

	begin(owner: object, request: IParadisCaptureScreenshotRequest, callbacks: IParadisRawScreenshotLifecycleCallbacks): boolean {
		if (this._disposed || this._active) {
			return false;
		}
		const entry: IParadisRawScreenshotEntry = {
			owner,
			request,
			startedAt: Date.now(),
			onComplete: callbacks.onComplete,
			timedOut: false,
			closing: false,
			timer: undefined,
		};
		entry.timer = setTimeout(() => {
			if (this._active !== entry) {
				return;
			}
			entry.timer = undefined;
			entry.timedOut = true;
			try { callbacks.onTimeout(request); } catch { /* closing transport */ }
		}, this.timeoutMs);
		this._active = entry;
		return true;
	}

	complete(owner: object, id: number | undefined, sessionId: string | undefined): { readonly handled: boolean; readonly suppress: boolean; readonly durationMs?: number } {
		const entry = this._active;
		if (!entry || entry.owner !== owner || entry.request.id !== id || entry.request.sessionId !== sessionId) {
			return { handled: false, suppress: false };
		}
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		this._active = undefined;
		const durationMs = Math.max(0, Date.now() - entry.startedAt);
		if (!entry.timedOut && !entry.closing) {
			try { entry.onComplete?.(durationMs); } catch { /* diagnostics must not affect transport */ }
		}
		return { handled: true, suppress: entry.timedOut, durationMs };
	}

	get hasActiveRequest(): boolean {
		return this._active !== undefined;
	}

	hasActiveRequestForOwner(owner: object): boolean {
		return this._active?.owner === owner;
	}

	get timeoutMilliseconds(): number {
		return this.timeoutMs;
	}

	/** Stop the timeout clock while retaining pane-wide ownership until upstream close confirmation. */
	markClosing(owner: object): void {
		const entry = this._active;
		if (entry?.owner !== owner) {
			return;
		}
		entry.closing = true;
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
	}

	release(owner: object): void {
		if (this._active?.owner === owner) {
			if (this._active.timer !== undefined) {
				clearTimeout(this._active.timer);
			}
			this._active = undefined;
		}
	}

	dispose(): void {
		this._disposed = true;
		if (this._active) {
			if (this._active.timer !== undefined) {
				clearTimeout(this._active.timer);
			}
			this._active = undefined;
		}
	}
}

/** Gateway-owned token authority registry shared by every page/browser WebSocket context. */
export class ParadisRawScreenshotAuthorityRegistry {
	private readonly _coordinators = new Map<string, ParadisRawScreenshotCoordinator>();

	constructor(private readonly timeoutMs = BROWSER_VIEW_SCREENSHOT_TIMEOUT_MS) { }

	forAuthority(authority: string): ParadisRawScreenshotCoordinator {
		let coordinator = this._coordinators.get(authority);
		if (!coordinator) {
			coordinator = new ParadisRawScreenshotCoordinator(this.timeoutMs);
			this._coordinators.set(authority, coordinator);
		}
		return coordinator;
	}

	retire(authority: string): void {
		this._coordinators.get(authority)?.dispose();
		this._coordinators.delete(authority);
	}

	dispose(): void {
		for (const coordinator of this._coordinators.values()) {
			coordinator.dispose();
		}
		this._coordinators.clear();
	}
}

export interface IParadisRawScreenshotUpstream {
	readonly readyState: number;
	terminate?(): void;
	close(): void;
}

/** Initiate the strongest available upstream close and report only synchronous CLOSED confirmation. */
export function paradisForceCloseRawScreenshotUpstream(
	upstream: IParadisRawScreenshotUpstream,
	openState: number,
	closedState: number,
): boolean {
	if (upstream.readyState === closedState) {
		return true;
	}
	if (upstream.readyState === openState) {
		if (upstream.terminate) {
			try {
				upstream.terminate();
			} catch {
				try { upstream.close(); } catch { /* keep the authority poisoned until retire/dispose */ }
			}
		} else {
			try { upstream.close(); } catch { /* keep the authority poisoned until retire/dispose */ }
		}
	} else {
		try { upstream.close(); } catch { /* keep the authority poisoned until retire/dispose */ }
	}
	return upstream.readyState === closedState;
}

/**
 * Register the accepted page WebSocket before rechecking the live binding. Once registered,
 * a later rebind is covered by the gateway's connection sweep; if the rebind already happened,
 * do not create an upstream CDP connection for the stale target.
 */
export function paradisRegisterPageUpgrade<T>(
	targetId: string,
	clientWs: wsTypes.WebSocket,
	ctx: IParadisBoundContext,
	createUpstream: () => T,
): T | undefined {
	if (!ctx.isCurrentLease() || !ctx.boundTargetIds().has(targetId)) {
		try { clientWs.close(1000, 'para-code: browser binding changed, reconnect'); } catch { /* ignore */ }
		return undefined;
	}
	ctx.onOpen(clientWs);
	if (!ctx.isCurrentLease() || !ctx.boundTargetIds().has(targetId)) {
		try { clientWs.close(1000, 'para-code: browser binding changed, reconnect'); } catch { /* ignore */ }
		return undefined;
	}
	return createUpstream();
}

function screenshotResponse(
	request: IParadisCaptureScreenshotRequest,
	body: Pick<IParadisCaptureScreenshotResponse, 'result' | 'error'>,
): IParadisCaptureScreenshotResponse {
	return {
		id: request.id,
		...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
		...body,
	};
}

export interface IParadisVisibleWebPCaptureCallbacks {
	readonly respond: (response: IParadisCaptureScreenshotResponse) => void;
	readonly closeTransport: () => void;
	readonly onStart?: () => void;
	readonly onComplete?: (durationMs: number) => void;
	readonly onTimeout?: () => void;
}

export function paradisVisibleWebPScreenshotLogMessage(
	event: 'start' | 'complete',
	transport: 'page' | 'browser',
	durationMs?: number,
): string {
	return `[ParadisCdpGateway] screenshot ${event} route=visible-webp transport=${transport}${event === 'complete' ? ` durationMs=${Math.max(0, Math.round(durationMs ?? 0))}` : ''}`;
}

/** Start the sole raw-CDP screenshot exception and force transport cancellation on timeout. */
export function paradisStartVisibleWebPCapture(
	coordinator: ParadisRawScreenshotCoordinator,
	owner: object,
	request: IParadisCaptureScreenshotRequest,
	callbacks: IParadisVisibleWebPCaptureCallbacks,
): boolean {
	const started = coordinator.begin(owner, request, {
		onComplete: callbacks.onComplete,
		onTimeout: timedOutRequest => {
			try {
				callbacks.respond(screenshotResponse(timedOutRequest, { error: { code: -32000, message: `PARA_BROWSER_RETRYABLE: visible WebP capture timed out after ${coordinator.timeoutMilliseconds}ms; reconnect and retry.` } }));
			} catch { /* closing transport */ }
			try {
				callbacks.onTimeout?.();
			} finally {
				callbacks.closeTransport();
			}
		},
	});
	if (!started) {
		callbacks.respond(screenshotResponse(request, { error: { code: -32000, message: 'PARA_BROWSER_RETRYABLE: another visible WebP capture is still in progress for this Para Code pane.' } }));
	} else {
		try { callbacks.onStart?.(); } catch { /* diagnostics must not affect transport */ }
	}
	return started;
}

function screenshotError(request: IParadisCaptureScreenshotRequest, message: string): IParadisCaptureScreenshotResolution {
	return { kind: 'respond', response: screenshotResponse(request, { error: { code: -32000, message } }) };
}

export function paradisClassifyCaptureScreenshotParams(params: Record<string, unknown> | undefined): IParadisCaptureScreenshotParameterPolicy {
	const p = (params ?? {}) as {
		format?: unknown;
		quality?: unknown;
		clip?: unknown;
		fromSurface?: unknown;
		captureBeyondViewport?: unknown;
	};
	// CDPのformat既定は'png'（upstream実装の既定は'jpeg'なので明示的に埋める）
	let format: 'jpeg' | 'png' = 'png';
	if (p.format === 'jpeg' || p.format === 'png') {
		format = p.format;
	}
	if (p.fromSurface === false) {
		return { kind: 'reject', reason: 'Page.captureScreenshot with fromSurface: false is not supported for a Para Code embedded browser. Use the default surface capture.' };
	}
	if (p.format !== undefined && p.format !== 'jpeg' && p.format !== 'png' && p.format !== 'webp') {
		return { kind: 'reject', reason: `Page.captureScreenshot format ${String(p.format)} is not supported by the Para Code embedded browser.` };
	}
	if (p.quality !== undefined && (typeof p.quality !== 'number' || !Number.isInteger(p.quality) || p.quality < 0 || p.quality > 100)) {
		return { kind: 'reject', reason: 'Page.captureScreenshot quality must be an integer between 0 and 100.' };
	}
	const beyondViewport = p.captureBeyondViewport === true;
	if (p.clip !== undefined) {
		if (typeof p.clip !== 'object' || p.clip === null || Array.isArray(p.clip)) {
			return { kind: 'reject', reason: 'Page.captureScreenshot clip must be an object.' };
		}
		const { x, y, width, height, scale } = p.clip as { x?: unknown; y?: unknown; width?: unknown; height?: unknown; scale?: unknown };
		if (![x, y, width, height].every(value => typeof value === 'number' && Number.isFinite(value))) {
			return { kind: 'reject', reason: 'Page.captureScreenshot clip must contain finite numeric x, y, width, and height values.' };
		}
		if ((width as number) <= 0 || (height as number) <= 0) {
			return { kind: 'reject', reason: 'Page.captureScreenshot clip width and height must be greater than zero.' };
		}
		if ((width as number) > MAX_DELEGATED_CLIP_EDGE || (height as number) > MAX_DELEGATED_CLIP_EDGE || (width as number) * (height as number) > MAX_DELEGATED_CLIP_PIXELS) {
			return { kind: 'reject', reason: 'Page.captureScreenshot clip is too large for a Para Code embedded browser capture.' };
		}
		if (scale !== undefined && scale !== 1) {
			return { kind: 'reject', reason: 'Page.captureScreenshot clip.scale must be 1 for a Para Code embedded browser.' };
		}
	}
	if (p.format === 'webp') {
		return { kind: 'raw-webp' };
	}
	const quality = typeof p.quality === 'number' ? p.quality : undefined;
	if (p.clip !== undefined) {
		const { x, y, width, height } = p.clip as { x: number; y: number; width: number; height: number };
		return {
			kind: 'delegate',
			options: {
				format,
				...(quality !== undefined ? { quality } : {}),
				pageRect: { x, y, width, height },
				...(beyondViewport ? { captureBeyondViewport: true } : {}),
			},
		};
	}
	return {
		kind: 'delegate',
		options: {
			format,
			...(quality !== undefined ? { quality } : {}),
			...(beyondViewport ? { fullPage: true } : {}),
		},
	};
}

export function paradisMapCaptureScreenshotParams(params: Record<string, unknown> | undefined): IParadisCdpScreenshotOptions | undefined {
	const policy = paradisClassifyCaptureScreenshotParams(params);
	return policy.kind === 'delegate' ? policy.options : undefined;
}

function retryableScreenshotMessage(error: unknown, fallback: string): string {
	if (error instanceof Error) {
		if (error.message.startsWith('PARA_BROWSER_RETRYABLE:') || error.message.startsWith(BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX)) {
			return error.message;
		}
	}
	return `PARA_BROWSER_RETRYABLE: ${fallback}`;
}

export async function paradisResolveCaptureScreenshotRequest(
	request: IParadisCaptureScreenshotRequest,
	ctx: IParadisBoundContext,
): Promise<IParadisCaptureScreenshotResolution> {
	const policy = paradisClassifyCaptureScreenshotParams(request.params);
	if (policy.kind === 'reject') {
		return screenshotError(request, policy.reason);
	}
	if (policy.kind === 'raw-webp') {
		try {
			if (await ctx.isBoundPageVisible()) {
				return { kind: 'forward' };
			}
			return screenshotError(request, 'WebP screenshots are unavailable while the Para Code embedded browser is hidden. Request PNG or JPEG instead.');
		} catch (error) {
			return screenshotError(request, retryableScreenshotMessage(error, 'the bound page changed while checking WebP visibility; retry the screenshot.'));
		}
	}
	try {
		const data = await ctx.captureBoundPageScreenshot(policy.options);
		if (typeof data !== 'string' || data.length === 0) {
			return screenshotError(request, 'PARA_BROWSER_RETRYABLE: delegated BrowserView capture returned no image; retry the screenshot.');
		}
		return { kind: 'respond', response: screenshotResponse(request, { result: { data } }) };
	} catch (error) {
		return screenshotError(request, retryableScreenshotMessage(error, 'delegated BrowserView capture failed; retry the screenshot.'));
	}
}

export interface IParadisCaptureScreenshotDispatch {
	readonly isActive: () => boolean;
	readonly forward: (request: IParadisCaptureScreenshotRequest) => void;
	readonly respond: (response: IParadisCaptureScreenshotResponse) => void;
}

/** Resolve one screenshot request and settle it exactly once while its connection is active. */
export async function paradisDispatchCaptureScreenshotRequest(
	request: IParadisCaptureScreenshotRequest,
	ctx: IParadisBoundContext,
	dispatch: IParadisCaptureScreenshotDispatch,
): Promise<void> {
	const resolution = await paradisResolveCaptureScreenshotRequest(request, ctx);
	let active = false;
	try {
		active = dispatch.isActive();
	} catch {
		return;
	}
	if (!active) {
		return;
	}
	try {
		if (resolution.kind === 'forward') {
			dispatch.forward(request);
		} else {
			dispatch.respond(resolution.response);
		}
	} catch {
		// The WebSocket may close between the active check and synchronous send.
	}
}

function targetIdOf(obj: unknown): string | undefined {
	if (typeof obj !== 'object' || obj === null) {
		return undefined;
	}
	const t = (obj as { targetId?: unknown }).targetId;
	return boundedIdentifier(t);
}

type ITargetInfoLike = { type?: string } & Record<string, unknown>;

/** Electronの`webview`型ターゲットをpuppeteer互換の`page`に書き換える。 */
function rewriteTargetInfoType(info: ITargetInfoLike | undefined): ITargetInfoLike | undefined {
	if (info && info.type === 'webview') {
		return { ...info, type: 'page' };
	}
	return info;
}

/**
 * ページレベルCDP接続の透過プロキシ。
 * 上流WSがOPENになる前にクライアントが送ったフレームはバッファして送出する
 * （CDPクライアントはハンドシェイク直後に初期化コマンドを撃つため、落とすとハングする）。
 * client→upstream方向のみ、常時拒否メソッド（Page.close / Storage消去系等）の
 * denylist判定を行う（それ以外は生フレームのまま素通し。upstream→client方向は
 * スクショ等の大きなペイロードが流れるため一切パースしない）。
 */
export function paradisProxyPageUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	ws: IParadisWsModule,
	wss: wsTypes.WebSocketServer,
	upstreamPort: number,
	targetId: string,
	ctx: IParadisBoundContext,
	logService: ILogService,
): void {
	wss.handleUpgrade(req, socket, head, clientWs => {
		const upstream = paradisRegisterPageUpgrade(targetId, clientWs, ctx, () => new ws.WebSocket(`ws://127.0.0.1:${upstreamPort}/devtools/page/${targetId}`, { maxPayload: MAX_CDP_SCREENSHOT_FRAME_BYTES }));
		if (!upstream) {
			return;
		}
		let closed = false;
		let resolveConnectionClosed!: () => void;
		const connectionClosed = new Promise<void>(resolve => resolveConnectionClosed = resolve);
		let pendingBytes = 0;
		let scheduledClientMessages = 0;
		let scheduledClientBytes = 0;
		let clientCommandTail: Promise<void> | undefined;
		const forwardedRequestBarriers = new Map<number, IParadisForwardedRequestBarrier>();
		const rawScreenshots = ctx.rawScreenshotCoordinator;
		const rawScreenshotOwner = {};
		const closeBoth = () => {
			if (closed) {
				return;
			}
			closed = true;
			resolveConnectionClosed();
			ctx.closeInputConnection();
			pending.length = 0;
			pendingBytes = 0;
			clearForwardedRequestBarriers(forwardedRequestBarriers);
			rawScreenshots.markClosing(rawScreenshotOwner);
			try { clientWs.close(); } catch { /* ignore */ }
			if (paradisForceCloseRawScreenshotUpstream(upstream, ws.WebSocket.OPEN, ws.WebSocket.CLOSED)) {
				rawScreenshots.release(rawScreenshotOwner);
			}
		};
		const pending: wsTypes.RawData[] = [];
		const sendToUpstream = (data: wsTypes.RawData) => {
			if (closed) {
				return;
			}
			if (!ctx.isCurrentLease() || !ctx.boundTargetIds().has(targetId)) {
				closeBoth();
				return;
			}
			if (upstream.readyState === ws.WebSocket.OPEN) {
				if (!sendWithBoundedBackpressure(upstream, data, false, true)) {
					closeBoth();
				}
			} else if (upstream.readyState === ws.WebSocket.CONNECTING) {
				const bytes = rawDataByteLength(data);
				if (bytes > MAX_CDP_FRAME_BYTES || pending.length >= MAX_CDP_PENDING_REQUESTS || pendingBytes + bytes > MAX_CDP_CONNECTING_QUEUE_BYTES) {
					closeBoth();
					return;
				}
				pending.push(data);
				pendingBytes += bytes;
			}
		};
		const sendToClient = (response: unknown) => {
			if (!ctx.isCurrentLease()) {
				closeBoth();
				return;
			}
			if (!closed && clientWs.readyState === ws.WebSocket.OPEN) {
				const serialized = JSON.stringify(response);
				if (!sendWithBoundedBackpressure(clientWs, serialized, Buffer.byteLength(serialized, 'utf8') > MAX_CDP_FRAME_BYTES)) {
					closeBoth();
				}
			}
		};
		const dispatchInputAfterPriorRequests = async (msg: IParadisClientCommand, paramsJson: string): Promise<void> => {
			const barrier = await waitForPriorForwardedRequests(
				[...forwardedRequestBarriers.values()].map(entry => entry.settled),
				connectionClosed,
			);
			if (barrier !== 'ready' || closed || !ctx.isCurrentLease() || !ctx.boundTargetIds().has(targetId)) {
				if (barrier === 'timeout' && !closed && ctx.isCurrentLease() && ctx.boundTargetIds().has(targetId)) {
					sendToClient({
						id: msg.id,
						...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
						error: { code: -32000, message: 'PARA_BROWSER_RETRYABLE: prior CDP request did not complete before the input barrier timeout' },
					});
				}
				return;
			}
			const operation = ctx.dispatchBoundPageInput(
				targetId,
				msg.method,
				paramsJson,
				() => !closed && ctx.boundTargetIds().has(targetId),
			);
			void operation.response.then(result => {
				if (closed || !ctx.isCurrentLease() || !ctx.boundTargetIds().has(targetId)) {
					return;
				}
				sendToClient(result.status === 'success'
					? { id: msg.id, ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}), result: result.result }
					: { id: msg.id, ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}), error: { code: -32000, message: result.message } });
			}, closeBoth);
			await Promise.race([operation.drained, connectionClosed]);
		};
		const processClientMessage = (data: wsTypes.RawData): Promise<void> | undefined => {
			if (!ctx.isCurrentLease() || !ctx.boundTargetIds().has(targetId)) {
				closeBoth();
				return;
			}
			const msg = parseClientCommand(data);
			if (!msg) {
				closeBoth();
				return;
			}
			// 常時拒否メソッドはページレベル接続でも遮断する（Page.close等は共有ビューを破壊する）
			const denied = ALWAYS_DENIED_METHODS.get(msg.method)
				?? sharedStateDeniedMessage(msg.method)
				?? (msg.method.startsWith('Target.') ? `${msg.method} is not permitted on a page-scoped CDP connection.` : undefined)
				?? (LAYOUT_MANAGED_DENIED_METHODS.has(msg.method) ? `${msg.method} is not supported: ${LAYOUT_MANAGED_DENIED_MESSAGE}` : undefined);
			if (denied !== undefined) {
				if (clientWs.readyState === ws.WebSocket.OPEN) {
					const serialized = JSON.stringify({ id: msg.id, ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}), error: { code: -32000, message: denied } });
					if (!sendWithBoundedBackpressure(clientWs, serialized)) {
						closeBoth();
					}
				}
				return;
			}
			if (msg.method.startsWith('Input.')) {
				let paramsJson: string;
				try {
					paramsJson = JSON.stringify(msg.params ?? {});
				} catch {
					sendToClient({ id: msg.id, ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}), error: { code: -32000, message: `PARA_BROWSER_RETRYABLE: ${msg.method} parameters could not be serialized` } });
					return;
				}
				return dispatchInputAfterPriorRequests(msg, paramsJson);
			}
			if (msg.method === 'Page.captureScreenshot') {
				void paradisDispatchCaptureScreenshotRequest(
					{ id: msg.id, sessionId: msg.sessionId, params: msg.params },
					ctx,
					{
						isActive: () => !closed && ctx.isCurrentLease() && clientWs.readyState === ws.WebSocket.OPEN && ctx.boundTargetIds().has(targetId),
						forward: request => {
							if (!paradisStartVisibleWebPCapture(rawScreenshots, rawScreenshotOwner, request, {
								respond: sendToClient,
								closeTransport: closeBoth,
								onStart: () => logNonThrowing(logService, 'trace', paradisVisibleWebPScreenshotLogMessage('start', 'page')),
								onComplete: durationMs => logNonThrowing(logService, 'trace', paradisVisibleWebPScreenshotLogMessage('complete', 'page', durationMs)),
								onTimeout: () => logNonThrowing(logService, 'warn', '[ParadisCdpGateway] page visible WebP capture timed out; closing CDP connection'),
							})) {
								return;
							}
							if (!registerForwardedRequestBarrier(forwardedRequestBarriers, request.id, request.sessionId)) {
								closeBoth();
								return;
							}
							sendToUpstream(data);
						},
						respond: sendToClient,
					},
				);
				return;
			}
			if (!registerForwardedRequestBarrier(forwardedRequestBarriers, msg.id, msg.sessionId)) {
				closeBoth();
				return;
			}
			sendToUpstream(data);
			return undefined;
		};
		clientWs.on('message', data => {
			const bytes = rawDataByteLength(data);
			if (closed
				|| bytes > MAX_CDP_FRAME_BYTES
				|| scheduledClientMessages >= MAX_CDP_PENDING_REQUESTS
				|| scheduledClientBytes + bytes > MAX_CDP_CONNECTING_QUEUE_BYTES) {
				closeBoth();
				return;
			}
			const previous = clientCommandTail;
			if (!previous) {
				try {
					const wait = processClientMessage(data);
					if (wait) {
						const guarded = wait.catch(closeBoth);
						clientCommandTail = guarded;
						void guarded.finally(() => {
							if (clientCommandTail === guarded) {
								clientCommandTail = undefined;
							}
						});
					}
				} catch {
					closeBoth();
				}
				return;
			}
			scheduledClientMessages++;
			scheduledClientBytes += bytes;
			const next = previous
				.then(() => processClientMessage(data))
				.catch(closeBoth)
				.finally(() => {
					scheduledClientMessages = Math.max(0, scheduledClientMessages - 1);
					scheduledClientBytes = Math.max(0, scheduledClientBytes - bytes);
				});
			clientCommandTail = next;
			void next.finally(() => {
				if (clientCommandTail === next) {
					clientCommandTail = undefined;
				}
			});
		});
		upstream.on('open', () => {
			if (closed || !ctx.isCurrentLease() || !ctx.boundTargetIds().has(targetId)) {
				closeBoth();
				try { upstream.close(); } catch { /* ignore */ }
				return;
			}
			for (const buf of pending) {
				if (!sendWithBoundedBackpressure(upstream, buf, false, true)) { closeBoth(); break; }
			}
			pending.length = 0;
			pendingBytes = 0;
			upstream.on('message', data => {
				if (!ctx.isCurrentLease() || !ctx.boundTargetIds().has(targetId)) {
					closeBoth();
					return;
				}
				const frameBytes = rawDataByteLength(data);
				const rawScreenshotActive = rawScreenshots.hasActiveRequestForOwner(rawScreenshotOwner);
				if (frameBytes > (rawScreenshotActive ? MAX_CDP_SCREENSHOT_FRAME_BYTES : MAX_CDP_FRAME_BYTES)) {
					closeBoth();
					return;
				}
				const response = parseJsonRecord(data, rawScreenshotActive ? MAX_CDP_SCREENSHOT_FRAME_BYTES : MAX_CDP_FRAME_BYTES);
				if (typeof response?.id === 'number' && Number.isSafeInteger(response.id)) {
					completeForwardedRequestBarrier(forwardedRequestBarriers, response.id, response.sessionId);
				}
				if (rawScreenshotActive) {
					let msg: IJsonRpcMsg | undefined;
					try { msg = JSON.parse(rawDataText(data)) as IJsonRpcMsg; } catch { /* non-JSON frame */ }
					const completion = rawScreenshots.complete(rawScreenshotOwner, msg?.id, msg?.sessionId);
					if (frameBytes > MAX_CDP_FRAME_BYTES && !completion.handled) {
						closeBoth();
						return;
					}
					if (completion.handled && completion.suppress) {
						return;
					}
				}
				if (clientWs.readyState === ws.WebSocket.OPEN) {
					if (!sendWithBoundedBackpressure(clientWs, data, frameBytes > MAX_CDP_FRAME_BYTES, true)) {
						closeBoth();
					}
				}
			});
		});
		upstream.on('error', () => {
			closeBoth();
			logNonThrowing(logService, 'debug', '[ParadisCdpGateway] page upstream transport failed');
		});
		upstream.on('close', () => {
			rawScreenshots.release(rawScreenshotOwner);
			closeBoth();
		});
		clientWs.on('error', closeBoth);
		clientWs.on('close', closeBoth);
	});
}

/**
 * ブラウザレベルCDP接続のフィルタリングプロキシ。
 * バインド済みセット＋その子孫（openerId / attachedToTarget経由で推移的に許可）だけを
 * クライアントに見せる。
 */
export async function paradisProxyBrowserUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	ws: IParadisWsModule,
	wss: wsTypes.WebSocketServer,
	upstreamPort: number,
	upstreamBrowserWsUrl: string,
	ctx: IParadisBoundContext,
	logService: ILogService,
): Promise<void> {
	wss.handleUpgrade(req, socket, head, clientWs => {
		if (!ctx.isCurrentLease()) {
			try { clientWs.close(1000, 'para-code: browser binding changed, reconnect'); } catch { /* ignore */ }
			return;
		}
		ctx.onOpen(clientWs);
		if (!ctx.isCurrentLease()) {
			try { clientWs.close(1000, 'para-code: browser binding changed, reconnect'); } catch { /* ignore */ }
			return;
		}

		const upstream = new ws.WebSocket(upstreamBrowserWsUrl, { maxPayload: MAX_CDP_SCREENSHOT_FRAME_BYTES });
		const rawScreenshots = ctx.rawScreenshotCoordinator;
		const rawScreenshotOwner = {};
		const pendingRequests = new Map<number, IParadisPendingRequest>();
		const internalPending = new Map<number, IParadisPendingRequest>();
		const forwardedRequestBarriers = new Map<number, IParadisForwardedRequestBarrier>();
		let pendingPolicyBytes = 0;
		const pendingUpstream: string[] = [];
		let pendingUpstreamBytes = 0;
		const allowedSessionIds = new Set<string>();
		const sessionIdToTargetId = new Map<string, string>();
		const allowedTargetIds = new Set<string>();
		const childToParent = new Map<string, string>();
		let internalRequestSequence = 0;
		let closed = false;
		let resolveConnectionClosed!: () => void;
		const connectionClosed = new Promise<void>(resolve => resolveConnectionClosed = resolve);
		let scheduledClientMessages = 0;
		let scheduledClientBytes = 0;
		let clientCommandTail: Promise<void> | undefined;

		const addAllowedTarget = (targetId: string, openerId?: string): boolean => {
			if (boundedIdentifier(targetId) === undefined || (openerId !== undefined && boundedIdentifier(openerId) === undefined)) {
				closeBoth();
				return false;
			}
			if (!allowedTargetIds.has(targetId) && allowedTargetIds.size >= MAX_CDP_ROUTING_ENTRIES) {
				closeBoth();
				return false;
			}
			if (openerId !== undefined && !childToParent.has(targetId) && childToParent.size >= MAX_CDP_ROUTING_ENTRIES) {
				closeBoth();
				return false;
			}
			allowedTargetIds.add(targetId);
			if (openerId !== undefined) {
				childToParent.set(targetId, openerId);
			}
			return true;
		};
		const addAllowedSession = (sessionId: string, targetId: string): boolean => {
			if (boundedIdentifier(sessionId) === undefined || boundedIdentifier(targetId) === undefined
				|| (!allowedSessionIds.has(sessionId) && allowedSessionIds.size >= MAX_CDP_ROUTING_ENTRIES)
				|| (!sessionIdToTargetId.has(sessionId) && sessionIdToTargetId.size >= MAX_CDP_ROUTING_ENTRIES)) {
				closeBoth();
				return false;
			}
			allowedSessionIds.add(sessionId);
			sessionIdToTargetId.set(sessionId, targetId);
			return true;
		};
		const refreshBound = (): boolean => {
			for (const targetId of ctx.boundTargetIds()) {
				if (!addAllowedTarget(targetId)) {
					return false;
				}
			}
			return true;
		};
		const isAllowedTarget = (info: { targetId?: string; openerId?: string } | undefined, fallbackTargetId?: string): boolean => {
			if (!refreshBound()) {
				return false;
			}
			const targetId = info?.targetId ?? fallbackTargetId;
			if (!targetId) {
				return false;
			}
			if (allowedTargetIds.has(targetId)) {
				return true;
			}
			const openerId = info?.openerId;
			if (openerId && allowedTargetIds.has(openerId)) {
				return addAllowedTarget(targetId, openerId);
			}
			return false;
		};
		const dropTarget = (targetId: string | undefined) => {
			if (!targetId) {
				return;
			}
			const queue = [targetId];
			const visited = new Set<string>();
			while (queue.length > 0) {
				const current = queue.shift() as string;
				if (visited.has(current)) {
					continue;
				}
				visited.add(current);
				allowedTargetIds.delete(current);
				for (const [child, parent] of childToParent) {
					if (parent === current && !visited.has(child)) {
						queue.push(child);
					}
				}
				childToParent.delete(current);
			}
			for (const [child, parent] of [...childToParent]) {
				if (visited.has(parent)) {
					childToParent.delete(child);
				}
			}
			for (const [sessionId, mappedTargetId] of [...sessionIdToTargetId]) {
				if (visited.has(mappedTargetId)) {
					allowedSessionIds.delete(sessionId);
					sessionIdToTargetId.delete(sessionId);
				}
			}
		};

		const closeBoth = () => {
			if (closed) {
				return;
			}
			closed = true;
			resolveConnectionClosed();
			ctx.closeInputConnection();
			pendingRequests.clear();
			internalPending.clear();
			clearForwardedRequestBarriers(forwardedRequestBarriers);
			pendingPolicyBytes = 0;
			pendingUpstream.length = 0;
			pendingUpstreamBytes = 0;
			allowedSessionIds.clear();
			sessionIdToTargetId.clear();
			allowedTargetIds.clear();
			childToParent.clear();
			rawScreenshots.markClosing(rawScreenshotOwner);
			try { clientWs.close(); } catch { /* ignore */ }
			if (paradisForceCloseRawScreenshotUpstream(upstream, ws.WebSocket.OPEN, ws.WebSocket.CLOSED)) {
				rawScreenshots.release(rawScreenshotOwner);
			}
		};
		const sendToClient = (message: unknown) => {
			if (!ctx.isCurrentLease()) {
				closeBoth();
				return;
			}
			if (!closed && clientWs.readyState === ws.WebSocket.OPEN) {
				let serialized: string;
				try { serialized = JSON.stringify(message); } catch { closeBoth(); return; }
				if (!sendWithBoundedBackpressure(clientWs, serialized, Buffer.byteLength(serialized, 'utf8') > MAX_CDP_FRAME_BYTES)) {
					closeBoth();
				}
			}
		};
		const sendToUpstream = (message: unknown): boolean => {
			if (closed) {
				return false;
			}
			if (!ctx.isCurrentLease()) {
				closeBoth();
				return false;
			}
			let serialized: string;
			try {
				serialized = JSON.stringify(message);
			} catch {
				closeBoth();
				return false;
			}
			const bytes = Buffer.byteLength(serialized, 'utf8');
			if (bytes > MAX_CDP_FRAME_BYTES) {
				closeBoth();
				return false;
			}
			if (upstream.readyState === ws.WebSocket.CONNECTING) {
				if (pendingUpstream.length >= MAX_CDP_PENDING_REQUESTS || pendingUpstreamBytes + bytes > MAX_CDP_CONNECTING_QUEUE_BYTES) {
					closeBoth();
					return false;
				}
				pendingUpstream.push(serialized);
				pendingUpstreamBytes += bytes;
				return true;
			}
			if (upstream.readyState !== ws.WebSocket.OPEN) {
				closeBoth();
				return false;
			}
			try {
				if (sendWithBoundedBackpressure(upstream, serialized)) {
					return true;
				}
				closeBoth();
				return false;
			} catch {
				closeBoth();
				return false;
			}
		};
		const pendingRecord = (method: string, sessionId: string | undefined, targetId: string | undefined): IParadisPendingRequest => {
			const byteLength = Buffer.byteLength(method, 'utf8')
				+ (sessionId === undefined ? 0 : Buffer.byteLength(sessionId, 'utf8'))
				+ (targetId === undefined ? 0 : Buffer.byteLength(targetId, 'utf8'))
				+ 32;
			return Object.freeze({ method, sessionId, targetId, byteLength });
		};
		const registerClientRequest = (message: IParadisClientCommand, targetId?: string): boolean => {
			const record = pendingRecord(message.method, message.sessionId, targetId);
			if (pendingRequests.has(message.id)
				|| pendingRequests.size >= MAX_CDP_PENDING_REQUESTS
				|| pendingPolicyBytes + record.byteLength > MAX_CDP_PENDING_POLICY_BYTES) {
				closeBoth();
				return false;
			}
			pendingRequests.set(message.id, record);
			pendingPolicyBytes += record.byteLength;
			return true;
		};
		const forwardClientRequest = (message: IParadisClientCommand, targetId?: string, rewrittenMessage: unknown = message): boolean => {
			if (!registerClientRequest(message, targetId)) {
				return false;
			}
			if (!registerForwardedRequestBarrier(forwardedRequestBarriers, message.id, message.sessionId)) {
				closeBoth();
				return false;
			}
			if (!sendToUpstream(rewrittenMessage)) {
				completeForwardedRequestBarrier(forwardedRequestBarriers, message.id, message.sessionId);
				return false;
			}
			return true;
		};
		const completeLocalRequest = (id: number, sessionId: string | undefined, response: unknown) => {
			const pending = pendingRequests.get(id);
			if (!pending || pending.sessionId !== sessionId) {
				closeBoth();
				return;
			}
			pendingRequests.delete(id);
			pendingPolicyBytes = Math.max(0, pendingPolicyBytes - pending.byteLength);
			sendToClient(response);
		};
		const rejectRequest = (message: Pick<IParadisClientCommand, 'id' | 'sessionId'>, reason: string) => {
			sendToClient({ id: message.id, ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: reason } });
		};
		const dispatchInputAfterPriorRequests = async (
			message: IParadisClientCommand,
			sessionTargetId: string,
			paramsJson: string,
			isRouteCurrent: () => boolean,
		): Promise<void> => {
			const barrier = await waitForPriorForwardedRequests(
				[...forwardedRequestBarriers.values()].map(entry => entry.settled),
				connectionClosed,
			);
			if (barrier !== 'ready' || closed || !ctx.isCurrentLease() || !isRouteCurrent()) {
				if (barrier === 'timeout' && !closed && ctx.isCurrentLease() && isRouteCurrent()) {
					rejectRequest(message, 'PARA_BROWSER_RETRYABLE: prior CDP request did not complete before the input barrier timeout');
				}
				return;
			}
			if (!registerClientRequest(message, sessionTargetId)) {
				return;
			}
			const requestSessionId = message.sessionId;
			const operation = ctx.dispatchBoundPageInput(sessionTargetId, message.method, paramsJson, isRouteCurrent);
			void operation.response.then(result => {
				if (closed || pendingRequests.get(message.id)?.sessionId !== requestSessionId) {
					return;
				}
				completeLocalRequest(message.id, requestSessionId, result.status === 'success'
					? { id: message.id, sessionId: requestSessionId, result: result.result }
					: { id: message.id, sessionId: requestSessionId, error: { code: -32000, message: result.message } });
			}, closeBoth);
			await Promise.race([operation.drained, connectionClosed]);
		};
		const sendInternal = (method: string, params: Record<string, unknown>, sessionId?: string, targetId?: string): number | undefined => {
			const record = pendingRecord(method, sessionId, targetId);
			if (internalPending.size >= MAX_CDP_PENDING_REQUESTS
				|| pendingPolicyBytes + record.byteLength > MAX_CDP_PENDING_POLICY_BYTES
				|| internalRequestSequence >= Number.MAX_SAFE_INTEGER) {
				closeBoth();
				return undefined;
			}
			const id = -(++internalRequestSequence);
			internalPending.set(id, record);
			pendingPolicyBytes += record.byteLength;
			if (!sendToUpstream({ id, method, params, ...(sessionId !== undefined ? { sessionId } : {}) })) {
				return undefined;
			}
			return id;
		};

		upstream.on('open', () => {
			if (closed || !ctx.isCurrentLease()) {
				closeBoth();
				try { upstream.close(); } catch { /* ignore */ }
				return;
			}
			for (const message of pendingUpstream) {
				if (!sendWithBoundedBackpressure(upstream, message)) {
					closeBoth();
					break;
				}
			}
			pendingUpstream.length = 0;
			pendingUpstreamBytes = 0;
		});

		const processClientMessage = (data: wsTypes.RawData): Promise<void> | undefined => {
			if (!ctx.isCurrentLease()) {
				closeBoth();
				return;
			}
			const message = parseClientCommand(data);
			if (!message) {
				closeBoth();
				return;
			}
			if (pendingRequests.has(message.id)) {
				closeBoth();
				return;
			}

			const alwaysDenied = ALWAYS_DENIED_METHODS.get(message.method);
			if (alwaysDenied !== undefined) {
				rejectRequest(message, alwaysDenied);
				return;
			}
			if (LAYOUT_MANAGED_DENIED_METHODS.has(message.method)) {
				rejectRequest(message, `${message.method} is not supported: ${LAYOUT_MANAGED_DENIED_MESSAGE}`);
				return;
			}

			if (message.sessionId !== undefined) {
				if (!allowedSessionIds.has(message.sessionId)) {
					rejectRequest(message, 'The supplied CDP sessionId is not authorized for this Para Code pane binding.');
					return;
				}
				if (message.method.startsWith('Target.') && !BROWSER_SESSION_ALLOWED_TARGET_METHODS.has(message.method)) {
					rejectRequest(message, `${message.method} is not permitted on a target-scoped CDP session.`);
					return;
				}
				const sharedStateDenied = sharedStateDeniedMessage(message.method);
				if (sharedStateDenied !== undefined) {
					rejectRequest(message, sharedStateDenied);
					return;
				}
				const referencedTargetId = targetIdOf(message.params);
				const referencedSessionId = boundedIdentifier(message.params?.sessionId);
				if ((referencedTargetId && !allowedTargetIds.has(referencedTargetId)) || (referencedSessionId && !allowedSessionIds.has(referencedSessionId))) {
					rejectRequest(message, `${message.method} references a target or session outside this Para Code pane binding.`);
					return;
				}
				const sessionTargetId = sessionIdToTargetId.get(message.sessionId);
				const isBoundPrimary = sessionTargetId !== undefined && ctx.boundTargetIds().has(sessionTargetId);
				if (message.method.startsWith('Input.')) {
					if (!isBoundPrimary || sessionTargetId === undefined) {
						rejectRequest(message, `${message.method} is permitted only on the bound primary BrowserView session.`);
						return;
					}
					let paramsJson: string;
					try {
						paramsJson = JSON.stringify(message.params ?? {});
					} catch {
						rejectRequest(message, `PARA_BROWSER_RETRYABLE: ${message.method} parameters could not be serialized`);
						return;
					}
					const requestSessionId = message.sessionId;
					return dispatchInputAfterPriorRequests(
						message,
						sessionTargetId,
						paramsJson,
						() => !closed
							&& allowedSessionIds.has(requestSessionId)
							&& sessionIdToTargetId.get(requestSessionId) === sessionTargetId
							&& ctx.boundTargetIds().has(sessionTargetId),
					);
				}
				if (isBoundPrimary && message.method === 'Page.captureScreenshot') {
					if (!registerClientRequest(message, sessionTargetId)) {
						return;
					}
					const requestSessionId = message.sessionId;
					const requestTargetId = sessionTargetId;
					void paradisDispatchCaptureScreenshotRequest(
						{ id: message.id, sessionId: requestSessionId, params: message.params },
						ctx,
						{
							isActive: () => !closed
								&& pendingRequests.get(message.id)?.sessionId === requestSessionId
								&& ctx.isCurrentLease()
								&& clientWs.readyState === ws.WebSocket.OPEN
								&& sessionIdToTargetId.get(requestSessionId) === requestTargetId
								&& ctx.boundTargetIds().has(requestTargetId),
							forward: request => {
								if (!paradisStartVisibleWebPCapture(rawScreenshots, rawScreenshotOwner, request, {
									respond: response => completeLocalRequest(message.id, requestSessionId, response),
									closeTransport: closeBoth,
									onStart: () => logNonThrowing(logService, 'trace', paradisVisibleWebPScreenshotLogMessage('start', 'browser')),
									onComplete: durationMs => logNonThrowing(logService, 'trace', paradisVisibleWebPScreenshotLogMessage('complete', 'browser', durationMs)),
									onTimeout: () => logNonThrowing(logService, 'warn', '[ParadisCdpGateway] browser visible WebP capture timed out; closing CDP connection'),
								})) {
									return;
								}
								if (!registerForwardedRequestBarrier(forwardedRequestBarriers, message.id, requestSessionId)) {
									closeBoth();
									return;
								}
								sendToUpstream({ ...message, ...request });
							},
							respond: response => completeLocalRequest(message.id, requestSessionId, response),
						},
					);
					return;
				}
				if (message.method === 'Target.setAutoAttach') {
					const rewrittenParams = { ...(message.params ?? {}) };
					delete rewrittenParams.filter;
					forwardClientRequest(message, sessionTargetId, { ...message, params: rewrittenParams });
					return;
				}
				forwardClientRequest(message, sessionTargetId);
				return;
			}

			if (!refreshBound()) {
				return;
			}
			if (!BROWSER_ROOT_ALLOWED_METHODS.has(message.method)) {
				rejectRequest(message, `${message.method} is not permitted on the browser root by the Para Code CDP gateway.`);
				return;
			}
			if (message.method === 'Target.getBrowserContexts') {
				sendToClient({ id: message.id, result: { browserContextIds: [] } });
				return;
			}
			if (message.method === 'Target.setAutoAttach' || message.method === 'Target.setDiscoverTargets') {
				const rewrittenParams = { ...(message.params ?? {}) };
				delete rewrittenParams.filter;
				forwardClientRequest(message, undefined, { ...message, params: rewrittenParams });
				return;
			}
			if (message.method === 'Target.attachToTarget') {
				const targetId = targetIdOf(message.params);
				if (!targetId || !allowedTargetIds.has(targetId)) {
					rejectRequest(message, 'Target.attachToTarget outside the bound scope is refused by the Para Code CDP gateway.');
					return;
				}
				forwardClientRequest(message, targetId);
				return;
			}
			if (message.method === 'Target.getTargetInfo') {
				const targetId = targetIdOf(message.params);
				if (!targetId || !allowedTargetIds.has(targetId)) {
					rejectRequest(message, 'Target.getTargetInfo outside the bound scope is refused by the Para Code CDP gateway.');
					return;
				}
				forwardClientRequest(message, targetId);
				return;
			}
			if (message.method === 'Target.detachFromTarget') {
				const targetId = targetIdOf(message.params);
				const sessionId = boundedIdentifier(message.params?.sessionId);
				if ((!targetId && !sessionId)
					|| (targetId !== undefined && !allowedTargetIds.has(targetId))
					|| (sessionId !== undefined && !allowedSessionIds.has(sessionId))) {
					rejectRequest(message, `${message.method} outside the bound scope is refused by the Para Code CDP gateway.`);
					return;
				}
				forwardClientRequest(message, targetId ?? (sessionId ? sessionIdToTargetId.get(sessionId) : undefined));
				return;
			}
			forwardClientRequest(message);
			return undefined;
		};
		clientWs.on('message', (data: wsTypes.RawData) => {
			const bytes = rawDataByteLength(data);
			if (closed
				|| bytes > MAX_CDP_FRAME_BYTES
				|| scheduledClientMessages >= MAX_CDP_PENDING_REQUESTS
				|| scheduledClientBytes + bytes > MAX_CDP_CONNECTING_QUEUE_BYTES) {
				closeBoth();
				return;
			}
			const previous = clientCommandTail;
			if (!previous) {
				try {
					const wait = processClientMessage(data);
					if (wait) {
						const guarded = wait.catch(closeBoth);
						clientCommandTail = guarded;
						void guarded.finally(() => {
							if (clientCommandTail === guarded) {
								clientCommandTail = undefined;
							}
						});
					}
				} catch {
					closeBoth();
				}
				return;
			}
			scheduledClientMessages++;
			scheduledClientBytes += bytes;
			const next = previous
				.then(() => processClientMessage(data))
				.catch(closeBoth)
				.finally(() => {
					scheduledClientMessages = Math.max(0, scheduledClientMessages - 1);
					scheduledClientBytes = Math.max(0, scheduledClientBytes - bytes);
				});
			clientCommandTail = next;
			void next.finally(() => {
				if (clientCommandTail === next) {
					clientCommandTail = undefined;
				}
			});
		});

		upstream.on('message', (data: wsTypes.RawData) => {
			if (!ctx.isCurrentLease()) {
				closeBoth();
				return;
			}
			const frameBytes = rawDataByteLength(data);
			const rawScreenshotActive = rawScreenshots.hasActiveRequestForOwner(rawScreenshotOwner);
			const message = parseJsonRecord(data, rawScreenshotActive ? MAX_CDP_SCREENSHOT_FRAME_BYTES : MAX_CDP_FRAME_BYTES);
			if (!message
				|| (message.params !== undefined && !isRecord(message.params))
				|| (message.sessionId !== undefined && boundedIdentifier(message.sessionId) === undefined)) {
				closeBoth();
				return;
			}
			if (!refreshBound()) {
				return;
			}

			if (message.id !== undefined) {
				if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) {
					closeBoth();
					return;
				}
				if (message.id < 0) {
					if (frameBytes > MAX_CDP_FRAME_BYTES) {
						closeBoth();
						return;
					}
					const pending = internalPending.get(message.id);
					if (!pending || pending.sessionId !== message.sessionId) {
						closeBoth();
						return;
					}
					internalPending.delete(message.id);
					pendingPolicyBytes = Math.max(0, pendingPolicyBytes - pending.byteLength);
					if (pending.method === 'Target.attachToTarget') {
						const sessionId = boundedIdentifier(message.result?.sessionId);
						if (sessionId && pending.targetId && allowedTargetIds.has(pending.targetId)) {
							addAllowedSession(sessionId, pending.targetId);
						}
					}
					return;
				}

				const pending = pendingRequests.get(message.id);
				if (!pending || pending.sessionId !== message.sessionId) {
					closeBoth();
					return;
				}
				completeForwardedRequestBarrier(forwardedRequestBarriers, message.id, message.sessionId);
				pendingRequests.delete(message.id);
				pendingPolicyBytes = Math.max(0, pendingPolicyBytes - pending.byteLength);
				const rawCompletion = rawScreenshots.complete(rawScreenshotOwner, message.id, message.sessionId);
				if (frameBytes > MAX_CDP_FRAME_BYTES && !rawCompletion.handled) {
					closeBoth();
					return;
				}
				if (rawCompletion.handled && rawCompletion.suppress) {
					return;
				}
				if (pending.method === 'Target.getTargets' && message.result) {
					const infos = Array.isArray(message.result.targetInfos) ? message.result.targetInfos : [];
					const filtered = infos
						.filter(isRecord)
						.filter(info => {
							const targetId = targetIdOf(info);
							return targetId !== undefined && allowedTargetIds.has(targetId);
						})
						.map(info => rewriteTargetInfoType(info));
					sendToClient({ ...message, result: { ...message.result, targetInfos: filtered } });
					return;
				}
				if (pending.method === 'Target.attachToTarget' && message.result) {
					const sessionId = boundedIdentifier(message.result.sessionId);
					if (sessionId && pending.targetId) {
						if (!addAllowedSession(sessionId, pending.targetId)) {
							return;
						}
					}
				}
				if (pending.method === 'Target.getTargetInfo' && message.result?.targetInfo) {
					const targetId = targetIdOf(message.result.targetInfo);
					if (!targetId || targetId !== pending.targetId || !allowedTargetIds.has(targetId)) {
						sendToClient({ id: message.id, error: { code: -32000, message: 'target not found' } });
						return;
					}
					sendToClient({ ...message, result: { ...message.result, targetInfo: rewriteTargetInfoType(message.result.targetInfo as ITargetInfoLike) } });
					return;
				}
				sendToClient(message);
				return;
			}
			if (frameBytes > MAX_CDP_FRAME_BYTES) {
				closeBoth();
				return;
			}

			if (typeof message.method !== 'string' || message.method.length === 0 || message.method.length > MAX_CDP_METHOD_LENGTH) {
				closeBoth();
				return;
			}
			if (message.sessionId !== undefined) {
				if (!allowedSessionIds.has(message.sessionId) || sharedStateDeniedMessage(message.method) !== undefined) {
					return;
				}
				if (message.method === 'Target.attachedToTarget') {
					const params = message.params as { sessionId?: string; targetInfo?: { targetId?: string; openerId?: string } } | undefined;
					const childSessionId = params?.sessionId;
					const childTargetId = params?.targetInfo?.targetId;
					if (childSessionId && childTargetId) {
						if (!addAllowedTarget(childTargetId, params?.targetInfo?.openerId)
							|| !addAllowedSession(childSessionId, childTargetId)) {
							return;
						}
					}
				} else if (message.method === 'Target.detachedFromTarget') {
					const params = message.params as { sessionId?: string; targetId?: string } | undefined;
					const detachedTargetId = (params?.sessionId ? sessionIdToTargetId.get(params.sessionId) : undefined) ?? params?.targetId;
					if (params?.sessionId) {
						allowedSessionIds.delete(params.sessionId);
						sessionIdToTargetId.delete(params.sessionId);
					}
					dropTarget(params?.targetId);
					// 保険: バインド済みtargetのセッションが剥離されたら、イベントを転送した上で接続を閉じる。
					// 子プロセスは次のツール呼び出しでbrowser.connected===falseを検知して再接続し、
					// コンテキストを再構築するので自己回復する。スコープ外targetのdetachには影響させない。
					if (detachedTargetId !== undefined && ctx.boundTargetIds().has(detachedTargetId)) {
						sendToClient(message);
						closeBoth();
						return;
					}
				}
				sendToClient(message);
				return;
			}

			if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') {
				const params = message.params as { targetInfo?: { type?: string; targetId?: string; openerId?: string; attached?: boolean }; targetId?: string } | undefined;
				const info = params?.targetInfo;
				if (!isAllowedTarget(info, params?.targetId)) {
					return;
				}
				const targetId = info?.targetId ?? params?.targetId;
				const type = info?.type;
				if (message.method === 'Target.targetCreated' && targetId && info?.attached !== true
					&& (type === 'page' || type === 'iframe' || type === 'service_worker' || type === 'shared_worker' || type === 'worker' || type === 'prerender' || type === 'webview')) {
					sendInternal('Target.attachToTarget', { targetId, flatten: true }, undefined, targetId);
				}
				sendToClient(info ? { ...message, params: { ...params, targetInfo: rewriteTargetInfoType(info) } } : message);
				return;
			}
			if (message.method === 'Target.targetDestroyed' || message.method === 'Target.targetCrashed') {
				const params = message.params as { targetInfo?: { type?: string; targetId?: string }; targetId?: string } | undefined;
				const targetId = params?.targetInfo?.targetId ?? params?.targetId;
				if (!targetId || !allowedTargetIds.has(targetId)) {
					return;
				}
				dropTarget(targetId);
				sendToClient(params?.targetInfo ? { ...message, params: { ...params, targetInfo: rewriteTargetInfoType(params.targetInfo) } } : message);
				return;
			}
			if (message.method === 'Target.attachedToTarget') {
				const params = message.params as { sessionId?: string; targetInfo?: { type?: string; targetId?: string; openerId?: string } } | undefined;
				if (!isAllowedTarget(params?.targetInfo)) {
					if (params?.sessionId) {
						sendInternal('Runtime.runIfWaitingForDebugger', {}, params.sessionId);
						sendInternal('Target.detachFromTarget', { sessionId: params.sessionId });
					}
					return;
				}
				if (params?.sessionId && params.targetInfo?.targetId) {
					if (!addAllowedSession(params.sessionId, params.targetInfo.targetId)) {
						return;
					}
				}
				sendToClient({ ...message, params: { ...(params ?? {}), targetInfo: rewriteTargetInfoType(params?.targetInfo) } });
				return;
			}
			if (message.method === 'Target.detachedFromTarget') {
				const sessionId = boundedIdentifier(message.params?.sessionId);
				if (!sessionId || !allowedSessionIds.has(sessionId)) {
					return;
				}
				const detachedTargetId = sessionIdToTargetId.get(sessionId);
				allowedSessionIds.delete(sessionId);
				sessionIdToTargetId.delete(sessionId);
				// 保険: バインド済みtargetのセッションが剥離されたら、イベントを転送した上で接続を閉じる。
				// 子プロセスは再接続でコンテキストを再構築するので自己回復する。
				if (detachedTargetId !== undefined && ctx.boundTargetIds().has(detachedTargetId)) {
					sendToClient(message);
					closeBoth();
					return;
				}
				sendToClient(message);
				return;
			}
			if (message.method === 'Target.receivedMessageFromTarget') {
				const targetId = targetIdOf(message.params);
				const sessionId = boundedIdentifier(message.params?.sessionId);
				if ((!targetId && !sessionId) || (targetId && !allowedTargetIds.has(targetId)) || (sessionId && !allowedSessionIds.has(sessionId))) {
					return;
				}
				sendToClient(message);
			}
			// Unknown root events are not part of the browser-root capability surface.
		});

		upstream.on('error', () => {
			closeBoth();
			logNonThrowing(logService, 'debug', '[ParadisCdpGateway] browser upstream transport failed');
		});
		upstream.on('close', () => {
			rawScreenshots.release(rawScreenshotOwner);
			closeBoth();
		});
		clientWs.on('error', closeBoth);
		clientWs.on('close', closeBoth);
	});
}
