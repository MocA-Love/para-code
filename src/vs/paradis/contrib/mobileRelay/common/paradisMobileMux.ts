/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SecureChannel（webcrypto・非同期）の上にチャネル多重化フレームの送受信を提供する。
// app/protocol/src/mux.ts の非同期版（PC側の webcrypto は seal/open が Promise を返すため）。
//
// 版 4: 16KiB を超えるフレームは断片（送信 ID・何番目か・最後か）に切り、全端末で 1 本の送信の列
// （paradisMobileSendQueue.ts）に積む。列は断片ごとに優先度で送る順を決め、送る直前に 1 断片ずつ封緘する。
// 受け手は送信 ID ごとに組み立て直す（断片は交互に届いてよい）。

import { SecureChannel } from './paradisMobileCrypto.js';
import { ChannelId, decodeFrame, encodeFrame, Frame } from './paradisMobileProtocol.js';
import { IParadisMobileSendHandle, IParadisMobileSendTransfer, PARADIS_MOBILE_FRAGMENT_BYTES, ParadisMobileSendPriority, ParadisMobileSendQueue, paradisMobileRejectedSend, paradisMobileSendPriorityOf } from './paradisMobileSendQueue.js';
import type { ParadisMobileLinkMetrics } from './paradisMobileLinkMetrics.js';

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
	/**
	 * 封緘に失敗した（予約した nonce に欠番ができた）。この mux は以後何も送らない。受け手は nonce の完全一致を
	 * 求めるので、同じ暗号セッションは続けられない。呼び手はセッションを畳み、新しい握手へ移すこと（設計 2.12）。
	 */
	readonly onSealFailure?: (error: unknown) => void;
	readonly onTraffic?: (sample: IParadisMobileFrameTrafficSample) => void;
	/**
	 * 断片の組み立ての誤り（抜け・上限超え）。復号はできているので暗号層の失敗とは分けて数える。
	 * 無ければ onError へ渡す。
	 */
	readonly onAssemblyError?: (error: Error) => void;
	/** 全端末で 1 本の送信の列。無ければこの mux だけの列を持つ（テスト用。送信バッファは見ない）。 */
	readonly sendQueue?: ParadisMobileSendQueue;
	/** 通信の計測（F0）。復号の待ち・復号の時間・論理フレームの大きさを数える。オフの間は何もしない。 */
	readonly metrics?: ParadisMobileLinkMetrics;
}

/** 再結合バッファの上限（組み立て中の合計。app/protocol 側と一致）。 */
const FRAME_REASSEMBLY_LIMIT = 32 * 1024 * 1024;
/** 同時に組み立てる送信の数の上限（app/protocol 側と一致）。 */
const FRAME_MAX_CONCURRENT_TRANSFERS = 32;

interface IPendingTransfer {
	readonly ch: ChannelId;
	readonly ws: string | undefined;
	readonly seq: number;
	readonly chunks: Uint8Array[];
	bytes: number;
	next: number;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/**
 * 届いたフレームを論理フレームへ組み立て直す（版 4 の断片と、版 3 の `more`）。
 * app/protocol/src/mux.ts の `FrameAssembler` と同じ規則。
 */
export class ParadisMobileFrameAssembler {
	private readonly legacy = new Map<ChannelId, Uint8Array[]>();
	private readonly transfers = new Map<number, IPendingTransfer>();
	private assemblingBytes = 0;

	get pendingBytes(): number {
		return this.assemblingBytes;
	}

	/** 1 フレームを足す。完結したら論理フレーム、規則に反したら Error（その送信は捨てる）。 */
	push(frame: Frame): Frame | Error | undefined {
		const frag = frame.frag;
		if (frag !== undefined) {
			return this.pushFragment(frame, frag.id, frag.index, frag.last);
		}
		const pending = this.legacy.get(frame.ch);
		if (frame.more === true) {
			const chunks = pending ?? [];
			chunks.push(frame.payload);
			if (chunks.reduce((total, c) => total + c.length, 0) > FRAME_REASSEMBLY_LIMIT) {
				this.legacy.delete(frame.ch);
				return new Error(`frame reassembly limit exceeded on channel ${frame.ch}`);
			}
			this.legacy.set(frame.ch, chunks);
			return undefined;
		}
		if (pending === undefined) {
			return frame;
		}
		this.legacy.delete(frame.ch);
		const all = [...pending, frame.payload];
		return { ...frame, payload: concat(all, all.reduce((sum, c) => sum + c.length, 0)) };
	}

	private pushFragment(frame: Frame, id: number, index: number, last: boolean): Frame | Error | undefined {
		let transfer = this.transfers.get(id);
		let error: Error | undefined;
		if (index === 0) {
			if (transfer !== undefined) {
				this.drop(id, transfer);
			}
			if (last) {
				return { ch: frame.ch, seq: frame.seq, payload: frame.payload, ...(frame.ws !== undefined ? { ws: frame.ws } : {}) };
			}
			if (this.transfers.size >= FRAME_MAX_CONCURRENT_TRANSFERS) {
				const oldest = this.transfers.keys().next().value as number;
				this.drop(oldest, this.transfers.get(oldest)!);
				error = new Error('too many concurrent frame transfers');
			}
			transfer = { ch: frame.ch, ws: frame.ws, seq: frame.seq, chunks: [frame.payload], bytes: frame.payload.length, next: 1 };
			this.transfers.set(id, transfer);
			this.assemblingBytes += frame.payload.length;
		} else {
			if (transfer === undefined) {
				return undefined;
			}
			if (index !== transfer.next || transfer.ch !== frame.ch) {
				this.drop(id, transfer);
				return new Error(`frame fragment out of order on transfer ${id}`);
			}
			transfer.chunks.push(frame.payload);
			transfer.bytes += frame.payload.length;
			transfer.next++;
			this.assemblingBytes += frame.payload.length;
		}
		if (this.assemblingBytes > FRAME_REASSEMBLY_LIMIT) {
			this.drop(id, transfer);
			return new Error(`frame reassembly limit exceeded on transfer ${id}`);
		}
		if (error !== undefined) {
			return error;
		}
		if (!last) {
			return undefined;
		}
		this.transfers.delete(id);
		this.assemblingBytes -= transfer.bytes;
		return { ch: transfer.ch, seq: transfer.seq, payload: concat(transfer.chunks, transfer.bytes), ...(transfer.ws !== undefined ? { ws: transfer.ws } : {}) };
	}

	private drop(id: number, transfer: IPendingTransfer): void {
		this.transfers.delete(id);
		this.assemblingBytes -= transfer.bytes;
	}
}

/** {@link FrameMux.submit} の送り方。 */
export interface IParadisMobileFrameSubmitOptions {
	/** 送信前の列の上限を守る（超えるなら列に入れず busy を返す）。 */
	readonly bounded?: boolean;
	/** 取消の単位（送り手の renderer の世代）。{@link ParadisMobileSendQueue.cancelTag} で nonce の予約前だけ取り下げる。 */
	readonly cancelTag?: string;
}

/**
 * フレームの順序ドメイン（送信の列のストリーム）。同じチャネルのフレームは積んだ順に送る。browser チャネルは中身で
 * 音声・画面・それ以外に分かれ、互いに独立している（今の優先度の分け方と同じ境目）。
 */
export function paradisMobileFrameStreamOf(channel: ChannelId, priority: ParadisMobileSendPriority): string {
	if (channel !== 'browser') {
		return channel;
	}
	return priority === ParadisMobileSendPriority.Voice ? 'browser:voice' : priority === ParadisMobileSendPriority.Screen ? 'browser:screen' : 'browser';
}

export class FrameMux {
	private readonly handlers = new Map<ChannelId, FrameHandler>();
	private readonly seq = new Map<ChannelId, number>();
	private readonly assembler = new ParadisMobileFrameAssembler();
	private readonly sendQueue: ParadisMobileSendQueue;
	private nextTransferId = 0;
	private disposed = false;

	// webcryptoのopenは非同期。SecureChannelは方向別にカウンタnonceを持つため、open（nonce厳密一致で復号）を
	// **厳密に直列化**しないと受信desyncを起こす（H-2）。送る側は送信の列が 1 断片ずつ封緘→送出を直列に行う。
	private rxChain: Promise<void> = Promise.resolve();

	constructor(private readonly channel: SecureChannel, private readonly options: FrameMuxOptions) {
		this.sendQueue = options.sendQueue ?? new ParadisMobileSendQueue();
	}

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

	/**
	 * フレームを送信の列に積む（呼んだ時点で列に入るので、同じストリームの中は呼んだ順に届く）。
	 * 最後の断片を送ったら解決する。送り始める前に取り下げられた（新しい JPEG に置き換えられた・セッションを
	 * 張り替えた）ときも解決する。封緘・送出に失敗したら reject する。
	 */
	async send(channel: ChannelId, payload: Uint8Array, ws?: string): Promise<void> {
		const transfer = this.prepare(channel, payload, ws, {});
		if (transfer !== undefined) {
			await this.sendQueue.enqueue(transfer);
		}
	}

	/**
	 * フレームを積み、列に入れた（accepted）ことと送り終えた（settled）ことを分けて返す（設計 2.3）。`bounded` なら
	 * 送信前の列の上限を守り、超えるなら番号（seq・送信 ID）を進めずに busy を返す。
	 */
	submit(channel: ChannelId, payload: Uint8Array, ws?: string, options: IParadisMobileFrameSubmitOptions = {}): IParadisMobileSendHandle {
		if (this.disposed) {
			return paradisMobileRejectedSend('closed');
		}
		if (options.bounded === true) {
			const { priority } = paradisMobileSendPriorityOf(channel, payload);
			if (!this.sendQueue.admits(this, paradisMobileFrameStreamOf(channel, priority), payload.length)) {
				this.options.metrics?.count('pc.queue.busy');
				return paradisMobileRejectedSend('busy');
			}
		}
		const transfer = this.prepare(channel, payload, ws, options);
		return transfer === undefined ? paradisMobileRejectedSend('closed') : this.sendQueue.submit(transfer);
	}

	/** 番号を進め、送信の列に積む形を作る。閉じた mux なら undefined。 */
	private prepare(channel: ChannelId, payload: Uint8Array, ws: string | undefined, options: IParadisMobileFrameSubmitOptions): IParadisMobileSendTransfer | undefined {
		if (this.disposed) {
			return undefined;
		}
		const seq = this.seq.get(channel) ?? 0;
		this.seq.set(channel, (seq + 1) % 0x100000000);
		const fragmented = payload.length > PARADIS_MOBILE_FRAGMENT_BYTES;
		const fragmentCount = fragmented ? Math.ceil(payload.length / PARADIS_MOBILE_FRAGMENT_BYTES) : 1;
		const id = fragmented ? this.nextTransferId : 0;
		if (fragmented) {
			this.nextTransferId = (this.nextTransferId + 1) % 0x100000000;
		}
		const { priority, replaceKey, interleave } = paradisMobileSendPriorityOf(channel, payload);
		if (this.options.metrics?.enabled === true) {
			// 名前の文字列は計測中だけ組み立てる（オフの送信の経路に負荷を足さない）
			this.options.metrics.observe(`pc.tx.${channel}.frameBytes`, payload.length);
		}
		const fragmentAt = (index: number): Frame => {
			if (!fragmented) {
				// 16KiB 以下は断片の見出しを付けない（版 3 と同じバイト列。古い相手への更新の案内もこの形で届く）
				return { ch: channel, seq, payload, ...(ws !== undefined ? { ws } : {}) };
			}
			const start = index * PARADIS_MOBILE_FRAGMENT_BYTES;
			const end = Math.min(start + PARADIS_MOBILE_FRAGMENT_BYTES, payload.length);
			return { ch: channel, seq, payload: payload.subarray(start, end), ...(ws !== undefined ? { ws } : {}), frag: { id, index, last: end >= payload.length } };
		};
		return {
			owner: this,
			priority,
			stream: paradisMobileFrameStreamOf(channel, priority),
			...(options.cancelTag !== undefined ? { cancelTag: options.cancelTag } : {}),
			...(replaceKey !== undefined ? { replaceKey } : {}),
			...(interleave ? { interleave: true } : {}),
			fragmentCount,
			bytes: payload.length,
			sealFragment: async index => {
				try {
					return await this.channel.seal(encodeFrame(fragmentAt(index)));
				} catch (error) {
					this.failSealing(error);
					throw error;
				}
			},
			sendSealed: (sealed, index) => {
				this.options.sendSealed(sealed);
				const trafficObserver = this.options.onTraffic;
				if (trafficObserver !== undefined) {
					const fragmentBytes = fragmented ? Math.min(PARADIS_MOBILE_FRAGMENT_BYTES, payload.length - index * PARADIS_MOBILE_FRAGMENT_BYTES) : payload.length;
					this.reportTraffic(trafficObserver, {
						direction: 'sent',
						channel,
						payloadBytes: fragmentBytes,
						sealedBytes: sealed.length,
						more: index < fragmentCount - 1,
					});
				}
			},
		};
	}

	/** 封緘の失敗で暗号セッションが使えなくなった。残りを取り下げ、呼び手へ一度だけ知らせる。 */
	private failSealing(error: unknown): void {
		if (this.disposed) {
			return;
		}
		this.dispose();
		try {
			this.options.onSealFailure?.(error);
		} catch {
			// 知らせる側の例外で送信の列を止めない
		}
	}

	/** この mux の送信を全部取り下げ、以後は送らない（セッションを張り替えた・捨てた）。 */
	dispose(): void {
		this.disposed = true;
		this.sendQueue.cancelOwner(this);
	}

	receive(sealed: Uint8Array): Promise<void> {
		const metrics = this.options.metrics?.enabled === true ? this.options.metrics : undefined;
		const receivedAt = metrics?.now() ?? 0;
		const run = this.rxChain.then(async () => {
			let frame: Frame;
			try {
				const openStartedAt = metrics?.now() ?? 0;
				// 前のフレームの復号を待った時間（復号は 1 本の列で順に行う）
				metrics?.observe('pc.rx.chainWaitMs', openStartedAt - receivedAt);
				const opened = await this.channel.open(sealed);
				metrics?.observeSince('pc.rx.openMs', openStartedAt);
				frame = decodeFrame(opened);
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
					more: frame.frag !== undefined ? !frame.frag.last : frame.more === true,
				});
			}
			const full = this.assembler.push(frame);
			if (full === undefined) {
				return;
			}
			if (full instanceof Error) {
				if (this.options.onAssemblyError !== undefined) {
					this.options.onAssemblyError(full);
				} else {
					this.options.onError?.(full);
				}
				return;
			}
			this.handlers.get(full.ch)?.(full);
		});
		this.rxChain = run.catch(() => { /* keep chain alive */ });
		return run;
	}
}
