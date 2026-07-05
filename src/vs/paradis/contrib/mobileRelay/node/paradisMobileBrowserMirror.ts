/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser（Electron内ブラウザビュー）のCDPミラー（設計書 M3）。
// shared process 常駐。モバイルからの browser チャネル要求を受け、
// 上流CDP（Electron本体の remote-debugging）の対象ページに接続して
// フレームをモバイルへ転送し、入力イベントを流し込む。
//
// 【実装ノート】Page.startScreencast は Electron の WebContentsView 埋め込みページでは
// フレームを発火しない（2026-07-05 実測）。そのため Page.captureScreenshot の定期
// ポーリング + 入力直後の即時キャプチャで実装する（~1.5fps、リレー帯域にも優しい）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisCdpUpstream } from '../../agentBrowser/node/paradisCdpUpstream.js';

/** モバイル→PC の browser チャネル要求。 */
type BrowserInbound =
	| { t: 'targets'; id: string }
	| { t: 'start'; id: string; targetId: string }
	| { t: 'stop'; id: string }
	| {
		t: 'input'; kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text';
		/** tap/scroll: 直近フレームに対する正規化座標(0..1)。 */
		nx?: number; ny?: number;
		/** scroll: 正規化スクロール量（正=下へ）。 */
		dy?: number;
		text?: string;
	};

interface MirrorSession {
	socket: WebSocket;
	targetId: string;
	nextId: number;
	/** CSSビューポート寸法（入力座標変換とフレームメタに使う）。 */
	viewWidth: number;
	viewHeight: number;
	captureTimer: ReturnType<typeof setInterval> | undefined;
	captureInFlight: boolean;
	/** 直近に送ったフレーム（無変化フレームの送信スキップ用）。 */
	lastFrameData: string | undefined;
	/** msgId → 応答ハンドラ（captureScreenshot / getLayoutMetrics の応答受け取り用）。 */
	handlers: Map<number, (result: unknown) => void>;
	send: (payload: Uint8Array) => void;
}

// 変化が無いフレームは送信しない（下記）ため、間隔は短めでも帯域を圧迫しない
const CAPTURE_INTERVAL_MS = 250;
const CDP_CALL_TIMEOUT_MS = 5000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ParadisMobileBrowserMirror extends Disposable {

	/** mobileId → 稼働中のミラーセッション。 */
	private readonly sessions = new Map<string, MirrorSession>();

	constructor(
		private readonly upstream: ParadisCdpUpstream,
		private readonly logService: ILogService,
	) {
		super();
	}

	override dispose(): void {
		for (const mobileId of [...this.sessions.keys()]) {
			this.stopSession(mobileId);
		}
		super.dispose();
	}

	/** モバイル切断時に呼ぶ（ポーリングを止めてCDP接続を閉じる）。 */
	stopSession(mobileId: string): void {
		const session = this.sessions.get(mobileId);
		if (session) {
			this.sessions.delete(mobileId);
			if (session.captureTimer !== undefined) {
				clearInterval(session.captureTimer);
			}
			try {
				session.socket.close();
			} catch { /* ignore */ }
		}
	}

	/** browser チャネルの1要求を処理する。sendは要求元モバイルへの応答送信。 */
	async handleRequest(mobileId: string, payload: Uint8Array, send: (payload: Uint8Array) => void): Promise<void> {
		let msg: BrowserInbound;
		try {
			msg = JSON.parse(decoder.decode(payload)) as BrowserInbound;
		} catch {
			return;
		}
		const reply = (body: object) => send(encoder.encode(JSON.stringify(body)));
		try {
			if (msg.t === 'targets') {
				const list = await this.upstream.fetchJson('/json/list') as Array<Record<string, unknown>>;
				// para-browser のページ = http(s) URLを持つ type='page' のターゲットのみ。
				// URLだけで絞ると、開いているページが内部に持つ iframe / service_worker /
				// worker まで別ページとして列挙されてしまう（workbench等のvscode-file
				// ウィンドウやDevTools自身も除外）
				const targets = list
					.filter(t => t.type === 'page' && typeof t.url === 'string' && /^https?:\/\//.test(t.url as string))
					.map(t => ({ targetId: String(t.id), title: String(t.title ?? ''), url: String(t.url) }));
				reply({ id: msg.id, t: 'targets', targets });
			} else if (msg.t === 'start') {
				await this.start(mobileId, msg.targetId, send);
				reply({ id: msg.id, t: 'started' });
			} else if (msg.t === 'stop') {
				this.stopSession(mobileId);
				reply({ id: msg.id, t: 'stopped' });
			} else if (msg.t === 'input') {
				this.dispatchInput(mobileId, msg);
			}
		} catch (err) {
			if (msg.t !== 'input' && msg.id) {
				reply({ id: msg.id, error: String(err instanceof Error ? err.message : err) });
			} else {
				this.logService.warn('[paradisMobileBrowserMirror] input failed', err);
			}
		}
	}

	private async start(mobileId: string, targetId: string, send: (payload: Uint8Array) => void): Promise<void> {
		this.stopSession(mobileId);
		const port = await this.upstream.resolvePort();
		if (!port) {
			throw new Error('ブラウザのCDPエンドポイントが見つかりません');
		}
		const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
		const session: MirrorSession = {
			socket, targetId, nextId: 1, viewWidth: 0, viewHeight: 0,
			captureTimer: undefined, captureInFlight: false, lastFrameData: undefined, handlers: new Map(), send,
		};
		this.sessions.set(mobileId, session);

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('CDP接続がタイムアウトしました')), 5000);
			socket.onopen = () => { clearTimeout(timer); resolve(); };
			socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP接続に失敗しました')); };
		});

		// 待機中に同一mobileIdへの別の'start'がMapを上書きしていたら、この接続は
		// もう不要（古い方）なので破棄する。ここを再検証しないと、上書きされた古い
		// sessionのタイマー/ソケットがMapから二度と辿れずリークし続ける。
		if (this.sessions.get(mobileId) !== session) {
			try { socket.close(); } catch { /* ignore */ }
			return;
		}

		socket.onmessage = event => {
			try {
				const data = typeof event.data === 'string' ? event.data : decoder.decode(event.data as ArrayBuffer);
				const cdp = JSON.parse(data) as { id?: number; result?: unknown };
				if (cdp.id !== undefined) {
					const handler = session.handlers.get(cdp.id);
					if (handler) {
						session.handlers.delete(cdp.id);
						handler(cdp.result);
					}
				}
			} catch { /* ignore malformed CDP */ }
		};
		socket.onclose = () => {
			if (this.sessions.get(mobileId) === session) {
				this.stopSession(mobileId);
			}
		};

		this.cdpSend(session, 'Page.enable', {});
		// ビューポート寸法を取得（入力座標変換用）
		this.cdpCall(session, 'Page.getLayoutMetrics', {}, result => {
			const metrics = result as { cssVisualViewport?: { clientWidth?: number; clientHeight?: number } } | undefined;
			session.viewWidth = Math.round(metrics?.cssVisualViewport?.clientWidth ?? 0);
			session.viewHeight = Math.round(metrics?.cssVisualViewport?.clientHeight ?? 0);
		});
		// 定期キャプチャ（Electron WebContentsView では startScreencast が使えないため）
		this.captureFrame(session);
		session.captureTimer = setInterval(() => this.captureFrame(session), CAPTURE_INTERVAL_MS);
	}

	private captureFrame(session: MirrorSession): void {
		if (session.captureInFlight || session.socket.readyState !== 1) {
			return;
		}
		session.captureInFlight = true;
		this.cdpCall(session, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 }, result => {
			session.captureInFlight = false;
			const data = (result as { data?: string } | undefined)?.data;
			// 画面に変化が無ければ送らない（モバイル側の再描画と帯域の節約）
			if (data && data !== session.lastFrameData) {
				session.lastFrameData = data;
				session.send(encoder.encode(JSON.stringify({
					t: 'frame',
					data,
					w: session.viewWidth,
					h: session.viewHeight,
				})));
			}
		});
	}

	private dispatchInput(mobileId: string, msg: Extract<BrowserInbound, { t: 'input' }>): void {
		const session = this.sessions.get(mobileId);
		if (!session) {
			return;
		}
		const x = Math.round((msg.nx ?? 0) * session.viewWidth);
		const y = Math.round((msg.ny ?? 0) * session.viewHeight);
		if (msg.kind === 'tap') {
			// buttons:1 が無いと Chromium がクリックとして合成しないことがある（実測）
			this.cdpSend(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
			this.cdpSend(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1 });
		} else if (msg.kind === 'scroll') {
			const deltaY = Math.round((msg.dy ?? 0) * session.viewHeight);
			this.cdpSend(session, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: x || Math.round(session.viewWidth / 2), y: y || Math.round(session.viewHeight / 2), deltaX: 0, deltaY });
		} else if (msg.kind === 'back') {
			this.cdpSend(session, 'Runtime.evaluate', { expression: 'history.back()' });
		} else if (msg.kind === 'forward') {
			this.cdpSend(session, 'Runtime.evaluate', { expression: 'history.forward()' });
		} else if (msg.kind === 'reload') {
			this.cdpSend(session, 'Page.reload', {});
		} else if (msg.kind === 'text' && msg.text) {
			this.cdpSend(session, 'Input.insertText', { text: msg.text });
		}
		// 入力の反映を素早く見せるため、少し置いてから即時キャプチャする
		setTimeout(() => this.captureFrame(session), 150);
	}

	private cdpSend(session: MirrorSession, method: string, params: object): void {
		if (session.socket.readyState === 1) {
			session.socket.send(JSON.stringify({ id: session.nextId++, method, params }));
		}
	}

	private cdpCall(session: MirrorSession, method: string, params: object, onResult: (result: unknown) => void): void {
		if (session.socket.readyState !== 1) {
			return;
		}
		const id = session.nextId++;
		// CDPからの応答が欠落した場合でも呼び出し元の状態（captureInFlight等）が
		// 永久に固定化しないよう、タイムアウトで強制的にハンドラを解放する。
		const timer = setTimeout(() => {
			if (session.handlers.delete(id)) {
				onResult(undefined);
			}
		}, CDP_CALL_TIMEOUT_MS);
		session.handlers.set(id, result => {
			clearTimeout(timer);
			onResult(result);
		});
		session.socket.send(JSON.stringify({ id, method, params }));
	}
}
