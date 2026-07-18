/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDPゲートウェイ（Supersetの cdp-gateway.ts の移植）。
// agent-browser HTTPサーバー（shared process）に相乗りし、chrome-devtools-mcp /
// browser-use等の既存ブラウザ自動化MCPが期待するCDPエンドポイント
// （`/json/*`、`/devtools/browser/<id>`、`/devtools/page/<id>`）を提供する。
// パスは `/cdp` プレフィックス付き・無しの両方を受け付ける
// （puppeteerは `new URL('/json/version', browserURL)` でベースURLのパスを落とすため、
// ルート直下でも同じエンドポイントを提供する必要がある）。
//
// 呼び出し元の識別は接続ごとに行う（paradisCdpPeerResolver.ts参照）:
//   1. URLクエリ `?pane=<token>`（最優先）
//   2. loopbackピアPID → 祖先チェーンのenv / 既知シェルPID表 → ペイントークン
// 解決したトークンをバインディングレジストリと突合し、バインド済みページの
// targetId（とその子孫）だけが見える・触れるようにフィルタする（paradisCdpFilterProxy.ts）。
//
// セキュリティ: 127.0.0.1のみ。puppeteerがAuthorizationヘッダーやクエリを落とすため、
// URL上の固定credentialには依存せず、Para Codeターミナルペインの子孫プロセスであることと、
// そのペインの現行owner lifecycleから得たopaque leaseの両方を要求する。

import { createHash, randomBytes } from 'crypto';
import type * as http from 'http';
import type { Socket } from 'net';
import type { Duplex } from 'stream';
import type * as wsTypes from 'ws';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisCdpScreenshotOptions } from '../common/paradisAgentBrowser.js';
import { IParadisBoundContext, IParadisWsModule, ParadisRawScreenshotAuthorityRegistry, paradisProxyBrowserUpgrade, paradisProxyPageUpgrade } from './paradisCdpFilterProxy.js';
import { paradisResolvePaneTokenForPeerPort } from './paradisCdpPeerResolver.js';
import { ParadisCdpUpstream } from './paradisCdpUpstream.js';
import { IParadisCdpInputQueueOperation } from './paradisCdpInputQueue.js';

/** ゲートウェイがバインディングレジストリ（サービス本体）へ問い合わせるための契約。 */
export interface IParadisCdpGatewayDelegate {
	/** Capture an opaque, point-in-time lease for a currently serviceable pane token. */
	captureIngressLease(token: string): IParadisCdpIngressLease | undefined;
	/** Revalidate an ingress lease without refreshing or replacing its authority. */
	isIngressLeaseCurrent(lease: IParadisCdpIngressLease): boolean;
	/** トークンにバインド済みのページのDevTools targetId（キャッシュ済みなら同期で返る）。 */
	getBoundTargetId(token: string): string | undefined;
	/** 未解決ならelectron-mainへの解決を待って返す。バインド無し/ページ消滅ならundefined。 */
	ensureBoundTargetId(token: string): Promise<string | undefined>;
	/** workbenchから同期された シェルPID → ペイントークン 表の参照。 */
	getTokenForShellPid(pid: number): string | undefined;
	/**
	 * バインド済みページのスクリーンショットをelectron-mainのupstream実装
	 * （BrowserView.captureScreenshot: 非表示時の回避策付き）で撮り、base64を返す。
	 * バインド無し・ビュー消滅・キャプチャ失敗時はretryable errorとしてrejectする。
	 */
	captureBoundPageScreenshot(token: string, options: IParadisCdpScreenshotOptions): Promise<string | undefined>;
	/** Whether the same generation's bound BrowserView is currently visible. */
	isBoundPageVisible(token: string): Promise<boolean>;
	dispatchBoundPageInput(
		token: string,
		connection: object,
		expectedTargetId: string,
		method: string,
		paramsJson: string,
		isConnectionCurrent: () => boolean,
	): IParadisCdpInputQueueOperation;
	closeInputConnection(connection: object): void;
}

/** Opaque service-owned authority captured before any token-local CDP state is touched. */
export interface IParadisCdpIngressLease {
	readonly token: string;
}

function isLoopback(address: string | undefined): boolean {
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 先頭の `/cdp` プレフィックスと末尾スラッシュを正規化したパスを返す。 */
function normalizePath(pathname: string): string {
	let p = pathname;
	if (p === '/cdp' || p.startsWith('/cdp/')) {
		p = p.slice('/cdp'.length) || '/';
	}
	if (p.length > 1 && p.endsWith('/')) {
		p = p.slice(0, -1);
	}
	return p;
}

const JSON_PATHS = new Set(['/json', '/json/list', '/json/version', '/json/protocol']);
const MAX_INGRESS_TOKEN_LENGTH = 200;
const MAX_INGRESS_URL_LENGTH = 4_096;
const MAX_CDP_TARGET_ID_LENGTH = 512;
const MAX_ACTIVE_HTTP_REQUESTS = 32;
const MAX_ACTIVE_WEBSOCKET_UPGRADES = 32;
const MAX_ACTIVE_WEBSOCKETS = 128;
const MAX_ACTIVE_WEBSOCKETS_PER_TOKEN = 8;
const MAX_CLIENT_CDP_FRAME_BYTES = 1024 * 1024;
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const INGRESS_UNAVAILABLE_BODY = Object.freeze({ error: 'Para Browser CDP access is unavailable.' });
const GATEWAY_UNAVAILABLE_BODY = Object.freeze({ error: 'Para Browser CDP gateway is unavailable.' });

interface IParadisCdpIngressAccess {
	readonly token: string;
	readonly lease: IParadisCdpIngressLease;
	/** Present only for access inferred from a peer PID. */
	readonly peerAuthority?: IParadisCdpPeerAuthority;
	readonly peerGeneration?: number;
}

interface IParadisCdpQueryToken {
	readonly present: boolean;
	readonly token?: string;
}

interface IParadisCdpConnectionAuthority {
	generation: number;
}

interface IParadisCdpPeerAuthority {
	generation: number;
}

interface IParadisCdpWebSocketReservation {
	attach(ws: wsTypes.WebSocket): boolean;
	releaseIfUnattached(): void;
}

export function paradisPageUpgradeTargetIsCurrent(
	requestedTargetId: string | undefined,
	resolvedTargetId: string | undefined,
	currentTargetId: string | undefined,
): boolean {
	return requestedTargetId !== undefined && requestedTargetId === resolvedTargetId && resolvedTargetId === currentTargetId;
}

export class ParadisCdpGateway extends Disposable {

	/** TCPソケット単位のトークン解決キャッシュ（正の解決のみメモ化）。 */
	private _socketTokens = new WeakMap<Socket, IParadisCdpIngressAccess>();
	/** トークン別のアクティブWS接続（バインド変更時の強制切断用）。 */
	private readonly _connectionsByToken = new Map<string, Set<wsTypes.WebSocket>>();
	/** Reserved before any upstream WebSocket is opened; includes accepted and closing transports. */
	private readonly _webSocketReservationsByToken = new Map<string, number>();
	private readonly _webSocketReservationReleases = new WeakMap<wsTypes.WebSocket, () => void>();
	private readonly _closingWebSockets = new Set<wsTypes.WebSocket>();
	private readonly _webSocketCloseTimers = new Map<wsTypes.WebSocket, ReturnType<typeof setTimeout>>();
	private _webSocketReservationCount = 0;
	private _activeHttpRequests = 0;
	private _activeWebSocketUpgrades = 0;
	/**
	 * トークン別の接続authority。closeフレームの完了を待たずgenerationを進めることで、
	 * 旧接続から上流CDPへ送られる全コマンドを同期的に失効させる。
	 */
	private readonly _connectionAuthorities = new Map<string, IParadisCdpConnectionAuthority>();
	/** PID-derived socket access authority. Object identity prevents token lifecycle ABA after retirement. */
	private readonly _peerAuthorities = new Map<string, IParadisCdpPeerAuthority>();
	/** /json/version が返すブラウザWS URLのid部分（Chromium風の見た目にするだけの飾り）。 */
	private readonly _browserWsIds = new Map<string, string>();
	/** Token authority shared by every page/browser WebSocket for raw visible WebP capture. */
	private readonly _rawScreenshotAuthorities = new ParadisRawScreenshotAuthorityRegistry();

	private _wsModulePromise: Promise<IParadisWsModule> | undefined;
	private _wss: wsTypes.WebSocketServer | undefined;
	private _disposed = false;
	/** Invalidates PID/env resolutions that span an owner lifecycle change. */
	private _peerResolutionEpoch = 0;

	constructor(
		private readonly delegate: IParadisCdpGatewayDelegate,
		private readonly upstream: ParadisCdpUpstream,
		private readonly logService: ILogService,
		private readonly resolvePaneTokenForPeerPort: typeof paradisResolvePaneTokenForPeerPort = paradisResolvePaneTokenForPeerPort,
	) {
		super();
	}

	// --- ルーティング判定 ---

	isGatewayHttpRequest(req: http.IncomingMessage): boolean {
		if (req.method !== 'GET') {
			return false;
		}
		const pathname = this._pathnameOf(req);
		return pathname !== undefined && JSON_PATHS.has(normalizePath(pathname));
	}

	// --- HTTP（/json/*） ---

	async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const pathname = normalizePath(this._pathnameOf(req) ?? '/');
		let access: IParadisCdpIngressAccess | undefined;
		let requestReserved = false;
		try {
			if (this._disposed) {
				this._sendIngressUnavailable(res);
				return;
			}
			if (!isLoopback(req.socket.remoteAddress)) {
				this._sendJson(res, 403, { error: 'Loopback connections only.' });
				return;
			}
			if (this._activeHttpRequests >= MAX_ACTIVE_HTTP_REQUESTS) {
				this._sendJson(res, 503, GATEWAY_UNAVAILABLE_BODY);
				return;
			}
			this._activeHttpRequests++;
			requestReserved = true;
			access = await this._resolveIngress(req);
			if (!access || !this._isIngressAccessCurrent(access)) {
				this._sendIngressUnavailable(res);
				return;
			}
			if (pathname === '/json/protocol') {
				const body = await this.upstream.fetchJson('/json/protocol');
				if (!this._isIngressAccessCurrent(access)) {
					this._sendIngressUnavailable(res);
					return;
				}
				this._sendJson(res, 200, body);
				return;
			}
			const { token } = access;
			const host = this._trustedLoopbackAuthority(req);
			if (pathname === '/json/version') {
				const body = await this.upstream.fetchJson('/json/version') as Record<string, unknown>;
				if (!this._isIngressAccessCurrent(access)) {
					this._sendIngressUnavailable(res);
					return;
				}
				const browserWsId = this._browserWsIdFor(access);
				if (!browserWsId || !this._isIngressAccessCurrent(access)) {
					this._sendIngressUnavailable(res);
					return;
				}
				const paneQuery = `?pane=${encodeURIComponent(token)}`;
				this._sendJson(res, 200, {
					...body,
					webSocketDebuggerUrl: `ws://${host}/cdp/devtools/browser/${browserWsId}${paneQuery}`,
				});
				return;
			}
			// /json または /json/list
			const targetId = await this.delegate.ensureBoundTargetId(token);
			if (!this._isIngressAccessCurrent(access)) {
				this._sendIngressUnavailable(res);
				return;
			}
			if (!targetId) {
				// Serviceable pane without a binding: the client sees an empty target list.
				this._sendJson(res, 200, []);
				return;
			}
			if (!this._isBoundTargetCurrent(access, targetId)) {
				this._sendIngressUnavailable(res);
				return;
			}
			const raw = await this.upstream.fetchJson('/json/list') as Array<Record<string, unknown>>;
			if (!this._isBoundTargetCurrent(access, targetId)) {
				this._sendIngressUnavailable(res);
				return;
			}
			const paneQuery = `?pane=${encodeURIComponent(token)}`;
			const out = raw
				.filter(t => typeof t.id === 'string' && t.id === targetId)
				.map(t => ({
					...t,
					// Electronは埋め込みビューを `type: "webview"` で公開しうるが、puppeteerの
					// browser.pages() は type==='page' しか数えないため書き換える
					type: t.type === 'webview' ? 'page' : t.type,
					webSocketDebuggerUrl: `ws://${host}/cdp/devtools/page/${targetId}${paneQuery}`,
					devtoolsFrontendUrl: `http://${host}/cdp/devtools/page/${targetId}${paneQuery}`,
				}));
			if (!this._isBoundTargetCurrent(access, targetId)) {
				this._sendIngressUnavailable(res);
				return;
			}
			this._sendJson(res, 200, out);
		} catch {
			this._warnNonThrowing('[ParadisCdpGateway] request failed');
			if (access && !this._isIngressAccessCurrent(access)) {
				this._sendIngressUnavailable(res);
			} else {
				this._sendJson(res, 502, GATEWAY_UNAVAILABLE_BODY);
			}
		} finally {
			if (requestReserved) {
				this._activeHttpRequests = Math.max(0, this._activeHttpRequests - 1);
			}
		}
	}

	// --- WebSocket upgrade（/devtools/*） ---

	async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		let reservation: IParadisCdpWebSocketReservation | undefined;
		let upgradeReserved = false;
		try {
			if (this._disposed) {
				socket.destroy();
				return;
			}
			const pathname = normalizePath(this._pathnameOf(req) ?? '/');
			const browserMatch = pathname.match(new RegExp(`^/devtools/browser/[^/]{1,${MAX_CDP_TARGET_ID_LENGTH}}$`));
			const pageMatch = pathname.match(new RegExp(`^/devtools/page/([^/]{1,${MAX_CDP_TARGET_ID_LENGTH}})$`));
			if (!browserMatch && !pageMatch) {
				socket.destroy();
				return;
			}
			const s = socket as unknown as Socket;
			if (!isLoopback(s.remoteAddress)) {
				socket.destroy();
				return;
			}
			if (this._activeWebSocketUpgrades >= MAX_ACTIVE_WEBSOCKET_UPGRADES) {
				socket.destroy();
				return;
			}
			this._activeWebSocketUpgrades++;
			upgradeReserved = true;
			const access = await this._resolveIngress(req);
			if (!access || !this._isIngressAccessCurrent(access)) {
				socket.destroy();
				return;
			}
			const { token } = access;
			reservation = this._reserveWebSocket(token);
			if (!reservation) {
				socket.destroy();
				return;
			}
			const ws = await this._getWsModule();
			if (!this._isIngressAccessCurrent(access)) {
				socket.destroy();
				return;
			}
			const wss = this._getWss(ws);
			if (this._store.isDisposed || !this._isIngressAccessCurrent(access)) {
				socket.destroy();
				return;
			}
			if (pageMatch) {
				// ページレベル: 要求されたtargetIdがバインド済みセットに含まれる場合のみ許可
				const tid = pageMatch[1];
				const boundTid = await this.delegate.ensureBoundTargetId(token);
				if (!this._isIngressAccessCurrent(access)) {
					socket.destroy();
					return;
				}
				const currentTid = this.delegate.getBoundTargetId(token);
				if (!paradisPageUpgradeTargetIsCurrent(tid, boundTid, currentTid)) {
					socket.destroy();
					return;
				}
				// Capture the binding generation before the health-check await. A restart or
				// rebind during that await must not gain a fresh lease for this stored URL.
				const context = this._makeContext(access, reservation);
				// Stored page URLs can outlive an Electron restart. Health-check through the
				// refresh-aware JSON authority before opening the raw page WebSocket.
				const { port } = await this.upstream.fetchJsonWithPort('/json/version');
				if (!context.isCurrentLease() || this.delegate.getBoundTargetId(token) !== tid) {
					socket.destroy();
					return;
				}
				paradisProxyPageUpgrade(req, socket, head, ws, wss, port, tid, context, this.logService);
				return;
			}

			// Browser-level transport is still pane-authorized even when no page is bound.
			// バインドは boundTargetIds() クロージャ経由で毎回参照されるため、
			// 接続後にバインドされた場合も追加のターゲットが見えるようになる。
			await this.delegate.ensureBoundTargetId(token); // キャッシュを温める（同期クロージャ用）
			if (!this._isIngressAccessCurrent(access)) {
				socket.destroy();
				return;
			}
			// The health check below can refresh the Electron port. Keep it inside the
			// binding generation that requested the upgrade.
			const context = this._makeContext(access, reservation);
			const { value: version, port } = await this.upstream.fetchJsonWithPort<{ webSocketDebuggerUrl?: string }>('/json/version');
			if (!context.isCurrentLease()
				|| typeof version.webSocketDebuggerUrl !== 'string'
				|| version.webSocketDebuggerUrl.length > MAX_INGRESS_URL_LENGTH) {
				socket.destroy();
				return;
			}
			const upstreamUrl = new URL(version.webSocketDebuggerUrl);
			if (upstreamUrl.protocol !== 'ws:' || !new RegExp(`^/devtools/browser/[^/]{1,${MAX_CDP_TARGET_ID_LENGTH}}$`).test(upstreamUrl.pathname)) {
				socket.destroy();
				return;
			}
			upstreamUrl.host = `127.0.0.1:${port}`;
			await paradisProxyBrowserUpgrade(req, socket, head, ws, wss, port, upstreamUrl.toString(), context, this.logService);
		} catch {
			this._warnNonThrowing('[ParadisCdpGateway] upgrade failed');
			socket.destroy();
		} finally {
			reservation?.releaseIfUnattached();
			if (upgradeReserved) {
				this._activeWebSocketUpgrades = Math.max(0, this._activeWebSocketUpgrades - 1);
			}
		}
	}

	// --- バインド変更時の強制切断 ---

	/** 指定トークンのアクティブなCDP接続を強制切断する（クライアントは次のツール呼び出しで再接続する）。 */
	closeConnectionsForToken(token: string): void {
		this._peerResolutionEpoch++;
		const peerAuthority = this._peerAuthorities.get(token);
		if (peerAuthority) {
			peerAuthority.generation++;
		}
		// Revoke first. WebSocket.close() is asynchronous and the peer can still emit
		// messages until its close handshake completes.
		const authority = this._connectionAuthorities.get(token);
		if (authority) {
			authority.generation++;
		}
		const set = this._connectionsByToken.get(token);
		if (!set || set.size === 0) {
			return;
		}
		const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 12);
		this._debugNonThrowing(`[ParadisCdpGateway] Closing ${set.size} CDP connection(s) for pane ${fingerprint} (binding changed)`);
		for (const ws of [...set]) {
			this._beginWebSocketClose(ws, 1000, 'para-code: binding changed, reconnect');
		}
	}

	/**
	 * ペイントークンを退役させる (ペイン/ウィンドウ終了時にサービス側から呼ぶ)。
	 * アクティブ接続を切断し、トークン別にキャッシュしていた飾りのブラウザWS id も落として
	 * トークン数に比例した単調リークを防ぐ。
	 */
	retireToken(token: string): void {
		this.closeConnectionsForToken(token);
		this._connectionAuthorities.delete(token);
		this._peerAuthorities.delete(token);
		this._browserWsIds.delete(token);
		this._rawScreenshotAuthorities.retire(token);
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._peerResolutionEpoch++;
		for (const authority of this._connectionAuthorities.values()) {
			authority.generation++;
		}
		for (const set of this._connectionsByToken.values()) {
			for (const ws of set) {
				this._clearWebSocketCloseTimer(ws);
				this._terminateWebSocket(ws);
				this._releaseWebSocketReservation(ws);
			}
		}
		this._connectionsByToken.clear();
		this._closingWebSockets.clear();
		for (const timer of this._webSocketCloseTimers.values()) {
			clearTimeout(timer);
		}
		this._webSocketCloseTimers.clear();
		this._webSocketReservationsByToken.clear();
		this._webSocketReservationCount = 0;
		this._activeHttpRequests = 0;
		this._activeWebSocketUpgrades = 0;
		try {
			this._wss?.close();
		} catch {
			// Continue clearing authority even when transport cleanup fails.
		}
		this._wss = undefined;
		this._wsModulePromise = undefined;
		this._connectionAuthorities.clear();
		this._peerAuthorities.clear();
		this._browserWsIds.clear();
		this._socketTokens = new WeakMap();
		try {
			this._rawScreenshotAuthorities.dispose();
		} catch {
			// Continue superclass disposal even when a nonessential coordinator fails.
		}
		try {
			super.dispose();
		} catch {
			this._warnNonThrowing('[ParadisCdpGateway] disposal failed');
		}
	}

	// --- 内部ヘルパー ---

	private _makeContext(access: IParadisCdpIngressAccess, reservation?: IParadisCdpWebSocketReservation): IParadisBoundContext {
		if (!this._isIngressAccessCurrent(access)) {
			throw new Error('CDP ingress authority is unavailable');
		}
		const { token } = access;
		const inputConnection = {};
		let inputConnectionClosed = false;
		let transportRegistrationFailed = false;
		let authority = this._connectionAuthorities.get(token);
		if (!authority) {
			authority = { generation: 0 };
			this._connectionAuthorities.set(token, authority);
		}
		const generation = authority.generation;
		const isCurrentLease = () => !inputConnectionClosed
			&& !transportRegistrationFailed
			&& this._isIngressAccessCurrent(access)
			&& this._connectionAuthorities.get(token) === authority
			&& authority.generation === generation;
		const closeInputConnection = () => {
			if (inputConnectionClosed) {
				return;
			}
			inputConnectionClosed = true;
			this.delegate.closeInputConnection(inputConnection);
		};
		// 接続ローカルに「最後に確認できたバインド済みtargetId」をスナップショットする。
		// captureIngressLease側の一時変動（_terminalExitedTokens/_authorityFaulted/tokenOwners）で
		// getBoundTargetIdが瞬間的にundefinedを返す窓があり、その空集合がブラウザプロキシの
		// force-detach誤爆（健全な共有セッションの恒久切断）を引き起こすため、リースが生存している間は
		// 直近の値で埋める。恒久失効時はcloseConnectionsForTokenが世代をbumpしてisCurrentLeaseを偽にし、
		// 接続ごと殺すのでスナップショットが古い値を返し続ける心配はない。
		let lastKnownBoundTargetId: string | undefined;
		return {
			rawScreenshotCoordinator: this._rawScreenshotAuthorities.forAuthority(token),
			isCurrentLease,
			boundTargetIds: () => {
				if (!isCurrentLease()) {
					return new Set<string>();
				}
				const tid = this.delegate.getBoundTargetId(token);
				if (tid) {
					lastKnownBoundTargetId = tid;
					return new Set([tid]);
				}
				return lastKnownBoundTargetId ? new Set([lastKnownBoundTargetId]) : new Set<string>();
			},
			captureBoundPageScreenshot: async options => {
				if (!isCurrentLease()) {
					return undefined;
				}
				const image = await this.delegate.captureBoundPageScreenshot(token, options);
				return isCurrentLease() ? image : undefined;
			},
			isBoundPageVisible: async () => {
				if (!isCurrentLease()) {
					return false;
				}
				const visible = await this.delegate.isBoundPageVisible(token);
				return isCurrentLease() && visible;
			},
			dispatchBoundPageInput: (expectedTargetId, method, paramsJson, isRouteCurrent = () => true) => {
				if (!isCurrentLease()) {
					return {
						response: Promise.resolve({ status: 'retryable' as const, message: 'PARA_BROWSER_RETRYABLE: CDP connection authority is unavailable' }),
						drained: Promise.resolve(),
					};
				}
				return this.delegate.dispatchBoundPageInput(
					token,
					inputConnection,
					expectedTargetId,
					method,
					paramsJson,
					() => isCurrentLease() && isRouteCurrent(),
				);
			},
			closeInputConnection,
			onOpen: ws => {
				if (!isCurrentLease()) {
					reservation?.releaseIfUnattached();
					try { ws.close(1000, 'para-code: browser binding changed, reconnect'); } catch { /* ignore */ }
					return;
				}
				if (reservation && !reservation.attach(ws)) {
					transportRegistrationFailed = true;
					try { ws.close(1013, 'para-code: CDP connection capacity unavailable'); } catch { /* ignore */ }
					return;
				}
				let set = this._connectionsByToken.get(token);
				if (!set) {
					set = new Set();
					this._connectionsByToken.set(token, set);
				}
				set.add(ws);
				ws.on('close', () => {
					this._closingWebSockets.delete(ws);
					this._clearWebSocketCloseTimer(ws);
					closeInputConnection();
					const current = this._connectionsByToken.get(token);
					current?.delete(ws);
					if (current && current.size === 0) {
						this._connectionsByToken.delete(token);
					}
				});
			},
		};
	}

	/**
	 * 接続元のペイントークンを解決する（`?pane=`クエリ → ピアPID解決の順）。
	 * ピアPID解決はソケット単位でメモ化する（keep-alive接続での再exec回避。正の解決のみ。
	 * 負の結果は一時的なレース—lsofの追い越し等—でありうるためメモ化しない）。
	 */
	private async _resolveIngress(req: http.IncomingMessage): Promise<IParadisCdpIngressAccess | undefined> {
		if (this._disposed) {
			return undefined;
		}
		const query = this._queryPaneOf(req);
		if (query.present) {
			return query.token ? this._captureIngressAccess(query.token) : undefined;
		}
		const s = req.socket as Socket;
		const cached = this._socketTokens.get(s);
		if (cached) {
			if (this._isIngressAccessCurrent(cached)) {
				return cached;
			}
			this._socketTokens.delete(s);
		}
		const remotePort = s.remotePort;
		if (typeof remotePort !== 'number') {
			return undefined;
		}
		const resolutionEpoch = this._peerResolutionEpoch;
		let shellAccess: IParadisCdpIngressAccess | undefined;
		const token = await this.resolvePaneTokenForPeerPort(remotePort, process.pid, {
			getTokenForShellPid: pid => {
				if (this._disposed || this._peerResolutionEpoch !== resolutionEpoch) {
					return undefined;
				}
				const candidate = this.delegate.getTokenForShellPid(pid);
				shellAccess = candidate ? this._captureIngressAccess(candidate, true) : undefined;
				return shellAccess?.token;
			},
		});
		if (this._disposed || this._peerResolutionEpoch !== resolutionEpoch) {
			return undefined;
		}
		const access = shellAccess !== undefined && shellAccess.token === token
			? (this._isIngressAccessCurrent(shellAccess) ? shellAccess : undefined)
			: token ? this._captureIngressAccess(token, true) : undefined;
		if (access) {
			this._socketTokens.set(s, access);
		} else {
			this._debugNonThrowing(`[ParadisCdpGateway] Could not resolve pane token for peer port ${remotePort}`);
		}
		return access;
	}

	private _captureIngressAccess(token: string, peerBound = false): IParadisCdpIngressAccess | undefined {
		if (token.length < 1 || token.length > MAX_INGRESS_TOKEN_LENGTH) {
			return undefined;
		}
		try {
			const lease = this.delegate.captureIngressLease(token);
			if (!lease || lease.token !== token || !this.delegate.isIngressLeaseCurrent(lease)) {
				return undefined;
			}
			if (!peerBound) {
				return { token, lease };
			}
			let peerAuthority = this._peerAuthorities.get(token);
			if (peerAuthority === undefined) {
				peerAuthority = { generation: 0 };
				this._peerAuthorities.set(token, peerAuthority);
			}
			return { token, lease, peerAuthority, peerGeneration: peerAuthority.generation };
		} catch {
			return undefined;
		}
	}

	private _isIngressAccessCurrent(access: IParadisCdpIngressAccess): boolean {
		try {
			return !this._disposed
				&& access.token.length >= 1
				&& access.token.length <= MAX_INGRESS_TOKEN_LENGTH
				&& access.lease.token === access.token
				&& (access.peerAuthority === undefined
					|| (this._peerAuthorities.get(access.token) === access.peerAuthority
						&& access.peerGeneration === access.peerAuthority.generation))
				&& this.delegate.isIngressLeaseCurrent(access.lease);
		} catch {
			return false;
		}
	}

	private _isBoundTargetCurrent(access: IParadisCdpIngressAccess, targetId: string): boolean {
		try {
			return this._isIngressAccessCurrent(access) && this.delegate.getBoundTargetId(access.token) === targetId;
		} catch {
			return false;
		}
	}

	private _pathnameOf(req: http.IncomingMessage): string | undefined {
		try {
			const rawUrl = req.url ?? '/';
			return rawUrl.length <= MAX_INGRESS_URL_LENGTH ? new URL(rawUrl, 'http://127.0.0.1').pathname : undefined;
		} catch {
			return undefined;
		}
	}

	private _queryPaneOf(req: http.IncomingMessage): IParadisCdpQueryToken {
		try {
			const rawUrl = req.url ?? '/';
			if (rawUrl.length > MAX_INGRESS_URL_LENGTH) {
				return { present: true };
			}
			const url = new URL(rawUrl, 'http://127.0.0.1');
			if (!url.searchParams.has('pane')) {
				return { present: false };
			}
			const values = url.searchParams.getAll('pane');
			if (values.length !== 1 || values[0].length < 1 || values[0].length > MAX_INGRESS_TOKEN_LENGTH) {
				return { present: true };
			}
			return { present: true, token: values[0] };
		} catch {
			return { present: true };
		}
	}

	private _browserWsIdFor(access: IParadisCdpIngressAccess): string | undefined {
		if (!this._isIngressAccessCurrent(access)) {
			return undefined;
		}
		const { token } = access;
		let id = this._browserWsIds.get(token);
		if (!id) {
			id = randomBytes(16).toString('hex');
			this._browserWsIds.set(token, id);
		}
		return id;
	}

	private _trustedLoopbackAuthority(req: http.IncomingMessage): string {
		const port = req.socket.localPort;
		return port !== undefined && Number.isSafeInteger(port) && port >= 1 && port <= 65_535
			? `127.0.0.1:${port}`
			: '127.0.0.1';
	}

	private _getWsModule(): Promise<IParadisWsModule> {
		this._wsModulePromise ??= import('ws').then(m => ({ WebSocket: m.WebSocket, WebSocketServer: m.WebSocketServer }));
		return this._wsModulePromise;
	}

	private _getWss(ws: IParadisWsModule): wsTypes.WebSocketServer {
		this._wss ??= new ws.WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_CDP_FRAME_BYTES });
		return this._wss;
	}

	private _reserveWebSocket(token: string): IParadisCdpWebSocketReservation | undefined {
		const tokenCount = this._webSocketReservationsByToken.get(token) ?? 0;
		if (this._disposed || this._webSocketReservationCount >= MAX_ACTIVE_WEBSOCKETS || tokenCount >= MAX_ACTIVE_WEBSOCKETS_PER_TOKEN) {
			return undefined;
		}
		this._webSocketReservationCount++;
		this._webSocketReservationsByToken.set(token, tokenCount + 1);
		let state: 'reserved' | 'attached' | 'released' = 'reserved';
		const release = () => {
			if (state === 'released') {
				return;
			}
			state = 'released';
			this._webSocketReservationCount = Math.max(0, this._webSocketReservationCount - 1);
			const current = this._webSocketReservationsByToken.get(token);
			if (current === undefined || current <= 1) {
				this._webSocketReservationsByToken.delete(token);
			} else {
				this._webSocketReservationsByToken.set(token, current - 1);
			}
		};
		return {
			attach: ws => {
				if (state !== 'reserved' || this._disposed) {
					release();
					return false;
				}
				state = 'attached';
				try {
					this._webSocketReservationReleases.set(ws, release);
					ws.once('close', () => this._releaseWebSocketReservation(ws));
					return true;
				} catch {
					this._webSocketReservationReleases.delete(ws);
					release();
					return false;
				}
			},
			releaseIfUnattached: () => {
				if (state === 'reserved') {
					release();
				}
			},
		};
	}

	private _releaseWebSocketReservation(ws: wsTypes.WebSocket): void {
		const release = this._webSocketReservationReleases.get(ws);
		if (release === undefined) {
			return;
		}
		this._webSocketReservationReleases.delete(ws);
		release();
	}

	private _beginWebSocketClose(ws: wsTypes.WebSocket, code: number, reason: string): void {
		if (this._closingWebSockets.has(ws)) {
			return;
		}
		this._closingWebSockets.add(ws);
		try {
			ws.close(code, reason);
		} catch {
			// A failed graceful close still proceeds to bounded force termination.
		}
		if (!this._closingWebSockets.has(ws)) {
			return;
		}
		const timer = setTimeout(() => {
			this._webSocketCloseTimers.delete(ws);
			this._terminateWebSocket(ws);
		}, WEBSOCKET_CLOSE_GRACE_MS);
		this._webSocketCloseTimers.set(ws, timer);
	}

	private _clearWebSocketCloseTimer(ws: wsTypes.WebSocket): void {
		const timer = this._webSocketCloseTimers.get(ws);
		if (timer === undefined) {
			return;
		}
		this._webSocketCloseTimers.delete(ws);
		clearTimeout(timer);
	}

	private _terminateWebSocket(ws: wsTypes.WebSocket): void {
		try {
			ws.terminate();
		} catch {
			// Transport cleanup is best effort; reservation remains held until close/dispose.
		}
	}

	private _sendJson(res: http.ServerResponse, status: number, body: unknown): void {
		if (!res.headersSent) {
			res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
		}
		res.end(JSON.stringify(body));
	}

	private _sendIngressUnavailable(res: http.ServerResponse): void {
		this._sendJson(res, 403, INGRESS_UNAVAILABLE_BODY);
	}

	private _debugNonThrowing(message: string): void {
		try {
			this.logService.debug(message);
		} catch {
			// Diagnostics must never interrupt authority cleanup or denial.
		}
	}

	private _warnNonThrowing(message: string): void {
		try {
			this.logService.warn(message);
		} catch {
			// Diagnostics must never interrupt transport settlement.
		}
	}
}
