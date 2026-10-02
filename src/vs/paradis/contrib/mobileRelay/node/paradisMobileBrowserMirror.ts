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

import { decodeBase64 } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisCdpFrameEvent, IParadisCdpFrameSubscription, IParadisSharedPageBindings } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisCdpUpstream } from '../../agentBrowser/node/paradisCdpUpstream.js';
import { paradisMobileBrowserKeyEvents } from '../common/paradisMobileBrowserKeys.js';
import { paradisResolveMobileBrowserAddress } from '../common/paradisMobileBrowserAddress.js';
import { ParadisMobileCapability } from '../common/paradisMobileCompat.js';
import {
	IParadisMobileBrowserPageState,
	PARADIS_MOBILE_FOCUS_BINDING,
	PARADIS_MOBILE_FOCUS_REPORT_TAP_EXPRESSION,
	PARADIS_MOBILE_FOCUS_DISPOSE_EXPRESSION,
	PARADIS_MOBILE_FOCUS_REPORT_CURRENT_EXPRESSION,
	PARADIS_MOBILE_FOCUS_SCRIPT,
	PARADIS_MOBILE_FOCUS_WORLD,
	paradisMobileFocusSelectExpression,
	paradisMobileBrowserHistoryState,
	paradisMobileBrowserLifecycleProgress,
	paradisMobileBrowserPageMessage,
	paradisNormalizeMobileBrowserFocusReport,
} from '../common/paradisMobileBrowserPageState.js';
import { IParadisMobileBrowserFocus, IParadisMobileBrowserInputRejected, PARADIS_MOBILE_BROWSER_INPUT_TEXT_MAX } from '../common/paradisMobileBrowserProtocol.js';
import { paradisIsMobileBrowserTargetId, paradisMobileBrowserTargetsScope } from '../common/paradisMobileBrowserScope.js';

/** モバイル→PC の browser チャネル要求。 */
type BrowserInbound =
	| {
		t: 'targets'; id: string;
		/** browser.space.v1: このウィンドウの、このスペース（`sourceId`）のページだけを返す。古いアプリは送らない。 */
		windowId?: unknown; ws?: unknown;
	}
	| {
		t: 'start'; id: string; targetId: unknown; frameEncoding?: string;
		/** browser.space.v1: 台帳があれば、このスペースのページでなければ断る。 */
		windowId?: unknown; ws?: unknown;
	}
	| { t: 'stop'; id: string }
	| {
		t: 'input'; kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text' | 'navigate' | 'key' | 'stop' | 'open' | 'replace';
		/** tap/scroll: 直近フレームに対する正規化座標(0..1)。 */
		nx?: number; ny?: number;
		/** scroll: 正規化スクロール量（dy: 正=下へ、dx: 正=右へ）。 */
		dy?: number;
		dx?: number;
		/** text: 入れる文字。open: アドレス欄の生の文字（browser.page.v1）。replace: 欄の新しい中身（browser.focus.v1）。 */
		text?: string;
		/** navigate: 遷移先URL（http/httpsのみ受け付ける）。 */
		url?: string;
		/** key: 特殊キーの名前（`paradisMobileBrowserKeys.ts` の許可リストにあるものだけ送る。`browser.keys.v1`）。 */
		key?: unknown;
		/** key: Shift を押しながら（`true` のときだけ）。 */
		shift?: unknown;
		/** replace: 置き換える欄の番号（`focus` の `fieldId`。browser.focus.v1）。 */
		fieldId?: unknown;
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
	/** Mobileが明示した場合だけBase64を外してbinary JPEG v1を送る。 */
	binaryFrames: boolean;
	send: (payload: Uint8Array) => void;
	/** メインフレームの ID（`Page.getFrameTree`・`frameNavigated` で更新）。 */
	mainFrameId?: string;
	/** ページの状態（browser.page.v1）と、最後に送った署名。 */
	page?: IParadisMobileBrowserPageState;
	pageSignature?: string;
	lastHistoryAt?: number;
	/** フォーカスを見張るか（アプリが browser.focus.v1 を広告しているときだけ）。 */
	focusTracking?: boolean;
	/** フォーカスの注入スクリプトを動かしている分離ワールドの文脈 ID（browser.focus.v1）。 */
	focusContextId?: number;
	focusSeq?: number;
	/** 最後にモバイルのタップを送った時刻。 */
	lastTapAt?: number;
	lastFocusSignature?: string;
	/** 次のフォーカスの報告を、重複でも送る（置き換えを断った後の知らせ直し）。 */
	forceNextFocus?: boolean;
}

/** ミラーへ RelayService から渡す道具。どれも無ければ従来の動き。 */
export interface IParadisMobileBrowserMirrorOptions {
	/** 設定 `workbench.browser.searchEngine` の今の値（browser.page.v1 の `open`）。 */
	readonly resolveSearchEngine?: () => unknown;
	/**
	 * そのウィンドウの、そのスペースのページの targetId（browser.space.v1）。台帳が無ければ `undefined`
	 * （そのときは全件を返す）。
	 */
	readonly resolveSpaceTargetIds?: (windowId: number, ws: string) => Promise<ReadonlySet<string> | undefined>;
	/** そのモバイルがその capability を広告しているか（browser.focus.v1 の `focus` を送ってよいか）。 */
	readonly mobileHasCapability?: (mobileId: string, name: string) => Promise<boolean>;
}

// 変化が無いフレームは送信しない（下記）ため、間隔は短めでも帯域を圧迫しない
const CAPTURE_INTERVAL_MS = 250;
// プッシュ購読中にこれ以上フレームが無い場合、ポーリングで1枚キャプチャする
// （非表示・最小化中はペイントが起きずプッシュが止まるため）
const PUSH_STALE_MS = 1500;
const CDP_CALL_TIMEOUT_MS = 5000;
/** タップを送ってから、今のフォーカスを読むまでの待ち（ページのフォーカス処理が終わるのを待つ）。 */
const FOCUS_AFTER_TAP_MS = 150;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BROWSER_JPEG_BINARY_ENCODING = 'jpeg-binary-v1';
const BROWSER_JPEG_BINARY_HEADER_BYTES = 12;

function encodeBrowserFrame(data: string, w: number, h: number, binary: boolean): Uint8Array {
	if (!binary) {
		return encoder.encode(JSON.stringify({ t: 'frame', data, w, h }));
	}
	try {
		const jpeg = decodeBase64(data);
		const payload = new Uint8Array(BROWSER_JPEG_BINARY_HEADER_BYTES + jpeg.byteLength);
		payload.set([0x50, 0x4a, 0x46, 0x01], 0); // "PJF" + wire version 1
		const view = new DataView(payload.buffer);
		view.setUint32(4, w, false);
		view.setUint32(8, h, false);
		payload.set(jpeg.buffer, BROWSER_JPEG_BINARY_HEADER_BYTES);
		return payload;
	} catch {
		// 内部CDPが万一不正Base64を返しても、従来JSON経路の配送挙動を維持する。
		return encoder.encode(JSON.stringify({ t: 'frame', data, w, h }));
	}
}

export class ParadisMobileBrowserMirror extends Disposable {

	/** mobileId → 稼働中のミラーセッション。 */
	private readonly sessions = new Map<string, MirrorSession>();

	constructor(
		private readonly upstream: ParadisCdpUpstream,
		private readonly cdpFrames: IParadisCdpFrameSubscription | undefined,
		private readonly sharedPageBindings: IParadisSharedPageBindings | undefined,
		private readonly logService: ILogService,
		private readonly options: IParadisMobileBrowserMirrorOptions = {},
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
			// 同じJPEGの再描画通知は表示を変えない。生存時刻だけは上で更新し、
			// プッシュ停滞と誤認してポーリングへフォールバックしないようにする。
			if (session.lastFrameData === e.data) {
				continue;
			}
			// フォールバックポーリングが同一フレームを再送しないようdedup基準も更新する。
			session.lastFrameData = e.data;
			session.send(encodeBrowserFrame(e.data, e.w, e.h, session.binaryFrames));
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
			// 分離ワールドは次のミラーが使い回すので、リスナーだけ外しておく（溜めない）。
			if (session.focusContextId !== undefined) {
				this.cdpSend(session, 'Runtime.evaluate', { expression: PARADIS_MOBILE_FOCUS_DISPOSE_EXPRESSION, contextId: session.focusContextId });
				session.focusContextId = undefined;
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
				// ターミナルペインへ共有中のページ（agentBrowserのバインディング）の targetId →
				// ペイントークン対応。モバイル側が「このエージェントと共有中のタブ」を優先表示する
				// ために使う。取得失敗（未解決・サービス未生成）は共有情報なしとして続行する。
				const sharedTokens = new Map<string, string>();
				try {
					const bindings = await this.sharedPageBindings?.listBoundCdpTargets() ?? [];
					for (const binding of bindings) {
						sharedTokens.set(binding.targetId, binding.token);
					}
				} catch (err) {
					this.logService.warn('[paradisMobileBrowserMirror] failed to resolve shared page bindings', err);
				}
				// para-browser のページ = http(s) URLを持つ type='page' のターゲットのみ。
				// URLだけで絞ると、開いているページが内部に持つ iframe / service_worker /
				// worker まで別ページとして列挙されてしまう（workbench等のvscode-file
				// ウィンドウやDevTools自身も除外）
				// browser.space.v1: そのウィンドウのそのスペースのページだけ。台帳が無ければ従来どおり全件。
				const scope = paradisMobileBrowserTargetsScope(msg);
				if (scope === 'invalid') {
					// スペースを付けてきたのに読めない（長すぎる等）。黙って全件に戻さず、絞れないと返す。
					reply({ id: msg.id, error: 'invalid-scope' });
					return;
				}
				let allowed: ReadonlySet<string> | undefined;
				if (scope !== undefined && this.options.resolveSpaceTargetIds !== undefined) {
					try {
						allowed = await this.options.resolveSpaceTargetIds(scope.windowId, scope.ws);
					} catch (err) {
						this.logService.warn('[paradisMobileBrowserMirror] failed to resolve the pages of the space', err);
					}
				}
				const targets = list
					.filter(t => t.type === 'page' && typeof t.url === 'string' && /^https?:\/\//.test(t.url as string))
					.filter(t => allowed === undefined || allowed.has(String(t.id)))
					.map(t => {
						const sharedToken = sharedTokens.get(String(t.id));
						return {
							targetId: String(t.id), title: String(t.title ?? ''), url: String(t.url),
							...(sharedToken !== undefined ? { sharedToken } : {}),
						};
					});
				reply({ id: msg.id, t: 'targets', ...(allowed !== undefined ? { scoped: true } : {}), targets });
			} else if (msg.t === 'start') {
				const targetId = await this.validateStartTarget(msg);
				await this.start(mobileId, targetId, send, msg.frameEncoding === BROWSER_JPEG_BINARY_ENCODING);
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

	/**
	 * `start` の targetId を確かめる。形式が正しく、`/json/list` の http(s) のページで、スペースが付いていて
	 * 台帳があるならそのスペースのページであること。違えば例外（モバイルへは `{ error }` で返る）。
	 */
	private async validateStartTarget(msg: Extract<BrowserInbound, { t: 'start' }>): Promise<string> {
		const targetId = msg.targetId;
		if (!paradisIsMobileBrowserTargetId(targetId)) {
			throw new Error('invalid target');
		}
		const list = await this.upstream.fetchJson('/json/list') as Array<Record<string, unknown>>;
		if (!Array.isArray(list) || !list.some(t => String(t.id) === targetId && t.type === 'page' && typeof t.url === 'string' && /^https?:\/\//.test(t.url))) {
			throw new Error('unknown target');
		}
		const scope = paradisMobileBrowserTargetsScope(msg);
		if (scope === 'invalid') {
			throw new Error('invalid-scope');
		}
		if (scope !== undefined && this.options.resolveSpaceTargetIds !== undefined) {
			const allowed = await this.options.resolveSpaceTargetIds(scope.windowId, scope.ws).catch(() => undefined);
			if (allowed !== undefined && !allowed.has(targetId)) {
				throw new Error('target-not-in-space');
			}
		}
		return targetId;
	}

	private async start(mobileId: string, targetId: string, send: (payload: Uint8Array) => void, binaryFrames = false): Promise<void> {
		this.stopSession(mobileId);
		const port = await this.upstream.resolvePort();
		if (!port) {
			throw new Error('ブラウザのCDPエンドポイントが見つかりません');
		}
		const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
		const session: MirrorSession = {
			socket, targetId, nextId: 1, viewWidth: 0, viewHeight: 0,
			captureTimer: undefined, captureInFlight: false, lastFrameData: undefined, handlers: new Map(),
			pushMode: false, pushStarted: false, lastPushFrameAt: 0, lastMetricsAt: 0, binaryFrames, send,
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
				const cdp = JSON.parse(data) as { id?: number; result?: unknown; method?: string; params?: unknown };
				if (cdp.id !== undefined) {
					const handler = session.handlers.get(cdp.id);
					if (handler) {
						session.handlers.delete(cdp.id);
						handler(cdp.result);
					}
				} else if (typeof cdp.method === 'string') {
					this.onCdpEvent(session, cdp.method, (cdp.params ?? {}) as Record<string, unknown>);
				}
			} catch { /* ignore malformed CDP */ }
		};
		socket.onclose = () => {
			if (this.sessions.get(mobileId) === session) {
				this.stopSession(mobileId);
			}
		};

		this.cdpSend(session, 'Page.enable', {});
		// フォーカスの通知（欄の中身を含む）は、受けると広告したアプリにだけ送る。
		let focusTracking = false;
		try {
			focusTracking = await this.options.mobileHasCapability?.(mobileId, ParadisMobileCapability.BrowserFocus) ?? false;
		} catch { /* 分からなければ送らない */ }
		if (this.sessions.get(mobileId) !== session) {
			return;
		}
		session.focusTracking = focusTracking;
		this.startPageTracking(session);
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
		} else {
			this.captureFrame(session);
		}
		// 題名の変化（SPA の document.title など）はイベントで来ないので、約 1 秒ごとに履歴を読み直す。
		if (session.page !== undefined && Date.now() - (session.lastHistoryAt ?? 0) >= 1000) {
			this.refreshHistory(session);
		}
	}

	// #region ページの状態（browser.page.v1）とフォーカス（browser.focus.v1）

	/**
	 * ページの状態とフォーカスの見張りを始める。古いアプリは `page` / `focus` を読まずに捨てるので、
	 * 能力の交渉はしない（送るのは変化のあったときだけで小さい）。
	 */
	private startPageTracking(session: MirrorSession): void {
		session.page = { url: '', title: '', loading: false, progress: 1, canGoBack: false, canGoForward: false };
		session.focusSeq = 0;
		this.cdpSend(session, 'Page.setLifecycleEventsEnabled', { enabled: true });
		this.cdpCall(session, 'Page.getFrameTree', {}, result => {
			const frameId = (result as { frameTree?: { frame?: { id?: unknown } } } | undefined)?.frameTree?.frame?.id;
			if (typeof frameId !== 'string' || this.sessionOf(session) === undefined) {
				return;
			}
			session.mainFrameId = frameId;
			if (session.focusTracking === true) {
				this.startFocusTracking(session, frameId);
			}
		});
		this.refreshHistory(session);
	}

	/**
	 * フォーカスの見張り（browser.focus.v1）。分離ワールドは 1 ページに 1 つにする: `Runtime.enable` は今ある
	 * 文脈を全部知らせてくるので、前のミラーが作った同じ名前のワールドがメインフレームにあればそれを使い回し、
	 * 無いときだけ作る（ミラーを張り直すたびにワールドとリスナーが増えないように）。
	 */
	private startFocusTracking(session: MirrorSession, frameId: string): void {
		this.cdpSend(session, 'Runtime.addBinding', { name: PARADIS_MOBILE_FOCUS_BINDING, executionContextName: PARADIS_MOBILE_FOCUS_WORLD });
		this.cdpSend(session, 'Page.addScriptToEvaluateOnNewDocument', { source: PARADIS_MOBILE_FOCUS_SCRIPT, worldName: PARADIS_MOBILE_FOCUS_WORLD });
		this.cdpCall(session, 'Runtime.enable', {}, () => {
			if (this.sessionOf(session) === undefined) {
				return;
			}
			const install = (contextId: number) => {
				session.focusContextId = contextId;
				this.cdpSend(session, 'Runtime.evaluate', { expression: PARADIS_MOBILE_FOCUS_SCRIPT, contextId });
			};
			if (session.focusContextId !== undefined) {
				install(session.focusContextId);
				return;
			}
			// 今の文書には addScriptToEvaluateOnNewDocument が効かないので、分離ワールドを作って入れる。
			this.cdpCall(session, 'Page.createIsolatedWorld', { frameId, worldName: PARADIS_MOBILE_FOCUS_WORLD }, created => {
				const contextId = (created as { executionContextId?: unknown } | undefined)?.executionContextId;
				if (typeof contextId === 'number' && this.sessionOf(session) !== undefined) {
					install(contextId);
				}
			});
		});
	}

	private sessionOf(session: MirrorSession): MirrorSession | undefined {
		for (const candidate of this.sessions.values()) {
			if (candidate === session) {
				return candidate;
			}
		}
		return undefined;
	}

	private onCdpEvent(session: MirrorSession, method: string, params: Record<string, unknown>): void {
		const page = session.page;
		if (page === undefined) {
			return;
		}
		const isMain = (frameId: unknown) => session.mainFrameId === undefined || frameId === session.mainFrameId;
		switch (method) {
			case 'Page.frameStartedLoading':
				if (isMain(params.frameId)) {
					page.loading = true;
					page.progress = 0.1;
					this.emitPage(session);
				}
				break;
			case 'Page.lifecycleEvent':
				if (isMain(params.frameId) && page.loading) {
					page.progress = paradisMobileBrowserLifecycleProgress(page.progress, params.name);
					this.emitPage(session);
				}
				break;
			case 'Page.frameStoppedLoading':
				if (isMain(params.frameId)) {
					page.loading = false;
					page.progress = 1;
					this.emitPage(session);
					this.refreshHistory(session);
				}
				break;
			case 'Page.frameNavigated': {
				const frame = params.frame as { id?: unknown; parentId?: unknown; url?: unknown; urlFragment?: unknown } | undefined;
				if (frame !== undefined && frame.parentId === undefined) {
					if (typeof frame.id === 'string') {
						session.mainFrameId = frame.id;
					}
					// 文書が替わった。前の文書の欄は無くなったので、フォーカスが外れたと知らせる。
					this.emitDocumentChanged(session);
					if (typeof frame.url === 'string') {
						page.url = frame.url + (typeof frame.urlFragment === 'string' ? frame.urlFragment : '');
						this.emitPage(session);
					}
					this.refreshHistory(session);
				}
				break;
			}
			case 'Page.navigatedWithinDocument':
				if (isMain(params.frameId) && typeof params.url === 'string') {
					page.url = params.url;
					this.emitPage(session);
					this.refreshHistory(session);
				}
				break;
			case 'Runtime.executionContextCreated': {
				// メインフレームの自分の名前のワールドだけ（iframe の中の同じ名前のワールドは使わない）。
				const context = params.context as { id?: unknown; name?: unknown; auxData?: { frameId?: unknown } } | undefined;
				if (session.focusTracking === true && context?.name === PARADIS_MOBILE_FOCUS_WORLD && typeof context.id === 'number'
					&& session.mainFrameId !== undefined && context.auxData?.frameId === session.mainFrameId) {
					session.focusContextId = context.id;
				}
				break;
			}
			case 'Runtime.executionContextDestroyed':
				if (params.executionContextId === session.focusContextId) {
					session.focusContextId = undefined;
				}
				break;
			case 'Runtime.executionContextsCleared':
				session.focusContextId = undefined;
				this.emitDocumentChanged(session);
				break;
			case 'Runtime.bindingCalled':
				// 自分のワールド（メインフレーム）からの報告だけ。iframe の中のワールドや、ほかの文脈は捨てる。
				if (params.name === PARADIS_MOBILE_FOCUS_BINDING && session.focusContextId !== undefined && params.executionContextId === session.focusContextId) {
					this.onFocusReport(session, params.payload);
				}
				break;
		}
	}

	private refreshHistory(session: MirrorSession): void {
		session.lastHistoryAt = Date.now();
		this.cdpCall(session, 'Page.getNavigationHistory', {}, result => {
			const history = paradisMobileBrowserHistoryState(result);
			if (history === undefined || session.page === undefined) {
				return;
			}
			Object.assign(session.page, history);
			this.emitPage(session);
		});
	}

	private emitPage(session: MirrorSession): void {
		if (session.page === undefined || this.sessionOf(session) === undefined) {
			return;
		}
		const message = paradisMobileBrowserPageMessage(session.targetId, session.page);
		const signature = JSON.stringify(message);
		if (signature === session.pageSignature) {
			return;
		}
		session.pageSignature = signature;
		session.send(encoder.encode(signature));
	}

	private onFocusReport(session: MirrorSession, payload: unknown): void {
		if (this.sessionOf(session) === undefined) {
			return;
		}
		const seq = (session.focusSeq ?? 0) + 1;
		const message = paradisNormalizeMobileBrowserFocusReport(payload, { targetId: session.targetId, seq, now: Date.now(), lastTapAt: session.lastTapAt ?? 0 });
		if (message === undefined) {
			return;
		}
		// 同じ中身の続けての通知（input の間引き後に値が変わっていない等）は送らない。タップの結果は必ず送る
		// （アプリはそれを見てキーボードを開く）。
		const signature = JSON.stringify({ ...message, seq: 0, fromTap: undefined });
		if (signature === session.lastFocusSignature && message.fromTap !== true && session.forceNextFocus !== true) {
			return;
		}
		session.forceNextFocus = false;
		session.lastFocusSignature = signature;
		session.focusSeq = seq;
		session.send(encoder.encode(JSON.stringify(message)));
	}

	/**
	 * メインフレームの文書が替わった（遷移・読み直し）。捨てられた文書からは `focused: false` が届かないので、
	 * ここで送る。重複排除の控えも消す（新しい文書の最初の報告を落とさない）。
	 */
	private emitDocumentChanged(session: MirrorSession): void {
		if (session.focusTracking !== true || this.sessionOf(session) === undefined) {
			return;
		}
		session.lastFocusSignature = undefined;
		const seq = (session.focusSeq ?? 0) + 1;
		session.focusSeq = seq;
		const message: IParadisMobileBrowserFocus = { t: 'focus', targetId: session.targetId, seq, focused: false };
		session.send(encoder.encode(JSON.stringify(message)));
	}

	/** タップの後に、今のフォーカスを分離ワールドに報告させる（既にフォーカスのある欄をタップしたとき用）。 */
	private reportFocusAfterTap(session: MirrorSession): void {
		session.lastTapAt = Date.now();
		setTimeout(() => {
			if (this.sessionOf(session) !== undefined && session.focusContextId !== undefined) {
				this.cdpSend(session, 'Runtime.evaluate', { expression: PARADIS_MOBILE_FOCUS_REPORT_TAP_EXPRESSION, contextId: session.focusContextId });
			}
		}, FOCUS_AFTER_TAP_MS);
	}

	/**
	 * `fieldId` の欄にフォーカスがあるときだけ、その中身を `text` で置き換える（browser.focus.v1 の `replace`）。
	 * 欄が替わっていたら置き換えずに断り、今のフォーカスを知らせ直す。
	 */
	private replaceFocusedValue(session: MirrorSession, fieldId: number, text: string): void {
		if (session.focusContextId === undefined) {
			this.rejectInput(session, 'replace', 'field-changed');
			return;
		}
		const contextId = session.focusContextId;
		this.cdpCall(session, 'Runtime.evaluate', { expression: paradisMobileFocusSelectExpression(fieldId), contextId, returnByValue: true }, result => {
			if ((result as { result?: { value?: unknown } } | undefined)?.result?.value !== true) {
				this.rejectInput(session, 'replace', 'field-changed');
				// 知らせ直しは、前と同じ中身でも送る（アプリは断られた後の欄の様子を知りたい）。
				session.forceNextFocus = true;
				this.cdpSend(session, 'Runtime.evaluate', { expression: PARADIS_MOBILE_FOCUS_REPORT_CURRENT_EXPRESSION, contextId });
				return;
			}
			if (text.length > 0) {
				this.cdpSend(session, 'Input.insertText', { text });
			} else {
				for (const keyParams of paradisMobileBrowserKeyEvents('Backspace', undefined, isMacintosh) ?? []) {
					this.cdpSend(session, 'Input.dispatchKeyEvent', keyParams);
				}
			}
		});
	}

	private rejectInput(session: MirrorSession, kind: IParadisMobileBrowserInputRejected['kind'], reason: IParadisMobileBrowserInputRejected['reason']): void {
		if (this.sessionOf(session) === undefined) {
			return;
		}
		const message: IParadisMobileBrowserInputRejected = { t: 'inputRejected', targetId: session.targetId, kind, reason };
		session.send(encoder.encode(JSON.stringify(message)));
	}

	// #endregion

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
					session.send(encodeBrowserFrame(data, session.viewWidth, session.viewHeight, session.binaryFrames));
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
				this.reportFocusAfterTap(session);
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
			if (msg.text.length > PARADIS_MOBILE_BROWSER_INPUT_TEXT_MAX) {
				this.rejectInput(session, 'text', 'too-long');
			} else {
				this.cdpSend(session, 'Input.insertText', { text: msg.text });
			}
		} else if (msg.kind === 'navigate' && msg.url && /^https?:\/\//i.test(msg.url)) {
			this.cdpSend(session, 'Page.navigate', { url: msg.url });
		} else if (msg.kind === 'stop') {
			this.cdpSend(session, 'Page.stopLoading', {});
		} else if (msg.kind === 'open' && typeof msg.text === 'string' && msg.text.length > PARADIS_MOBILE_BROWSER_INPUT_TEXT_MAX) {
			this.rejectInput(session, 'open', 'too-long');
		} else if (msg.kind === 'open') {
			// URL か検索かは PC のアドレスバーと同じ判定と検索エンジンの設定で決める（http(s) だけ開く）。
			const url = paradisResolveMobileBrowserAddress(msg.text, this.options.resolveSearchEngine?.());
			if (url !== undefined) {
				this.cdpSend(session, 'Page.navigate', { url });
			}
		} else if (msg.kind === 'replace' && typeof msg.text === 'string') {
			if (msg.text.length > PARADIS_MOBILE_BROWSER_INPUT_TEXT_MAX) {
				this.rejectInput(session, 'replace', 'too-long');
			} else if (typeof msg.fieldId !== 'number' || !Number.isSafeInteger(msg.fieldId) || msg.fieldId <= 0) {
				// 欄を名指ししない置き換えはしない（別の欄の中身を上書きしうるため）。
				this.rejectInput(session, 'replace', 'field-changed');
			} else {
				this.replaceFocusedValue(session, msg.fieldId, msg.text);
			}
		} else if (msg.kind === 'key') {
			for (const params of paradisMobileBrowserKeyEvents(msg.key, msg.shift, isMacintosh) ?? []) {
				this.cdpSend(session, 'Input.dispatchKeyEvent', params);
			}
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
