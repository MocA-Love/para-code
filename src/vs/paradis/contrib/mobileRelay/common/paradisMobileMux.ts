/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SecureChannel（webcrypto・非同期）の上にチャネル多重化フレームの送受信を提供する。
// app/protocol/src/mux.ts の非同期版（PC側の webcrypto は seal/open が Promise を返すため）。

import { SecureChannel } from './paradisMobileCrypto.js';
import { ChannelId, decodeFrame, encodeFrame, Frame } from './paradisMobileProtocol.js';

export type FrameHandler = (frame: Frame) => void;

export interface IParadisMobileFrameTrafficSample {
	readonly direction: 'sent' | 'received';
	readonly channel: ChannelId;
	readonly payloadBytes: number;
	readonly sealedBytes: number;
	readonly more: boolean;
}

export interface FrameMuxOptions {
	readonly sendSealed: (sealed: Uint8Array) => void;
	readonly onError?: (error: unknown) => void;
	readonly onTraffic?: (sample: IParadisMobileFrameTrafficSample) => void;
}

/**
 * 1チャンクのペイロード上限（app/protocol/src/mux.ts の FRAME_CHUNK_BYTES と一致させること）。
 * リレー(Cloudflare Worker)のWebSocketメッセージ上限(1MiB)に対し、ヘッダ・封緘タグ・
 * mobileIdプレフィクスを差し引いても安全に収まるサイズ。
 */
const FRAME_CHUNK_BYTES = 700 * 1024;

/** 再結合バッファの上限（app/protocol 側と一致）。 */
const FRAME_REASSEMBLY_LIMIT = 32 * 1024 * 1024;

export class FrameMux {
	private readonly handlers = new Map<ChannelId, FrameHandler>();
	private readonly seq = new Map<ChannelId, number>();
	// チャネル別のチャンク再結合バッファ（more=trueのフレームを結合し、more無しで確定）。
	// rxChainの直列化とnonce厳密検査により、チャンクは必ず送信順に届く。
	private readonly reassembly = new Map<ChannelId, Uint8Array[]>();

	// webcryptoのseal/openは非同期。SecureChannelは方向別にカウンタnonceを持つため、
	// seal（nonce採番）→送出、および open（nonce厳密一致で復号）を**厳密に直列化**しないと、
	// 並行呼び出しでnonce採番と暗号化完了の順序がずれてnonce再利用や受信desyncを起こす（H-2）。
	// tx/rxそれぞれをPromiseチェーンで直列化する。
	private txChain: Promise<void> = Promise.resolve();
	private rxChain: Promise<void> = Promise.resolve();

	constructor(private readonly channel: SecureChannel, private readonly options: FrameMuxOptions) { }

	private reportTraffic(observer: (sample: IParadisMobileFrameTrafficSample) => void, sample: IParadisMobileFrameTrafficSample): void {
		try {
			observer(sample);
		} catch {
			// Diagnostics must never affect frame delivery or the ordered cipher chains.
		}
	}

	on(channel: ChannelId, handler: FrameHandler): void {
		this.handlers.set(channel, handler);
	}

	send(channel: ChannelId, payload: Uint8Array, ws?: string): Promise<void> {
		// 大きなペイロードはチャンク分割する。seq採番〜seal〜送出の列全体を1つの
		// チェーンタスクで行い、他のsendのチャンクが間に割り込まないようにする。
		const run = this.txChain.then(async () => {
			for (let offset = 0; ; offset += FRAME_CHUNK_BYTES) {
				const end = Math.min(offset + FRAME_CHUNK_BYTES, payload.length);
				const more = end < payload.length;
				const seq = this.seq.get(channel) ?? 0;
				this.seq.set(channel, seq + 1);
				const frame: Frame = {
					ch: channel,
					seq,
					payload: payload.subarray(offset, end),
					...(ws !== undefined ? { ws } : {}),
					...(more ? { more: true } : {}),
				};
				// seal(nonce採番+暗号化)と送出を不可分にする。
				const sealed = await this.channel.seal(encodeFrame(frame));
				this.options.sendSealed(sealed);
				const trafficObserver = this.options.onTraffic;
				if (trafficObserver !== undefined) {
					this.reportTraffic(trafficObserver, {
						direction: 'sent',
						channel,
						payloadBytes: frame.payload.length,
						sealedBytes: sealed.length,
						more,
					});
				}
				if (!more) {
					return;
				}
			}
		});
		// チェーンは失敗しても後続を止めないよう握りつぶす（各呼び出しには元のPromiseを返す）。
		this.txChain = run.catch(() => { /* keep chain alive */ });
		return run;
	}

	receive(sealed: Uint8Array): Promise<void> {
		const run = this.rxChain.then(async () => {
			let frame: Frame;
			try {
				frame = decodeFrame(await this.channel.open(sealed));
			} catch (error) {
				// 復号/デコード失敗はonErrorへ通知した上で必ずrethrowする（app/protocol/src/mux.tsとは
				// ここだけ意図的に異なる）。MobileSession.handlePayloadの自己回復（復号不能な32B=
				// モバイル再起動後の再送helloとしてセッションを再確立）はcatchでしか発火できないため、
				// onErrorで握り潰すと確立済みセッションが永久に新しいhelloを無視し再接続不能になる。
				this.options.onError?.(error);
				throw error;
			}
			const trafficObserver = this.options.onTraffic;
			if (trafficObserver !== undefined) {
				this.reportTraffic(trafficObserver, {
					direction: 'received',
					channel: frame.ch,
					payloadBytes: frame.payload.length,
					sealedBytes: sealed.length,
					more: frame.more === true,
				});
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
				const combined = new Uint8Array(total);
				let offset = 0;
				for (const chunk of [...pending, frame.payload]) {
					combined.set(chunk, offset);
					offset += chunk.length;
				}
				full = { ...frame, payload: combined };
			}
			this.handlers.get(full.ch)?.(full);
		});
		this.rxChain = run.catch(() => { /* keep chain alive */ });
		return run;
	}
}
