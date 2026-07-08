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
// フレームを発火しない（2026-07-05 実測）。そのため electron-main の
// webContents.beginFrameSubscription によるプッシュ（PARADIS_CDP_TARGET_CHANNEL の
// onDidFrame）を主経路とし、プッシュが使えない/止まった場合（対象不明、ウィンドウ
// 最小化・オクルージョン等でペイントが起きない）のみ Page.captureScreenshot の
// 低頻度ポーリングへ自動フォールバックする。入力は従来どおりCDPで注入する。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisCdpFrameEvent, IParadisCdpFrameSubscription } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisCdpUpstream } from '../../agentBrowser/node/paradisCdpUpstream.js';

/** モバイル→PC の browser チャネル要求。 */
type BrowserInbound =
	| { t: 'targets'; id: string }
	| { t: 'start'; id: string; targetId: string }
	| { t: 'stop'; id: string }
	| {
		t: 'input'; kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text' | 'navigate';
		/** tap/scroll: 直近フレームに対する正規化座標(0..1)。 */
		nx?: number; ny?: number;
		/** scroll: 正規化スクロール量（dy: 正=下へ、dx: 正=右へ）。 */
		dy?: number;
		dx?: number;
		text?: string;
		/** navigate: 遷移先URL（http/httpsのみ受け付ける）。 */
		url?: string;
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
	/** electron-main のフレーム購読(beginFrameSubscription)が有効か。 */
	pushMode: boolean;
	/** startFrameSubscription が成功したか（stop時の参照返却用）。 */
	pushStarted: boolean;
	/** 直近にプッシュフレームを受け取った時刻（フォールバック判定用）。 */
	lastPushFrameAt: number;
	/** 直近にビューポート寸法を取得した時刻（プッシュ中の取得間引き用）。 */
	lastMetricsAt: number;
	send: (payload: Uint8Array) => void;
}

// 変化が無いフレームは送信しない（下記）ため、間隔は短めでも帯域を圧迫しない
const CAPTURE_INTERVAL_MS = 250;
// プッシュ購読中にこれ以上フレームが無い場合、ポーリングで1枚キャプチャする
// （非表示・最小化中はペイントが起きずプッシュが止まるため）
const PUSH_STALE_MS = 1500;
const CDP_CALL_TIMEOUT_MS = 5000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ParadisMobileBrowserMirror extends Disposable {

	/** mobileId → 稼働中のミラーセッション。 */
	private readonly sessions = new Map<string, MirrorSession>();

	constructor(
		private readonly upstream: ParadisCdpUpstream,
		private readonly cdpFrames: IParadisCdpFrameSubscription | undefined,
		private readonly logService: ILogService,
	) {
		super();
		if (cdpFrames) {
			this._register(cdpFrames.onDidFrame(e => this.onPushFrame(e)));
		}
	}

	/** electron-main からのプッシュフレームを、該当ターゲットをミラー中の全モバイルへ転送する。 */
	private onPushFrame(e: IParadisCdpFrameEvent): void {
		for (const session of this.sessions.values()) {
			if (session.targetId !== e.targetId || !session.pushMode) {
				continue;
			}
			session.lastPushFrameAt = Date.now();
			// フォールバックポーリングが同一フレームを再送しないよう dedup 基準も更新する
			session.lastFrameData = e.data;
			session.send(encoder.encode(JSON.stringify({ t: 'frame', data: e.data, w: e.w, h: e.h })));
		}
	}

	override dispose(): void {
		for (const mobileId of [...this.sessions.keys()]) {
			this.stopSession(mobileId);
		}
		super.dispose();
	}

	/** モバイル切断時に呼ぶ（ポーリング・プッシュ購読を止めてCDP接続を閉じる）。 */
	stopSession(mobileId: string): void {
		const session = this.sessions.get(mobileId);
		if (session) {
			this.sessions.delete(mobileId);
			if (session.captureTimer !== undefined) {
				clearInterval(session.captureTimer);
			}
			if (session.pushStarted) {
				session.pushStarted = false;
				this.cdpFrames?.stopFrameSubscription(session.targetId).catch(() => undefined);
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
			captureTimer: undefined, captureInFlight: false, lastFrameData: undefined, handlers: new Map(),
			pushMode: false, pushStarted: false, lastPushFrameAt: 0, lastMetricsAt: 0, send,
		};
		this.sessions.set(mobileId, session);

		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('CDP接続がタイムアウトしました')), 5000);
				socket.onopen = () => { clearTimeout(timer); resolve(); };
				socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP接続に失敗しました')); };
			});
		} catch (err) {
			// 接続失敗/タイムアウト時、登録済みの死にセッションをMapから外し、接続試行中の
			// ソケットもcloseする（oncloseハンドラは接続成功後にしか付かないため自動掃除されない）。
			if (this.sessions.get(mobileId) === session) {
				this.sessions.delete(mobileId);
			}
			try { socket.close(); } catch { /* ignore */ }
			throw err;
		}

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
		// 主経路: electron-main の再描画プッシュ購読（成功すればペイントの度にフレームが届く）
		if (this.cdpFrames) {
			this.cdpFrames.startFrameSubscription(targetId).then(ok => {
				if (!ok) {
					return;
				}
				if (this.sessions.get(mobileId) === session) {
					session.pushMode = true;
					session.pushStarted = true;
					session.lastPushFrameAt = Date.now();
				} else {
					// 購読成立前にセッションが破棄/置換されていたら参照を返す
					this.cdpFrames?.stopFrameSubscription(targetId).catch(() => undefined);
				}
			}).catch(err => this.logService.warn('[paradisMobileBrowserMirror] frame subscription failed', err));
		}
		// 初回フレーム（プッシュはペイント時にしか発火しないため、開始直後の1枚はキャプチャで送る）
		this.captureFrame(session);
		// 定期tick: プッシュが健在なら寸法更新のみ、プッシュ不可/停滞時はキャプチャにフォールバック
		session.captureTimer = setInterval(() => this.tick(session), CAPTURE_INTERVAL_MS);
	}

	private tick(session: MirrorSession): void {
		if (session.pushMode && Date.now() - session.lastPushFrameAt < PUSH_STALE_MS) {
			// プッシュで描画は届いている。タップ座標変換用のビューポート寸法だけ、
			// CDP往復を抑えるため約1秒間隔で追従させる
			if (Date.now() - session.lastMetricsAt >= 1000) {
				session.lastMetricsAt = Date.now();
				this.refreshViewMetrics(session);
			}
			return;
		}
		this.captureFrame(session);
	}

	private refreshViewMetrics(session: MirrorSession): void {
		this.cdpCall(session, 'Page.getLayoutMetrics', {}, metricsResult => {
			const metrics = metricsResult as { cssVisualViewport?: { clientWidth?: number; clientHeight?: number } } | undefined;
			const w = Math.round(metrics?.cssVisualViewport?.clientWidth ?? 0);
			const h = Math.round(metrics?.cssVisualViewport?.clientHeight ?? 0);
			if (w > 0 && h > 0) {
				session.viewWidth = w;
				session.viewHeight = h;
			}
		});
	}

	private captureFrame(session: MirrorSession): void {
		if (session.captureInFlight || session.socket.readyState !== 1) {
			return;
		}
		session.captureInFlight = true;
		// ビューポート寸法は毎フレーム取り直す。開始時の1回きりだと、PC側でウィンドウの
		// リサイズやパネル開閉でビューの大きさが変わったとき、フレームに載る寸法と実画面が
		// ずれてモバイルのタップ座標が系統的にズレる。
		this.cdpCall(session, 'Page.getLayoutMetrics', {}, metricsResult => {
			const metrics = metricsResult as { cssVisualViewport?: { clientWidth?: number; clientHeight?: number } } | undefined;
			const w = Math.round(metrics?.cssVisualViewport?.clientWidth ?? 0);
			const h = Math.round(metrics?.cssVisualViewport?.clientHeight ?? 0);
			if (w > 0 && h > 0) {
				session.viewWidth = w;
				session.viewHeight = h;
			}
			if (session.socket.readyState !== 1) {
				session.captureInFlight = false;
				return;
			}
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
			// タップは座標の正確さが命なので、キャッシュ済み寸法ではなく受信時点の
			// ビューポート寸法を取り直してからディスパッチする（WebRTCミラー中は
			// JPEGフレーム由来の寸法更新が止まり得る・リサイズ直後のズレも防ぐ）。
			this.cdpCall(session, 'Page.getLayoutMetrics', {}, metricsResult => {
				const metrics = metricsResult as { cssVisualViewport?: { clientWidth?: number; clientHeight?: number } } | undefined;
				const w = Math.round(metrics?.cssVisualViewport?.clientWidth ?? 0);
				const h = Math.round(metrics?.cssVisualViewport?.clientHeight ?? 0);
				if (w > 0 && h > 0) {
					session.viewWidth = w;
					session.viewHeight = h;
				}
				const tapX = Math.round((msg.nx ?? 0) * session.viewWidth);
				const tapY = Math.round((msg.ny ?? 0) * session.viewHeight);
				// buttons:1 が無いと Chromium がクリックとして合成しないことがある（実測）
				this.cdpSend(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: tapX, y: tapY, button: 'left', buttons: 1, clickCount: 1 });
				this.cdpSend(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: tapX, y: tapY, button: 'left', buttons: 1, clickCount: 1 });
			});
		} else if (msg.kind === 'scroll') {
			const deltaY = Math.round((msg.dy ?? 0) * session.viewHeight);
			const deltaX = Math.round((msg.dx ?? 0) * session.viewWidth);
			this.cdpSend(session, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: x || Math.round(session.viewWidth / 2), y: y || Math.round(session.viewHeight / 2), deltaX, deltaY });
		} else if (msg.kind === 'back') {
			this.cdpSend(session, 'Runtime.evaluate', { expression: 'history.back()' });
		} else if (msg.kind === 'forward') {
			this.cdpSend(session, 'Runtime.evaluate', { expression: 'history.forward()' });
		} else if (msg.kind === 'reload') {
			this.cdpSend(session, 'Page.reload', {});
		} else if (msg.kind === 'text' && msg.text) {
			this.cdpSend(session, 'Input.insertText', { text: msg.text });
		} else if (msg.kind === 'navigate' && msg.url && /^https?:\/\//i.test(msg.url)) {
			this.cdpSend(session, 'Page.navigate', { url: msg.url });
		}
		// 入力の反映を素早く見せるため、少し置いてから即時キャプチャする
		// （プッシュが直近まで届いている間は再描画が自動で届くため不要。
		// プッシュ購読中でも停滞している場合はキャプチャする）
		if (!(session.pushMode && Date.now() - session.lastPushFrameAt < PUSH_STALE_MS)) {
			setTimeout(() => this.captureFrame(session), 150);
		}
	}

	private cdpSend(session: MirrorSession, method: string, params: object): void {
		if (session.socket.readyState === 1) {
			session.socket.send(JSON.stringify({ id: session.nextId++, method, params }));
		}
	}

	private cdpCall(session: MirrorSession, method: string, params: object, onResult: (result: unknown) => void): void {
		if (session.socket.readyState !== 1) {
			// 呼び出し元の状態(captureInFlight等)を固着させないため、必ずコールバックする
			onResult(undefined);
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
