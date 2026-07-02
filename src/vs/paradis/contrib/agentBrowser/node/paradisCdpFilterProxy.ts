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
//     targetIdしか観測できない。範囲外への Target.attachToTarget / activateTarget
//     等はCDPエラーで拒否。Target.createTarget は常に拒否（Para Codeでは
//     MCPからの新規タブ生成を提供しない）。Target.closeTarget / Page.close も常に拒否
//     （共有中のWebContentsView自体が破棄されるため。ALWAYS_DENIED_METHODS参照）。
//     Target.getTargets の結果も絞り込む。
//   - ウィンドウサイズ操作系（Browser.getWindowForTarget / setContentsSize 等）は
//     Electron未実装（-32601素通し）にせず、-32000で理由と代替（emulate）を明示して拒否。
//   - セッションスコープの Page.captureScreenshot は、対象がバインド済みprimaryページ
//     なら electron-main の BrowserView.captureScreenshot()（非表示時の回避策付き）へ
//     委譲してCDPレスポンスを合成する。マッピング不能なパラメータ組合せは素通し。
//   - セッションスコープの Input.* は転送直前にバインド済みページへ webContents.focus()
//     を強制する（Chromium内部フォーカスが別webContentsにあると合成入力が飛ぶ問題の対策）。
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
import { IParadisCdpScreenshotOptions } from '../common/paradisAgentBrowser.js';

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
	/** 接続確立時に呼ばれる（バインド変更時の強制切断用に登録する）。 */
	onOpen(ws: wsTypes.WebSocket): void;
	/**
	 * バインド済みprimaryページのスクリーンショットを、electron-mainのupstream実装
	 * `BrowserView.captureScreenshot()`（非表示時の回避策付き）へ委譲して撮る。
	 * 戻り値はbase64エンコード済み画像データ。撮れない場合（ビュー消滅等）はundefined
	 * （呼び出し元は上流CDPへの素通しにフォールバックする）。
	 */
	captureBoundPageScreenshot(options: IParadisCdpScreenshotOptions): Promise<string | undefined>;
	/**
	 * `Input.*` 転送直前にバインド済みページのwebContentsへChromium内部フォーカスを
	 * 強制する（fire-and-forget、失敗は無視。Superset知見: 内部フォーカスが別の
	 * webContentsにあると合成入力がターミナル等へ飛ぶ）。
	 */
	focusBoundPage(): void;
}

interface IJsonRpcMsg {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
	sessionId?: string;
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

/**
 * セッションスコープの `Page.captureScreenshot` パラメータを、electron-main委譲用の
 * オプション（{@link IParadisCdpScreenshotOptions}）へマッピングする。
 * 対応できないパラメータ組合せのときは undefined を返す（上流へフォールバック素通し）:
 *   - `format` が jpeg/png 以外（webp等）
 *   - `fromSurface: false` の明示指定（upstream実装はサーフェスキャプチャ相当のみ）
 *   - `clip.scale` が1以外（upstreamのpageRectはスケール指定を持たない）
 *   - `clip` と `captureBeyondViewport: true` の併用（このときのclipは絶対ページ座標系で、
 *     ビューポート相対のpageRectでは表現できない。puppeteerの要素スクリーンショット経路）
 */
function mapCaptureScreenshotParams(params: Record<string, unknown> | undefined): IParadisCdpScreenshotOptions | undefined {
	const p = (params ?? {}) as {
		format?: unknown;
		quality?: unknown;
		clip?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown; scale?: unknown };
		fromSurface?: unknown;
		captureBeyondViewport?: unknown;
	};
	// CDPのformat既定は'png'（upstream実装の既定は'jpeg'なので明示的に埋める）
	let format: 'jpeg' | 'png' = 'png';
	if (p.format === 'jpeg' || p.format === 'png') {
		format = p.format;
	} else if (p.format !== undefined) {
		return undefined;
	}
	if (p.fromSurface === false) {
		return undefined;
	}
	const quality = typeof p.quality === 'number' ? p.quality : undefined;
	const beyondViewport = p.captureBeyondViewport === true;
	if (p.clip !== undefined) {
		const { x, y, width, height, scale } = p.clip;
		if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
			return undefined;
		}
		if (scale !== undefined && scale !== 1) {
			return undefined;
		}
		if (beyondViewport) {
			return undefined;
		}
		return { format, quality, pageRect: { x, y, width, height } };
	}
	return { format, quality, fullPage: beyondViewport ? true : undefined };
}

function targetIdOf(obj: unknown): string | undefined {
	if (typeof obj !== 'object' || obj === null) {
		return undefined;
	}
	const t = (obj as { targetId?: unknown }).targetId;
	return typeof t === 'string' ? t : undefined;
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
		ctx.onOpen(clientWs);
		const upstream = new ws.WebSocket(`ws://127.0.0.1:${upstreamPort}/devtools/page/${targetId}`);
		const closeBoth = () => {
			try { clientWs.close(); } catch { /* ignore */ }
			try { upstream.close(); } catch { /* ignore */ }
		};
		const pending: wsTypes.RawData[] = [];
		clientWs.on('message', data => {
			// 常時拒否メソッドはページレベル接続でも遮断する（Page.close等は共有ビューを破壊する）
			let msg: IJsonRpcMsg | undefined;
			try {
				msg = JSON.parse(data.toString()) as IJsonRpcMsg;
			} catch {
				msg = undefined;
			}
			if (msg?.method !== undefined) {
				const denied = ALWAYS_DENIED_METHODS.get(msg.method) ??
					(LAYOUT_MANAGED_DENIED_METHODS.has(msg.method) ? `${msg.method} is not supported: ${LAYOUT_MANAGED_DENIED_MESSAGE}` : undefined);
				if (denied !== undefined) {
					if (typeof msg.id === 'number' && clientWs.readyState === ws.WebSocket.OPEN) {
						try { clientWs.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: denied } })); } catch { /* ignore */ }
					}
					return;
				}
			}
			if (upstream.readyState === ws.WebSocket.OPEN) {
				upstream.send(data);
			} else {
				pending.push(data);
			}
		});
		upstream.on('open', () => {
			for (const buf of pending) {
				upstream.send(buf);
			}
			pending.length = 0;
			upstream.on('message', data => {
				if (clientWs.readyState === ws.WebSocket.OPEN) {
					clientWs.send(data);
				}
			});
		});
		upstream.on('error', err => {
			logService.debug('[ParadisCdpGateway] page upstream error', err);
			closeBoth();
		});
		upstream.on('close', closeBoth);
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
		ctx.onOpen(clientWs);
		const upstream = new ws.WebSocket(upstreamBrowserWsUrl);

		/** クライアント発行の未応答リクエストid → メソッド名（応答フィルタの分岐用）。 */
		const pendingMethods = new Map<number, string>();
		/** クライアントに公開済みのCDP sessionId（この集合外のセッションフレームは遮断）。 */
		const allowedSessionIds = new Set<string>();
		/**
		 * sessionId → targetId の対応表（Supersetの sessionIdToTargetId と同型）。
		 * セッションスコープの Page.captureScreenshot 委譲と Input.* 直前のフォーカス強制で、
		 * 「このセッションはバインド済みprimaryページのものか」を判定するために使う。
		 * Target.attachedToTarget（root/nested/内部attach応答）で記録し、
		 * Target.detachedFromTarget で削除する。
		 */
		const sessionIdToTargetId = new Map<string, string>();
		/** クライアント発行の Target.attachToTarget リクエストid → 要求targetId（応答のsessionId対応付け用）。 */
		const pendingAttachTargets = new Map<number, string>();
		/** プロキシ内部発行の Target.attachToTarget リクエストid → 要求targetId（同上）。 */
		const internalAttachTargets = new Map<number, string>();
		/**
		 * 許可済みtargetIdの動的セット。バインド済みセットから始まり、openerIdが許可済みの
		 * ターゲット（ポップアップ・OOPIF・ワーカー・prerender等の子孫）を推移的に加える。
		 * childToParent により、親の破棄時に子孫を再帰的に間引く。
		 */
		const allowedTargetIds = new Set<string>(ctx.boundTargetIds());
		const childToParent = new Map<string, string>();
		/**
		 * プロキシ自身が上流に発行した内部リクエストid。応答はクライアントに転送しない
		 * （クライアントが発行していないidを見せないため）。
		 */
		const INTERNAL_REQ_BASE = 0x7fff0000;
		let internalReqSeq = 0;
		const internalPendingIds = new Set<number>();
		/** 上流OPEN前にクライアントが送ったフレームのバッファ。 */
		const pendingUpstream: unknown[] = [];

		const refreshBound = () => {
			for (const tid of ctx.boundTargetIds()) {
				allowedTargetIds.add(tid);
			}
		};
		const isAllowedTarget = (info: { targetId?: string; openerId?: string } | undefined, fallbackTargetId?: string): boolean => {
			refreshBound();
			const tid = info?.targetId ?? fallbackTargetId;
			if (!tid) {
				return false;
			}
			if (allowedTargetIds.has(tid)) {
				return true;
			}
			const opener = info?.openerId;
			if (opener && allowedTargetIds.has(opener)) {
				allowedTargetIds.add(tid);
				childToParent.set(tid, opener);
				return true;
			}
			return false;
		};
		const dropTarget = (tid: string | undefined) => {
			if (!tid) {
				return;
			}
			// 子孫も再帰的に許可セットから外す（閉じたタブの子が残留してスコープが漏れ続けるのを防ぐ）
			const queue: string[] = [tid];
			const visited = new Set<string>();
			while (queue.length > 0) {
				const cur = queue.shift() as string;
				if (visited.has(cur)) {
					continue;
				}
				visited.add(cur);
				allowedTargetIds.delete(cur);
				for (const [child, parent] of childToParent) {
					if (parent === cur && !visited.has(child)) {
						queue.push(child);
					}
				}
				childToParent.delete(cur);
			}
			for (const [child, parent] of [...childToParent]) {
				if (visited.has(parent)) {
					childToParent.delete(child);
				}
			}
			for (const [sid, mappedTid] of [...sessionIdToTargetId]) {
				if (visited.has(mappedTid)) {
					sessionIdToTargetId.delete(sid);
				}
			}
		};

		const closeBoth = () => {
			try { clientWs.close(); } catch { /* ignore */ }
			try { upstream.close(); } catch { /* ignore */ }
		};
		const sendToClient = (obj: unknown) => {
			if (clientWs.readyState !== ws.WebSocket.OPEN) {
				return;
			}
			try { clientWs.send(JSON.stringify(obj)); } catch { /* ignore */ }
		};
		const sendToUpstream = (obj: unknown) => {
			if (upstream.readyState === ws.WebSocket.CONNECTING) {
				pendingUpstream.push(obj);
				return;
			}
			if (upstream.readyState !== ws.WebSocket.OPEN) {
				return;
			}
			try { upstream.send(JSON.stringify(obj)); } catch { /* ignore */ }
		};
		const sendInternal = (method: string, params: Record<string, unknown>): number => {
			internalReqSeq++;
			const id = INTERNAL_REQ_BASE + internalReqSeq;
			internalPendingIds.add(id);
			sendToUpstream({ id, method, params });
			return id;
		};
		// -32601（method not found）ではなく-32000を返す: CDPクライアントに
		// 「このChromiumに存在しないメソッド」フォールバック経路へ入らせないため（Superset知見）
		const rejectRequest = (id: number, message: string) => {
			sendToClient({ id, error: { code: -32000, message } });
		};

		upstream.on('open', () => {
			for (const obj of pendingUpstream) {
				try { upstream.send(JSON.stringify(obj)); } catch { /* ignore */ }
			}
			pendingUpstream.length = 0;
		});

		// --- クライアント → 上流 ---
		clientWs.on('message', (data: wsTypes.RawData) => {
			let msg: IJsonRpcMsg;
			try {
				msg = JSON.parse(data.toString()) as IJsonRpcMsg;
			} catch {
				return;
			}
			const id = typeof msg.id === 'number' ? msg.id : undefined;
			const method = msg.method ?? '';

			const deniedMessage = ALWAYS_DENIED_METHODS.get(method);
			if (deniedMessage !== undefined) {
				if (id !== undefined) {
					rejectRequest(id, deniedMessage);
				}
				return;
			}

			// ウィンドウサイズ操作系: Electron未実装（-32601）を素通しせず、理由と代替手段を明示する
			if (LAYOUT_MANAGED_DENIED_METHODS.has(method)) {
				if (id !== undefined) {
					rejectRequest(id, `${method} is not supported: ${LAYOUT_MANAGED_DENIED_MESSAGE}`);
				}
				return;
			}

			// セッションスコープのフレーム: 公開済みsessionIdのみ通す
			if (msg.sessionId) {
				if (!allowedSessionIds.has(msg.sessionId)) {
					if (id !== undefined) {
						rejectRequest(id, 'The supplied CDP sessionId is not authorized for this Para Code pane binding.');
					}
					return;
				}
				const sessionTargetId = sessionIdToTargetId.get(msg.sessionId);
				const isBoundPrimary = sessionTargetId !== undefined && ctx.boundTargetIds().has(sessionTargetId);
				// Input.* の転送直前にバインド済みページへChromium内部フォーカスを強制する
				// （内部フォーカスが別webContents—ターミナル等—にあると合成入力がそちらへ
				// 飛ぶElectronの既知問題への対策。Superset cdp-filter-proxy.ts の移植）。
				// 失敗は握りつぶし、転送自体は常に行う。
				if (isBoundPrimary && method.startsWith('Input.')) {
					ctx.focusBoundPage();
				}
				// Page.captureScreenshot はバインド済みprimaryページ宛てなら electron-main の
				// upstream実装（BrowserView.captureScreenshot: 可視化キック + capturePage(stayHidden) +
				// リトライ）へ委譲する。素通しだとWebContentsView非表示時（背面タブ・オーバーレイ・
				// 最小化）にChromiumのサーフェスコピーが失敗するため。マッピングできない
				// パラメータ組合せと委譲失敗時は上流へフォールバック素通しする。
				if (isBoundPrimary && method === 'Page.captureScreenshot' && id !== undefined) {
					const mapped = mapCaptureScreenshotParams(msg.params);
					if (mapped) {
						const requestSessionId = msg.sessionId;
						ctx.captureBoundPageScreenshot(mapped).then(
							data => {
								if (data !== undefined) {
									sendToClient({ id, sessionId: requestSessionId, result: { data } });
								} else {
									sendToUpstream(msg);
								}
							},
							() => sendToUpstream(msg),
						);
						return;
					}
				}
				sendToUpstream(msg);
				return;
			}

			refreshBound();
			const bound = allowedTargetIds;

			// `filter` の除去（puppeteer/cdp-use対策、ファイル先頭コメント参照）
			if ((method === 'Target.setAutoAttach' || method === 'Target.setDiscoverTargets') && id !== undefined) {
				const original = (msg.params ?? {}) as Record<string, unknown>;
				const rewritten: Record<string, unknown> = { ...original };
				delete rewritten.filter;
				pendingMethods.set(id, method);
				sendToUpstream({ id, method, params: rewritten });
				return;
			}

			if (method === 'Target.attachToTarget' && id !== undefined) {
				const tid = targetIdOf(msg.params);
				if (tid && !bound.has(tid)) {
					rejectRequest(id, 'This connection is scoped to the browser page bound to your terminal pane; attachToTarget for other targets is refused.');
					return;
				}
				pendingMethods.set(id, method);
				if (tid) {
					pendingAttachTargets.set(id, tid);
				}
				sendToUpstream(msg);
				return;
			}

			// Target.closeTarget は ALWAYS_DENIED_METHODS で常時拒否済み（共有ページの破棄防止）
			if (method === 'Target.activateTarget' && id !== undefined) {
				const tid = targetIdOf(msg.params);
				if (!tid || !bound.has(tid)) {
					rejectRequest(id, `${method} for targets outside the bound scope is refused by the Para Code CDP gateway.`);
					return;
				}
				pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			if (method === 'Target.createTarget' && id !== undefined) {
				// Para CodeではMCP起点の新規タブ/ページ生成は提供しない（バインドは共有された1ページ単位）。
				rejectRequest(id, 'Target.createTarget is not supported by the Para Code CDP gateway. Ask the user to open and share a page from Para Code instead.');
				return;
			}

			if (method === 'Target.getTargets' || method === 'Target.getTargetInfo') {
				if (id !== undefined) {
					pendingMethods.set(id, method);
				}
				sendToUpstream(msg);
				return;
			}

			if (method === 'Target.detachFromTarget' && id !== undefined) {
				const sid = (msg.params as { sessionId?: string } | undefined)?.sessionId;
				const tid = targetIdOf(msg.params);
				if ((sid && !allowedSessionIds.has(sid)) || (tid && !bound.has(tid))) {
					rejectRequest(id, 'Target.detachFromTarget outside the bound scope is refused by the Para Code CDP gateway.');
					return;
				}
				pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			// その他の Target.*: targetId / sessionId が指定されていればスコープ内か検証する
			if (method.startsWith('Target.') && id !== undefined) {
				const tid = targetIdOf(msg.params);
				const sid = (msg.params as { sessionId?: string } | undefined)?.sessionId;
				if (tid && !bound.has(tid)) {
					rejectRequest(id, `${method} targetId is outside the bound scope.`);
					return;
				}
				if (sid && !allowedSessionIds.has(sid)) {
					rejectRequest(id, `${method} sessionId is not authorized for this Para Code pane binding.`);
					return;
				}
				pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			if (id !== undefined) {
				pendingMethods.set(id, method);
			}
			sendToUpstream(msg);
		});

		// --- 上流 → クライアント ---
		upstream.on('message', (data: wsTypes.RawData) => {
			let msg: IJsonRpcMsg;
			try {
				msg = JSON.parse(data.toString()) as IJsonRpcMsg;
			} catch {
				return;
			}
			refreshBound();
			const bound = allowedTargetIds;

			// セッションスコープのフレーム
			if (msg.sessionId) {
				if (!allowedSessionIds.has(msg.sessionId)) {
					return;
				}
				if (msg.method === 'Target.attachedToTarget') {
					// ネストされたattach（許可済みターゲットのworker / iframe / prerender）。
					// 親セッションを信頼して子sessionId・子targetIdを許可セットへ加える。
					const params = msg.params as { sessionId?: string; targetInfo?: { targetId?: string; openerId?: string } } | undefined;
					if (params?.sessionId) {
						allowedSessionIds.add(params.sessionId);
					}
					const childTid = params?.targetInfo?.targetId;
					if (childTid) {
						allowedTargetIds.add(childTid);
						const opener = params?.targetInfo?.openerId;
						if (opener) {
							childToParent.set(childTid, opener);
						}
						if (params?.sessionId) {
							sessionIdToTargetId.set(params.sessionId, childTid);
						}
					}
				} else if (msg.method === 'Target.detachedFromTarget') {
					const params = msg.params as { sessionId?: string; targetId?: string } | undefined;
					if (params?.sessionId) {
						allowedSessionIds.delete(params.sessionId);
						sessionIdToTargetId.delete(params.sessionId);
					}
					dropTarget(params?.targetId);
				}
				sendToClient(msg);
				return;
			}

			// リクエストへの応答
			if (typeof msg.id === 'number') {
				if (internalPendingIds.has(msg.id)) {
					internalPendingIds.delete(msg.id);
					// プロキシ内部発行（先行attach等）への応答は握りつぶす。
					// attach成功時のsessionIdは許可セットへ加える（イベント経由と二重でも無害）。
					const sid = (msg.result as { sessionId?: string } | undefined)?.sessionId;
					const attachTid = internalAttachTargets.get(msg.id);
					internalAttachTargets.delete(msg.id);
					if (sid) {
						allowedSessionIds.add(sid);
						if (attachTid) {
							sessionIdToTargetId.set(sid, attachTid);
						}
					}
					return;
				}
				const origMethod = pendingMethods.get(msg.id);
				pendingMethods.delete(msg.id);
				const clientAttachTid = pendingAttachTargets.get(msg.id);
				pendingAttachTargets.delete(msg.id);
				if (origMethod === 'Target.getTargets' && msg.result) {
					const infos = (msg.result.targetInfos ?? []) as Array<{ type?: string } & Record<string, unknown>>;
					const filtered = infos
						.filter(i => {
							const tid = targetIdOf(i);
							return tid !== undefined && bound.has(tid);
						})
						.map(i => rewriteTargetInfoType(i));
					sendToClient({ ...msg, result: { ...msg.result, targetInfos: filtered } });
					return;
				}
				if (origMethod === 'Target.attachToTarget' && msg.result) {
					const sid = (msg.result as { sessionId?: string }).sessionId;
					if (sid) {
						allowedSessionIds.add(sid);
						if (clientAttachTid) {
							sessionIdToTargetId.set(sid, clientAttachTid);
						}
					}
				}
				if (origMethod === 'Target.getTargetInfo' && msg.result?.targetInfo) {
					const tid = targetIdOf(msg.result.targetInfo);
					if (!tid || !bound.has(tid)) {
						sendToClient({ id: msg.id, error: { code: -32000, message: 'target not found' } });
						return;
					}
					sendToClient({ ...msg, result: { ...msg.result, targetInfo: rewriteTargetInfoType(msg.result.targetInfo as { type?: string }) } });
					return;
				}
				sendToClient(msg);
				return;
			}

			// ルートセッションのイベント
			const method = msg.method ?? '';
			if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
				const params = msg.params as { targetInfo?: { type?: string; targetId?: string; openerId?: string; attached?: boolean }; targetId?: string } | undefined;
				const info = params?.targetInfo;
				if (!isAllowedTarget(info, params?.targetId)) {
					return;
				}
				const tid = info?.targetId ?? params?.targetId;
				// Chromiumのauto-attachはElectronホストの一部ターゲット（ページ由来のワーカー・
				// ポップアップ・prerender等）を取りこぼす。attachedToTargetが来ないターゲットは
				// puppeteer/playwrightから不可視のままになるため、スコープ内の新規ターゲットには
				// 内部リクエストで先行attachし、本物のattachedToTargetイベントを発火させる。
				const t = info?.type;
				if (method === 'Target.targetCreated' && tid && info?.attached !== true &&
					(t === 'page' || t === 'iframe' || t === 'service_worker' || t === 'shared_worker' || t === 'worker' || t === 'prerender' || t === 'webview')) {
					const internalId = sendInternal('Target.attachToTarget', { targetId: tid, flatten: true });
					internalAttachTargets.set(internalId, tid);
				}
				sendToClient(info ? { ...msg, params: { ...params, targetInfo: rewriteTargetInfoType(info) } } : msg);
				return;
			}
			if (method === 'Target.targetDestroyed' || method === 'Target.targetCrashed') {
				const params = msg.params as { targetInfo?: { type?: string; targetId?: string }; targetId?: string } | undefined;
				const tid = params?.targetInfo?.targetId ?? params?.targetId;
				if (!tid || !bound.has(tid)) {
					return;
				}
				dropTarget(tid);
				sendToClient(params?.targetInfo ? { ...msg, params: { ...params, targetInfo: rewriteTargetInfoType(params.targetInfo) } } : msg);
				return;
			}
			if (method === 'Target.attachedToTarget') {
				const params = msg.params as { sessionId?: string; targetInfo?: { type?: string; targetId?: string; openerId?: string } } | undefined;
				if (!isAllowedTarget(params?.targetInfo)) {
					// スコープ外ターゲットへのauto-attach。イベントは握りつぶすが、
					// waitForDebuggerOnStartで一時停止したまま放置しないよう解放してデタッチする。
					if (params?.sessionId) {
						// runIfWaitingForDebugger は対象セッションスコープで送る必要があるため、
						// sessionId付きの内部フレームを直接構築する
						internalReqSeq++;
						const rid = INTERNAL_REQ_BASE + internalReqSeq;
						internalPendingIds.add(rid);
						sendToUpstream({ id: rid, method: 'Runtime.runIfWaitingForDebugger', params: {}, sessionId: params.sessionId });
						sendInternal('Target.detachFromTarget', { sessionId: params.sessionId });
					}
					return;
				}
				if (params?.sessionId) {
					allowedSessionIds.add(params.sessionId);
					const attachedTid = params?.targetInfo?.targetId;
					if (attachedTid) {
						sessionIdToTargetId.set(params.sessionId, attachedTid);
					}
				}
				sendToClient({ ...msg, params: { ...(params ?? {}), targetInfo: rewriteTargetInfoType(params?.targetInfo) } });
				return;
			}
			if (method === 'Target.detachedFromTarget') {
				const sid = (msg.params as { sessionId?: string } | undefined)?.sessionId;
				if (!sid || !allowedSessionIds.has(sid)) {
					return;
				}
				allowedSessionIds.delete(sid);
				sessionIdToTargetId.delete(sid);
				sendToClient(msg);
				return;
			}
			// 非flatten経路のセッションペイロード: スコープ外なら遮断
			if (method === 'Target.receivedMessageFromTarget') {
				const params = msg.params as { sessionId?: string; targetId?: string } | undefined;
				if (params?.sessionId && !allowedSessionIds.has(params.sessionId)) {
					return;
				}
				if (params?.targetId && !bound.has(params.targetId)) {
					return;
				}
				sendToClient(msg);
				return;
			}
			// その他の Target.* イベントも targetId / sessionId をスコープ検証する
			if (method.startsWith('Target.')) {
				const tid = targetIdOf(msg.params) ?? (msg.params as { targetInfo?: { targetId?: string } } | undefined)?.targetInfo?.targetId;
				const sid = (msg.params as { sessionId?: string } | undefined)?.sessionId;
				if (tid && !bound.has(tid)) {
					return;
				}
				if (sid && !allowedSessionIds.has(sid)) {
					return;
				}
				sendToClient(msg);
				return;
			}
			sendToClient(msg);
		});

		upstream.on('error', err => {
			logService.debug('[ParadisCdpGateway] browser upstream error', err);
			closeBoth();
		});
		upstream.on('close', closeBoth);
		clientWs.on('error', closeBoth);
		clientWs.on('close', closeBoth);
	});
}
