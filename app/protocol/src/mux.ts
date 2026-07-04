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

export class FrameMux {
	private readonly handlers = new Map<ChannelId, FrameHandler>();
	private readonly seq = new Map<ChannelId, number>();

	constructor(private readonly channel: SecureChannel, private readonly options: FrameMuxOptions) { }

	/** 指定チャネルの受信ハンドラを登録する。 */
	on(channel: ChannelId, handler: FrameHandler): void {
		this.handlers.set(channel, handler);
	}

	/** アプリ層フレームを送る（seqは自動採番）。 */
	send(channel: ChannelId, payload: Uint8Array, ws?: string): void {
		const seq = (this.seq.get(channel) ?? 0);
		this.seq.set(channel, seq + 1);
		const frame: Frame = ws === undefined ? { ch: channel, seq, payload } : { ch: channel, ws, seq, payload };
		this.options.sendSealed(this.channel.seal(encodeFrame(frame)));
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
		const handler = this.handlers.get(frame.ch);
		if (handler) {
			handler(frame);
		}
	}
}
