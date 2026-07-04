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

export class RelayClient {
	private socket: SocketLike | null = null;
	private mux: FrameMux | null = null;
	private state: ConnectionState = 'offline';
	private closedByUser = false;
	private reconnectAttempt = 0;
	private reconnectHandle: unknown = null;

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
		this.socket?.close(1000, 'client closed');
		this.socket = null;
		this.setState('offline');
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

		const initiator = createInitiator(this.identity, this.credentials.pcPublicKey);

		socket.onopen = () => {
			this.setState('handshaking');
			// hello（自分のephemeral公開鍵）をバイナリで送る
			socket.send(toArrayBuffer(initiator.hello));
		};

		let established = false;
		socket.onmessage = event => {
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
