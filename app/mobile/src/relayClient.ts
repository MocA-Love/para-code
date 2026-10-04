// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイル側のリレー接続クライアント（トランスポート非依存の中核ロジック）。
 *
 * 責務:
 *  - リレーへ role=mobile で WebSocket 接続
 *  - イニシエータとして E2E ハンドシェイク（相手=PCの静的公開鍵は保存済み前提）
 *  - 確立後は FrameMux で state/term/scm/fs/browser/notify を多重化
 *  - presence 制御メッセージ（PCのオンライン状態）の反映
 *  - 切断時の再接続（間隔は relayRetryDelays.ts。リレーが資格を拒んだら分単位の遅い再確認へ落とす）
 *
 * WebSocket 実装は注入する（React Native の global WebSocket / テストのfake双方に対応）。
 */

import {
	type ChannelId,
	type Frame,
	type FrameChunkTiming,
	FrameMux,
	type Identity,
	createInitiator,
	decodeRelayControl,
	encodeRelayControl,
} from '@para/protocol';
import { reportMobileDiagnosticError } from './mobileDiagnostics.js';
import { RELAY_STABLE_CONNECTION_MS, isRelayAuthRejection, relayAuthGateDelayMs, relayReconnectDelayMs } from './relayRetryDelays.js';

/** 最小限の WebSocket インターフェース（RNのWebSocketと互換）。 */
export interface SocketLike {
	send(data: string | ArrayBufferView | ArrayBuffer): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	/** RN の WebSocket は CloseEvent を渡す。close code は切断理由の唯一の手掛かり。 */
	onclose: ((event?: { code?: number; reason?: string }) => void) | null;
	onerror: ((error: unknown) => void) | null;
	onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
	binaryType?: string;
}

// protocols: WebSocketサブプロトコル（finding #7 で認証トークンを `para-auth.<token>` として
// 載せるために使う。RNのWebSocketは第2引数に string|string[] を取れる）。
export type SocketFactory = (url: string, protocols?: string | string[]) => SocketLike;

export interface PairedCredentials {
	readonly relayUrl: string;
	readonly deviceId: string;
	readonly mobileId: string;
	readonly mobileToken: string;
	/** PCの長期公開鍵（ハンドシェイクの相手鍵）。 */
	readonly pcPublicKey: Uint8Array;
}

export type ConnectionState = 'connecting' | 'handshaking' | 'online' | 'offline';

/**
 * 接続の記録（W2-22。設定 →「接続の記録」）へ残す出来事。**秘密を含めない**（トークン・URL・識別子は
 * 載せない。`detail` は OS のエラー文で、記録する側 `connectionLog.ts` が伏せ字にしてから残す）。
 */
export interface RelayConnectionEvent {
	readonly kind: 'connecting' | 'online' | 'closed' | 'connect-timeout' | 'socket-error' | 'auth-rejected' | 'reconnect-scheduled' | 'suspended' | 'resumed' | 'pc-presence' | 'pc-restarted';
	readonly code?: number;
	readonly delayMs?: number;
	readonly attempt?: number;
	readonly online?: boolean;
	readonly detail?: string;
}

export interface RelayClientCallbacks {
	readonly onStateChange?: (state: ConnectionState) => void;
	/** PC自身のpresence（PCがリレーに繋がっているか）。 */
	readonly onPcPresence?: (online: boolean) => void;
	readonly onFrame?: (frame: Frame) => void;
	/** 計測用。チャンク1つを開封した直後（再結合の前）に呼ぶ（`FrameMuxOptions.onChunkOpened`）。 */
	readonly onFrameChunk?: (chunk: FrameChunkTiming) => void;
	readonly onError?: (error: unknown) => void;
	/**
	 * リレーがこの端末の資格を認めなかった（4401 / 4404 で閉じた）/ 再び繋がった。
	 * true の間は再ペアリングが必要で、再接続は1〜15分おきの確認に落ちる。
	 */
	readonly onAuthRejected?: (rejected: boolean) => void;
	/** 接続の記録（W2-22）。記録するだけで、振る舞いは変えない。 */
	readonly onConnectionEvent?: (event: RelayConnectionEvent) => void;
}

export interface Timers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

// 接続開始〜E2E確立までの上限。RNのWebSocketは接続失敗やPC不在時にonclose/oncloseが
// 届かないまま黙り込むことがあり、これが無いと'connecting'/'handshaking'で永久に止まる。
const CONNECT_TIMEOUT_MS = 12_000;
/**
 * 接続失敗をSentryへ報告するまでに要求する連続失敗回数。
 *
 * 電車での圏外や画面復帰直後の一過性の失敗は、ユーザーから見れば「一瞬オフライン表示が出た」
 * だけの正常系で、1回ごとにerrorとして上げると本物の障害がそのノイズに埋もれる。PC側は同じ
 * 問題を「60秒の猶予内に復帰できなければ報告する」で解いているが（paradisMobileRelayService
 * の RELAY_DISCONNECT_REPORT_DELAY_MS）、モバイルはOSにいつ凍結されるか分からないため
 * タイマーで猶予を測れない。代わりに「何回連続で失敗したか」で同じ振り分けをする。
 *
 * 3回＝接続上限12秒＋バックオフ(0.5s→1s→2s)で概ね40秒。一過性の切断なら必ず復帰している。
 */
const RELAY_REPORT_AFTER_ATTEMPTS = 3;

export class RelayClient {
	private socket: SocketLike | null = null;
	private mux: FrameMux | null = null;
	private state: ConnectionState = 'offline';
	private closedByUser = false;
	/**
	 * PCが戻ってきたので自分から張り直した切断か。異常系ではないので記録しない。
	 *
	 * RN の WebSocket はローカル発の close code を 0 に潰すため、`onclose` の code では
	 * 「自分で閉じた」と「切られた」を区別できない。案F でこの張り直しの頻度が上がったので、
	 * 抑止しないと `unexpected-close-0` が Sentry のノイズになる。
	 */
	private closedForPcRestart = false;
	private suspended = false;
	/**
	 * 裏に回ったあとも、いまのソケットだけを保っている（W2-34）。この間は張り直さない:
	 * 切れたら・張り直そうとしたら、その場で suspend と同じ状態に落とす。張り直した接続は PC から見て
	 * 「前面のアプリ」になり、裏にいる間の通知がプッシュにならないため。
	 */
	private backgroundHold = false;
	/** 破棄済みソケットにキューされていたコールバックを無効化する世代番号。 */
	private socketGeneration = 0;
	private reconnectAttempt = 0;
	private reconnectHandle: unknown = null;
	private connectTimeoutHandle: unknown = null;
	/** いまの接続がE2E確立した時刻。短命な接続で再試行の回数を戻さないために使う。 */
	private onlineSince: number | undefined;
	/** リレーに続けて資格を拒まれた回数（0 = 拒まれていない）。 */
	private authRejectedStreak = 0;
	/** 認証拒否のあと、次に確かめてよい時刻。これより前は前面復帰や心拍でも繋ぎ直さない。 */
	private authGateUntil: number | undefined;
	/** 最後に何かを受信した時刻（onlineのまま死んだソケットの検出用）。 */
	private lastReceivedAt = 0;
	/**
	 * いま張っているソケットについてリレーが伝えてきたPCの在否。ソケットごとに引き直す。
	 *
	 * **接続をまたいで持ち越す値をここへ流用してはいけない。** 到達できていない場合でも前回の
	 * `true` が残り「PCは居るのに繋がらない」と誤判定するし、再接続直後に届く最初の presence を
	 * offline→online の復帰と読み違えて、開いたばかりのソケットを無駄に閉じることになる。
	 * `undefined` は「リレーから presence が届いていない」＝リレーまで届いていない可能性を指す。
	 */
	private pcOnlineForCurrentSocket: boolean | undefined;

	constructor(
		private readonly identity: Identity,
		private readonly credentials: PairedCredentials,
		private readonly socketFactory: SocketFactory,
		private readonly callbacks: RelayClientCallbacks = {},
		private readonly timers: Timers = globalThis,
		private readonly random: () => number = Math.random,
		private readonly now: () => number = Date.now,
	) { }

	get connectionState(): ConnectionState {
		return this.state;
	}

	/** リレーがこの端末の資格を拒んでいる（再ペアリングが必要）。 */
	get authRejected(): boolean {
		return this.authRejectedStreak > 0;
	}

	connect(): void {
		this.closedByUser = false;
		this.suspended = false;
		this.backgroundHold = false;
		this.openSocket();
	}

	close(): void {
		this.closedByUser = true;
		this.suspended = false;
		this.backgroundHold = false;
		if (this.reconnectHandle !== null) {
			this.timers.clearTimeout(this.reconnectHandle);
			this.reconnectHandle = null;
		}
		this.clearConnectTimeout();
		this.disposeSocket(1000, 'client closed');
		this.setState('offline');
	}

	/**
	 * 裏に回ったあとも、いまのソケットを保つ（W2-34。PC が「裏に回った」を確認したときだけ呼ぶ）。
	 * 繋がっていなければ保てないので false。前面へ戻ったら {@link resume} で解く。
	 */
	holdInBackground(): boolean {
		if (this.closedByUser || this.suspended || this.state !== 'online') {
			return false;
		}
		this.backgroundHold = true;
		return true;
	}

	/**
	 * アプリがバックグラウンドへ移った時にフォアグラウンド用接続を明示的に止める。
	 * 旧ソケットへキュー済みのフレームも世代番号とハンドラ解除で破棄する。
	 */
	suspend(): void {
		if (this.closedByUser || this.suspended) {
			return;
		}
		this.backgroundHold = false;
		this.suspended = true;
		this.logEvent({ kind: 'suspended' });
		if (this.reconnectHandle !== null) {
			this.timers.clearTimeout(this.reconnectHandle);
			this.reconnectHandle = null;
		}
		this.clearConnectTimeout();
		this.disposeSocket(1000, 'app backgrounded');
		this.setState('offline');
	}

	/** フォアグラウンド復帰時に必ず有効なソケットを1本だけ確保する。 */
	resume(): void {
		this.backgroundHold = false;
		if (this.closedByUser) {
			return;
		}
		if (!this.suspended) {
			this.ensureConnected();
			return;
		}
		this.suspended = false;
		this.reconnectAttempt = 0;
		this.logEvent({ kind: 'resumed' });
		if (this.waitForAuthGate()) {
			return;
		}
		this.openSocket();
	}

	/**
	 * 未接続なら即座に接続し直す（バックオフ待ちも打ち切る）。
	 * フォアグラウンド復帰時など「今すぐ繋がってほしい」場面用。
	 * すでにonlineなら何もしない。ユーザーが明示的に切断した状態は維持する。
	 */
	ensureConnected(options?: { readonly keepBackoff?: boolean }): void {
		if (this.backgroundHold && this.state !== 'online') {
			this.suspend();
			return;
		}
		if (this.closedByUser || this.suspended || this.state === 'online') {
			return;
		}
		this.reopenSocket(options?.keepBackoff === true);
	}

	/**
	 * 'online' のまま死んでいるソケット（zombie）の検出。呼び出し側が直前に応答を伴う
	 * 要求（state要求など）を送っている前提で、timeoutMs 以内に何も受信しなければ
	 * 接続を作り直す。iOSはバックグラウンドでソケットを黙って殺し、oncloseが届かない
	 * ことがあるため、'online' 表示だけでは生存を信用できない。
	 */
	probeLiveness(timeoutMs: number = 5_000): void {
		if (this.suspended) {
			return;
		}
		if (this.state !== 'online') {
			this.ensureConnected();
			return;
		}
		const probeAt = Date.now();
		this.timers.setTimeout(() => {
			if (!this.closedByUser && !this.suspended && this.state === 'online' && this.lastReceivedAt < probeAt) {
				this.reopenSocket();
			}
		}, timeoutMs);
	}

	/**
	 * バックオフ待ちを打ち切り、既存ソケットを黙って破棄して接続し直す。
	 * `keepBackoff` なら再試行の回数を戻さない（25秒おきの心拍から来たとき。人が待っている
	 * 前面復帰やネットワークの復帰と違い、繋がらない相手へ何度でも最短の間隔から始めることになる）。
	 */
	private reopenSocket(keepBackoff = false): void {
		if (this.suspended) {
			return;
		}
		// 裏で保っている間は張り直さない（新しい接続は PC から前面のアプリに見える）。畳んで前面復帰を待つ。
		if (this.backgroundHold) {
			this.suspend();
			return;
		}
		// 資格を拒まれている間は、前面復帰や心拍（25秒おき）で叩き直さない。拒否は待っても
		// 直らないので、決めた時刻まで待つ（再ペアリングすれば新しいクライアントに替わる）。
		if (this.waitForAuthGate()) {
			return;
		}
		if (this.reconnectHandle !== null) {
			this.timers.clearTimeout(this.reconnectHandle);
			this.reconnectHandle = null;
		}
		if (!keepBackoff) {
			this.reconnectAttempt = 0;
		}
		// 死んでいる可能性のあるソケットを黙って破棄する（oncloseからの
		// 二重再接続を防ぐためハンドラを外してから閉じる）。
		this.disposeSocket(4002, 'superseded');
		this.clearConnectTimeout();
		this.openSocket();
	}

	private disposeSocket(code: number, reason: string): void {
		this.socketGeneration++;
		const stale = this.socket;
		this.socket = null;
		this.mux = null;
		if (!stale) {
			return;
		}
		stale.onopen = null;
		stale.onclose = null;
		stale.onerror = null;
		stale.onmessage = null;
		try {
			stale.close(code, reason);
		} catch { /* ignore */ }
	}

	/**
	 * 認証拒否の待ち時間の途中なら、その終わりに再確認の予約を置いて true を返す
	 * （予約が既にあれば置き直さない）。待たなくてよければ false。
	 */
	private waitForAuthGate(): boolean {
		if (this.authGateUntil === undefined) {
			return false;
		}
		const remaining = this.authGateUntil - this.now();
		if (remaining <= 0) {
			return false;
		}
		if (this.reconnectHandle === null) {
			this.setState('offline');
			this.reconnectHandle = this.timers.setTimeout(() => {
				this.reconnectHandle = null;
				if (!this.closedByUser && !this.suspended) {
					this.openSocket();
				}
			}, remaining);
		}
		return true;
	}

	private clearConnectTimeout(): void {
		if (this.connectTimeoutHandle !== null) {
			this.timers.clearTimeout(this.connectTimeoutHandle);
			this.connectTimeoutHandle = null;
		}
	}

	/** アプリ層フレームを送る（接続前は捨てられる）。 */
	send(channel: ChannelId, payload: Uint8Array, ws?: string): void {
		if (this.mux && this.state === 'online') {
			this.mux.send(channel, payload, ws);
		}
	}

	private setState(state: ConnectionState): void {
		if (this.state !== state) {
			this.state = state;
			this.callbacks.onStateChange?.(state);
		}
	}

	private wsUrl(): string {
		const base = this.credentials.relayUrl.replace(/\/$/, '');
		// finding #7: mobileTokenはクエリではなくサブプロトコル（wsProtocols）で送る。
		const params = new URLSearchParams({
			role: 'mobile',
			mobileId: this.credentials.mobileId,
		});
		return `${base}/device/${this.credentials.deviceId}/ws?${params.toString()}`;
	}

	/** 認証トークンを載せる Sec-WebSocket-Protocol サブプロトコル（finding #7）。 */
	private wsProtocols(): string {
		return `para-auth.${this.credentials.mobileToken}`;
	}

	private openSocket(): void {
		if (this.closedByUser || this.suspended) {
			return;
		}
		this.setState('connecting');
		this.logEvent({ kind: 'connecting', attempt: this.reconnectAttempt });
		let socket: SocketLike;
		try {
			socket = this.socketFactory(this.wsUrl(), this.wsProtocols());
		} catch (error) {
			reportMobileDiagnosticError('relay', 'open-socket', error, {
				phase: 'connecting',
				reconnect_count: this.reconnectAttempt,
				transport: 'websocket',
			});
			this.setState('offline');
			this.scheduleReconnect();
			return;
		}
		const generation = ++this.socketGeneration;
		const isCurrent = () => this.socket === socket && this.socketGeneration === generation;
		socket.binaryType = 'arraybuffer';
		this.socket = socket;
		this.pcOnlineForCurrentSocket = undefined;

		let established = false;
		// ハンドシェイク中に読み飛ばした「応答ではないバイナリ」の数。connect timeout の報告に
		// 載せて、黙って捨てた事実がSentryから見えるようにする。
		let skippedDuringHandshake = 0;

		// 自分がタイムアウト検知で閉じたソケットか。close code では判定できない: RNのWebSocketは
		// ローカルの close code を onclose へ往復させず 0 に潰すため、下の `socket.close(4001)` は
		// `unexpected-close-0` として届く（PC側が「operation名で区別する」としているのと同じ事情）。
		let closedByConnectTimeout = false;
		this.closedForPcRestart = false;
		// 一定時間内にE2E確立まで到達しなければ強制的に閉じる（onclose経由で再接続）。
		this.clearConnectTimeout();
		this.connectTimeoutHandle = this.timers.setTimeout(() => {
			this.connectTimeoutHandle = null;
			if (isCurrent() && this.state !== 'online') {
				if (this.shouldReportConnectFailure()) {
					reportMobileDiagnosticError('relay', 'connect-timeout', new Error('Relay connection timed out'), {
						phase: this.state,
						reconnect_count: this.reconnectAttempt,
						transport: 'websocket',
						safe_skipped_handshake_frames: skippedDuringHandshake,
						safe_pc_presence: this.pcOnlineForCurrentSocket === undefined ? 'unknown' : String(this.pcOnlineForCurrentSocket),
					});
				}
				closedByConnectTimeout = true;
				this.logEvent({ kind: 'connect-timeout' });
				try {
					socket.close(4001, 'connect timeout');
				} catch { /* ignore */ }
			}
		}, CONNECT_TIMEOUT_MS);

		const initiator = createInitiator(this.identity, this.credentials.pcPublicKey);

		socket.onopen = () => {
			if (!isCurrent()) {
				return;
			}
			this.setState('handshaking');
			// hello（自分のephemeral公開鍵）をバイナリで送る
			socket.send(toArrayBuffer(initiator.hello));
		};

		socket.onmessage = event => {
			if (!isCurrent()) {
				return;
			}
			this.lastReceivedAt = Date.now();
			if (typeof event.data === 'string') {
				this.handleControl(event.data);
				return;
			}
			const bytes = new Uint8Array(event.data);
			if (!established) {
				try {
					const { channel, confirm } = initiator.finish(bytes);
					socket.send(toArrayBuffer(confirm));
					this.mux = new FrameMux(channel, {
						sendSealed: sealed => socket.send(toArrayBuffer(sealed)),
						onError: error => this.onFatal(error),
						// 断片の組み立ての誤りはその論理フレームを捨てるだけ（復号はできているので張り直さない）
						onAssemblyError: error => console.warn('[relay] dropped a frame that could not be reassembled', error),
						...(this.callbacks.onFrameChunk !== undefined ? { onChunkOpened: this.callbacks.onFrameChunk } : {}),
					});
					if (this.callbacks.onFrame) {
						const onFrame = this.callbacks.onFrame;
						for (const ch of ['state', 'term', 'scm', 'fs', 'browser', 'notify', 'agent'] as ChannelId[]) {
							this.mux.on(ch, onFrame);
						}
					}
					established = true;
					// 回数はここでは戻さない（RELAY_STABLE_CONNECTION_MS 続いた接続が切れたときに戻す）。
					this.onlineSince = this.now();
					this.clearConnectTimeout();
					if (this.authRejectedStreak > 0) {
						this.authRejectedStreak = 0;
						this.authGateUntil = undefined;
						this.callbacks.onAuthRejected?.(false);
					}
					this.logEvent({ kind: 'online' });
					this.setState('online');
				} catch (error) {
					// ここへ来る最頻ケースは「PCがまだ再接続に気づいていない」ことによる取りこぼしで、
					// 壊れた相手ではない。リレーは同一mobileIdの旧ソケットを閉じてから新ソケットを
					// 受理し、PCへは presence online:true しか送らない（旧ソケットのclose由来のofflineは
					// 残ソケット数が0のときだけなので飛ばない）。そのためPCは古いSecureChannelを保持した
					// ままで、こちらが hello を送るより前に送出済みのフレームが新ソケットへ届く。
					// established前のバイナリを無条件に応答とみなすと、それを封緘ackとして開封して
					// nonce不一致で落ち、接続をやり直す羽目になる（＝復帰直後に一瞬オフラインになる）。
					// PC側には「復号できない32Bは新しいhello」という自己修復があるので、こちらは
					// 読み飛ばして正規の応答を待てばよい。相手が本当に壊れている場合（鍵の食い違い等）は
					// 応答が永遠に来ないが、それは connect timeout が拾う。
					skippedDuringHandshake++;
					return;
				}
				return;
			}
			this.mux?.receive(bytes);
		};

		let sawSocketError = false;
		socket.onerror = error => {
			if (isCurrent()) {
				sawSocketError = true;
				this.logEvent({ kind: 'socket-error', detail: errorMessage(error) });
				reportMobileDiagnosticError('relay', 'socket-error', error, {
					phase: this.state,
					reconnect_count: this.reconnectAttempt,
					transport: 'websocket',
				});
				this.callbacks.onError?.(error);
			}
		};
		socket.onclose = event => {
			if (isCurrent()) {
				if (isRelayAuthRejection(event?.code)) {
					this.logEvent({ kind: 'auth-rejected', code: event?.code });
					// 異常系ではなく「再ペアリングが必要」という確定した状態なので、エラーとして積まない
					// （拒否は1〜15分おきに確かめ直すたびに起きる）。
					this.authRejectedStreak++;
					if (this.authRejectedStreak === 1) {
						this.callbacks.onAuthRejected?.(true);
					}
					this.onClosed();
					return;
				}
				this.logEvent({ kind: 'closed', code: event?.code ?? 0 });
				// onerror を伴わない切断（リレー側の superseded、iOS のバックグラウンド回収）は
				// これまで一切記録が残らず、同じ事象がPC側の close code だけで語られる非対称に
				// なっていた。onerror 済みのときと、自分がタイムアウトで閉じたとき（直前に
				// connect-timeout を出す判断を済ませている）は二重計上しない。
				if (!sawSocketError && !closedByConnectTimeout && !this.closedForPcRestart && !this.closedByUser && !this.suspended) {
					const code = event?.code ?? 0;
					reportMobileDiagnosticError('relay', `unexpected-close-${code}`, new Error(`Relay connection closed (code ${code})`), {
						phase: this.state,
						reconnect_count: this.reconnectAttempt,
						transport: 'websocket',
						safe_close_code: code,
					});
				}
				this.onClosed();
			}
		};
	}

	private handleControl(text: string): void {
		try {
			const msg = decodeRelayControl(text);
			if (msg.type === 'presence' && msg.peer === 'pc') {
				// 「このソケットが開いている間にPCが居なくなって戻ってきた」かどうかで判断する。
				// `lastPcOnline` は接続をまたいで持ち越すので、ここには使えない（再接続の直後に
				// 届く最初の presence を offline→online と読み違え、開いたばかりのソケットを
				// 無駄に閉じてしまう）。`undefined` ＝ このソケットで最初の presence なので、
				// 持ち越された状態は無く、張り直す理由も無い。
				const wasOnlineOnThisSocket = this.pcOnlineForCurrentSocket;
				// リレーはモバイルのソケットを受理した直後に必ず現在のPC在否を送る（deviceDOのacceptMobile）。
				// つまりE2Eハンドシェイクが始まる前にこの値は埋まる。
				this.pcOnlineForCurrentSocket = msg.online;
				if (wasOnlineOnThisSocket !== msg.online) {
					this.logEvent({ kind: 'pc-presence', online: msg.online });
				}
				this.callbacks.onPcPresence?.(msg.online);
				// PCがoffline→onlineへ戻った = PC側プロセスが再起動し、E2Eセッション（ephemeral鍵）
				// が新しくなった。モバイル側のソケットはリレーDOに保持されたまま生きているため、
				// 旧セッション鍵のmuxで送受信を続けると、新PCは最初のsealed frameをhandshake helloと
				// 誤解してセッションを拒否し、以後この接続では何も受信できなくなる。ソケットを
				// 閉じて即再接続し、新しいhelloからhandshakeをやり直す。
				//
				// **ハンドシェイク途中（mux が未確立）でも張り直すこと。** 以前はここに
				// `this.mux !== null` の条件があり、「muxが無いなら壊れようがない」と考えていたが、
				// PCは「捨てたセッションの応答」を送れてしまうので前提が成り立たない。実際に本番で
				// 起きていたのは次の並び: ①helloを送る ②PCがresponseを送出（まだ在空中）
				// ③PCのリレーソケットが1006で落ちてPC側セッションが消える ④このpresenceフラップが届くが
				// mux===null なので何もしない ⑤②のresponseが届きハンドシェイクは成功したように見える
				// ⑥直後の requestState が、セッションを失ったPCから hello と誤解されて全滅。
				if (msg.online && wasOnlineOnThisSocket === false) {
					this.reconnectAttempt = 0;
					this.closedForPcRestart = true;
					this.logEvent({ kind: 'pc-restarted' });
					try {
						this.socket?.close(4002, 'pc restarted');
					} catch { /* onclose経由の再接続に任せる */ }
				}
			} else if (msg.type === 'error') {
				this.callbacks.onError?.(new Error(`relay: ${msg.message}`));
			}
		} catch (error) {
			reportMobileDiagnosticError('relay', 'decode-control', error, {
				phase: this.state,
				transport: 'websocket',
			});
			this.callbacks.onError?.(error);
		}
	}

	/**
	 * 接続失敗をSentryへ報告してよいかを返す。
	 *
	 * E2Eハンドシェイクの相手はPCなので、PCがリレーに繋がっていなければ応答は原理的に来ず、
	 * connect timeout は必ず起きる。これは「PCがスリープしている / Para Codeを閉じている」
	 * だけの正常系で、報告するとモバイルを開くたびにerrorが積み上がる（実際にこれが
	 * Sentry上で最多のノイズ源になっていた）。リレーが presence を返してこない場合
	 * （`undefined`）はリレーまで届いていない疑いがあるので、そちらは黙らせない。
	 */
	private shouldReportConnectFailure(): boolean {
		if (this.pcOnlineForCurrentSocket === false) {
			return false;
		}
		return this.reconnectAttempt >= RELAY_REPORT_AFTER_ATTEMPTS;
	}

	private onFatal(error: unknown): void {
		reportMobileDiagnosticError('relay', 'secure-channel', error, {
			phase: this.state,
			transport: 'websocket',
		});
		this.callbacks.onError?.(error);
		this.socket?.close(4000, 'protocol error');
	}

	private onClosed(): void {
		this.clearConnectTimeout();
		this.mux = null;
		this.socket = null;
		// 十分長く続いた接続が切れたのなら、それは一過性の切断。最短の間隔からやり直す。
		if (this.onlineSince !== undefined && this.now() - this.onlineSince >= RELAY_STABLE_CONNECTION_MS) {
			this.reconnectAttempt = 0;
		}
		this.onlineSince = undefined;
		// 裏で保っていたソケットが切れた。張り直さず、suspend と同じ状態で前面復帰を待つ。
		if (this.backgroundHold) {
			this.backgroundHold = false;
			this.suspended = true;
			this.logEvent({ kind: 'suspended' });
			this.setState('offline');
			return;
		}
		if (this.closedByUser || this.suspended) {
			this.setState('offline');
			return;
		}
		this.setState('offline');
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		let delay: number;
		if (this.authRejectedStreak > 0) {
			delay = relayAuthGateDelayMs(this.authRejectedStreak - 1, this.random());
			this.authGateUntil = this.now() + delay;
		} else {
			delay = relayReconnectDelayMs(this.reconnectAttempt, this.random());
		}
		this.reconnectAttempt++;
		this.logEvent({ kind: 'reconnect-scheduled', delayMs: delay, attempt: this.reconnectAttempt });
		this.reconnectHandle = this.timers.setTimeout(() => {
			this.reconnectHandle = null;
			if (!this.closedByUser && !this.suspended) {
				this.openSocket();
			}
		}, delay);
	}

	private logEvent(event: RelayConnectionEvent): void {
		try {
			this.callbacks.onConnectionEvent?.(event);
		} catch { /* 記録の失敗で接続を止めない */ }
	}

	/** 制御メッセージ（pairing-msg等）をリレーへ送る低レベルAPI（ペアリング時に使用）。 */
	sendControl(text: string): void {
		this.socket?.send(text);
	}
}

/** ソケットのエラーの文（RN は Event、テストは Error を渡す）。無ければ undefined。 */
function errorMessage(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.message;
	}
	const message = (error as { message?: unknown } | null | undefined)?.message;
	return typeof message === 'string' ? message : undefined;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export { encodeRelayControl };
