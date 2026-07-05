// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイル側のリレー接続クライアント（トランスポート非依存の中核ロジック）。
 *
 * 責務:
 *  - リレーへ role=mobile で WebSocket 接続
 *  - イニシエータとして E2E ハンドシェイク（相手=PCの静的公開鍵は保存済み前提）
 *  - 確立後は FrameMux で state/term/scm/fs/browser/notify を多重化
 *  - presence 制御メッセージ（PCのオンライン状態）の反映
 *  - 切断時の指数バックオフ再接続
 *
 * WebSocket 実装は注入する（React Native の global WebSocket / テストのfake双方に対応）。
 */

import {
	type ChannelId,
	type Frame,
	FrameMux,
	type Identity,
	createInitiator,
	decodeRelayControl,
	encodeRelayControl,
} from '@para/protocol';

/** 最小限の WebSocket インターフェース（RNのWebSocketと互換）。 */
export interface SocketLike {
	send(data: string | ArrayBufferView | ArrayBuffer): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: ((error: unknown) => void) | null;
	onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
	binaryType?: string;
}

export type SocketFactory = (url: string) => SocketLike;

export interface PairedCredentials {
	readonly relayUrl: string;
	readonly deviceId: string;
	readonly mobileId: string;
	readonly mobileToken: string;
	/** PCの長期公開鍵（ハンドシェイクの相手鍵）。 */
	readonly pcPublicKey: Uint8Array;
}

export type ConnectionState = 'connecting' | 'handshaking' | 'online' | 'offline';

export interface RelayClientCallbacks {
	readonly onStateChange?: (state: ConnectionState) => void;
	/** PC自身のpresence（PCがリレーに繋がっているか）。 */
	readonly onPcPresence?: (online: boolean) => void;
	readonly onFrame?: (frame: Frame) => void;
	readonly onError?: (error: unknown) => void;
}

interface Timers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;
// 接続開始〜E2E確立までの上限。RNのWebSocketは接続失敗やPC不在時にonclose/oncloseが
// 届かないまま黙り込むことがあり、これが無いと'connecting'/'handshaking'で永久に止まる。
const CONNECT_TIMEOUT_MS = 12_000;

export class RelayClient {
	private socket: SocketLike | null = null;
	private mux: FrameMux | null = null;
	private state: ConnectionState = 'offline';
	private closedByUser = false;
	private reconnectAttempt = 0;
	private reconnectHandle: unknown = null;
	private connectTimeoutHandle: unknown = null;
	/** 最後に何かを受信した時刻（onlineのまま死んだソケットの検出用）。 */
	private lastReceivedAt = 0;

	constructor(
		private readonly identity: Identity,
		private readonly credentials: PairedCredentials,
		private readonly socketFactory: SocketFactory,
		private readonly callbacks: RelayClientCallbacks = {},
		private readonly timers: Timers = globalThis,
	) { }

	get connectionState(): ConnectionState {
		return this.state;
	}

	connect(): void {
		this.closedByUser = false;
		this.openSocket();
	}

	close(): void {
		this.closedByUser = true;
		if (this.reconnectHandle !== null) {
			this.timers.clearTimeout(this.reconnectHandle);
			this.reconnectHandle = null;
		}
		this.clearConnectTimeout();
		this.socket?.close(1000, 'client closed');
		this.socket = null;
		this.setState('offline');
	}

	/**
	 * 未接続なら即座に接続し直す（バックオフ待ちも打ち切る）。
	 * フォアグラウンド復帰時など「今すぐ繋がってほしい」場面用。
	 * すでにonlineなら何もしない。ユーザーが明示的に切断した状態は維持する。
	 */
	ensureConnected(): void {
		if (this.closedByUser || this.state === 'online') {
			return;
		}
		this.reopenSocket();
	}

	/**
	 * 'online' のまま死んでいるソケット（zombie）の検出。呼び出し側が直前に応答を伴う
	 * 要求（state要求など）を送っている前提で、timeoutMs 以内に何も受信しなければ
	 * 接続を作り直す。iOSはバックグラウンドでソケットを黙って殺し、oncloseが届かない
	 * ことがあるため、'online' 表示だけでは生存を信用できない。
	 */
	probeLiveness(timeoutMs: number = 5_000): void {
		if (this.state !== 'online') {
			this.ensureConnected();
			return;
		}
		const probeAt = Date.now();
		this.timers.setTimeout(() => {
			if (!this.closedByUser && this.state === 'online' && this.lastReceivedAt < probeAt) {
				this.reopenSocket();
			}
		}, timeoutMs);
	}

	/** バックオフ待ちを打ち切り、既存ソケットを黙って破棄して接続し直す。 */
	private reopenSocket(): void {
		if (this.reconnectHandle !== null) {
			this.timers.clearTimeout(this.reconnectHandle);
			this.reconnectHandle = null;
		}
		this.reconnectAttempt = 0;
		// 死んでいる可能性のあるソケットを黙って破棄する（oncloseからの
		// 二重再接続を防ぐためハンドラを外してから閉じる）。
		if (this.socket) {
			const stale = this.socket;
			this.socket = null;
			this.mux = null;
			stale.onclose = null;
			stale.onerror = null;
			stale.onmessage = null;
			try {
				stale.close(4002, 'superseded');
			} catch { /* ignore */ }
		}
		this.clearConnectTimeout();
		this.openSocket();
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
		const params = new URLSearchParams({
			role: 'mobile',
			mobileId: this.credentials.mobileId,
			token: this.credentials.mobileToken,
		});
		return `${base}/device/${this.credentials.deviceId}/ws?${params.toString()}`;
	}

	private openSocket(): void {
		this.setState('connecting');
		const socket = this.socketFactory(this.wsUrl());
		socket.binaryType = 'arraybuffer';
		this.socket = socket;

		// 一定時間内にE2E確立まで到達しなければ強制的に閉じる（onclose経由で再接続）。
		this.clearConnectTimeout();
		this.connectTimeoutHandle = this.timers.setTimeout(() => {
			this.connectTimeoutHandle = null;
			if (this.socket === socket && this.state !== 'online') {
				try {
					socket.close(4001, 'connect timeout');
				} catch { /* ignore */ }
			}
		}, CONNECT_TIMEOUT_MS);

		const initiator = createInitiator(this.identity, this.credentials.pcPublicKey);

		socket.onopen = () => {
			this.setState('handshaking');
			// hello（自分のephemeral公開鍵）をバイナリで送る
			socket.send(toArrayBuffer(initiator.hello));
		};

		let established = false;
		socket.onmessage = event => {
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
					});
					if (this.callbacks.onFrame) {
						const onFrame = this.callbacks.onFrame;
						for (const ch of ['state', 'term', 'scm', 'fs', 'browser', 'notify'] as ChannelId[]) {
							this.mux.on(ch, onFrame);
						}
					}
					established = true;
					this.reconnectAttempt = 0;
					this.clearConnectTimeout();
					this.setState('online');
				} catch (error) {
					this.onFatal(error);
				}
				return;
			}
			this.mux?.receive(bytes);
		};

		socket.onerror = error => this.callbacks.onError?.(error);
		socket.onclose = () => this.onClosed();
	}

	private handleControl(text: string): void {
		try {
			const msg = decodeRelayControl(text);
			if (msg.type === 'presence' && msg.peer === 'pc') {
				this.callbacks.onPcPresence?.(msg.online);
			} else if (msg.type === 'error') {
				this.callbacks.onError?.(new Error(`relay: ${msg.message}`));
			}
		} catch (error) {
			this.callbacks.onError?.(error);
		}
	}

	private onFatal(error: unknown): void {
		this.callbacks.onError?.(error);
		this.socket?.close(4000, 'protocol error');
	}

	private onClosed(): void {
		this.clearConnectTimeout();
		this.mux = null;
		this.socket = null;
		if (this.closedByUser) {
			this.setState('offline');
			return;
		}
		this.setState('offline');
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
		this.reconnectAttempt++;
		this.reconnectHandle = this.timers.setTimeout(() => {
			this.reconnectHandle = null;
			if (!this.closedByUser) {
				this.openSocket();
			}
		}, delay);
	}

	/** 制御メッセージ（pairing-msg等）をリレーへ送る低レベルAPI（ペアリング時に使用）。 */
	sendControl(text: string): void {
		this.socket?.send(text);
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export { encodeRelayControl };
