// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 確立済み SecureChannel の上に、チャネル多重化されたフレームの送受信を提供する。
 * トランスポート（WebSocket）非依存: 封緘済みバイト列を「送る手段」を注入する。
 *
 * - send: アプリ層フレーム → encodeFrame → channel.seal → transport
 * - receive: transport → channel.open → decodeFrame → チャネル別ハンドラ
 *
 * 受信は SecureChannel のカウンタnonceにより順序・重複が厳密に検査されるため、
 * WebSocketの順序保証と組み合わせて、欠落/リプレイを検出できる。
 */

import type { SecureChannel } from './crypto.js';
import { type ChannelId, decodeFrame, encodeFrame, type Frame } from './frames.js';

export type FrameHandler = (frame: Frame) => void;

export interface FrameMuxOptions {
	/** 封緘済みバイト列を相手へ送る手段（WebSocket.sendのラッパ）。 */
	readonly sendSealed: (sealed: Uint8Array) => void;
	/** open/decode失敗時のコールバック（切断判断に使う。既定はthrow）。 */
	readonly onError?: (error: unknown) => void;
}

/**
 * 1チャンクのペイロード上限。リレー(Cloudflare Worker)のWebSocketメッセージ上限(1MiB)に対し、
 * フレームヘッダ・封緘タグ・mobileIdプレフィクスを差し引いても安全に収まるサイズにする。
 */
export const FRAME_CHUNK_BYTES = 700 * 1024;

/** 再結合バッファの上限（これを超える論理フレームは破棄してエラー扱い）。 */
export const FRAME_REASSEMBLY_LIMIT = 32 * 1024 * 1024;

export class FrameMux {
	private readonly handlers = new Map<ChannelId, FrameHandler>();
	private readonly seq = new Map<ChannelId, number>();
	// チャネル別のチャンク再結合バッファ（more=trueのフレームを結合し、more無しで確定）。
	// 送信側はチャンク列を連続送出し、トランスポート(WebSocket)とnonce検査が順序を保証する。
	private readonly reassembly = new Map<ChannelId, Uint8Array[]>();

	constructor(private readonly channel: SecureChannel, private readonly options: FrameMuxOptions) { }

	/** 指定チャネルの受信ハンドラを登録する。 */
	on(channel: ChannelId, handler: FrameHandler): void {
		this.handlers.set(channel, handler);
	}

	/** アプリ層フレームを送る（seqは自動採番。大きなペイロードは自動でチャンク分割）。 */
	send(channel: ChannelId, payload: Uint8Array, ws?: string): void {
		for (let offset = 0; ; offset += FRAME_CHUNK_BYTES) {
			const end = Math.min(offset + FRAME_CHUNK_BYTES, payload.length);
			const more = end < payload.length;
			const seq = (this.seq.get(channel) ?? 0);
			this.seq.set(channel, seq + 1);
			const frame: Frame = {
				ch: channel,
				seq,
				payload: payload.subarray(offset, end),
				...(ws !== undefined ? { ws } : {}),
				...(more ? { more: true } : {}),
			};
			this.options.sendSealed(this.channel.seal(encodeFrame(frame)));
			if (!more) {
				return;
			}
		}
	}

	/** transportから届いた封緘バイト列を処理する。 */
	receive(sealed: Uint8Array): void {
		let frame: Frame;
		try {
			frame = decodeFrame(this.channel.open(sealed));
		} catch (error) {
			if (this.options.onError) {
				this.options.onError(error);
				return;
			}
			throw error;
		}
		const pending = this.reassembly.get(frame.ch);
		if (frame.more === true) {
			const chunks = pending ?? [];
			chunks.push(frame.payload);
			if (chunks.reduce((total, c) => total + c.length, 0) > FRAME_REASSEMBLY_LIMIT) {
				this.reassembly.delete(frame.ch);
				this.options.onError?.(new Error(`frame reassembly limit exceeded on channel ${frame.ch}`));
				return;
			}
			this.reassembly.set(frame.ch, chunks);
			return;
		}
		let full = frame;
		if (pending !== undefined) {
			this.reassembly.delete(frame.ch);
			const total = pending.reduce((sum, c) => sum + c.length, 0) + frame.payload.length;
			const payload = new Uint8Array(total);
			let offset = 0;
			for (const chunk of [...pending, frame.payload]) {
				payload.set(chunk, offset);
				offset += chunk.length;
			}
			full = { ...frame, payload };
		}
		const handler = this.handlers.get(full.ch);
		if (handler) {
			handler(full);
		}
	}
}
