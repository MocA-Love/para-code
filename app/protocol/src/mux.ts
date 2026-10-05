// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 確立済み SecureChannel の上に、チャネル多重化されたフレームの送受信を提供する。
 * トランスポート（WebSocket）非依存: 封緘済みバイト列を「送る手段」を注入する。
 *
 * - send: アプリ層フレーム → (16KiB を超えたら断片に切る) → encodeFrame → channel.seal → transport
 * - receive: transport → channel.open → decodeFrame → (断片なら送信 ID ごとに組み立て直す) → チャネル別ハンドラ
 *
 * 受信は SecureChannel のカウンタnonceにより順序・重複が厳密に検査されるため、
 * WebSocketの順序保証と組み合わせて、欠落/リプレイを検出できる。
 *
 * 版 4（音声のストリーミング）: 大きなフレームを 16KiB ずつの断片に切り、各断片に「送信 ID・何番目か・最後か」を
 * 持たせる。受け手は送信 ID ごとに組み立て直すので、PC は断片ごとに優先度（音声 → 操作・状態 → 画面）で送る順を
 * 決められる（PC 側の送信の列は `paradisMobileSendQueue.ts`）。アプリから PC へ送るものは小さいので、
 * アプリは断片を続けて送る（交互にしない）。版 3 の `more` による分割は、古い PC の State の案内を読むために
 * 受け取りだけ残す。
 */

import type { SecureChannel } from './crypto.js';
import { type ChannelId, decodeFrame, encodeFrame, type Frame } from './frames.js';

export type FrameHandler = (frame: Frame) => void;

export interface FrameMuxOptions {
	/** 封緘済みバイト列を相手へ送る手段（WebSocket.sendのラッパ）。 */
	readonly sendSealed: (sealed: Uint8Array) => void;
	/** open/decode失敗時のコールバック（切断判断に使う。既定はthrow）。 */
	readonly onError?: (error: unknown) => void;
	/**
	 * 計測用（任意）。封緘バイト列を1つ開封してフレームにした直後、再結合の前に呼ぶ。大きな応答が
	 * チャンクごとにいつ届き、開封（復号）にどれだけかかったかを測るためだけに使い、振る舞いは変えない。
	 */
	readonly onChunkOpened?: (chunk: FrameChunkTiming) => void;
	/**
	 * 断片の組み立ての誤り（抜け・上限超え）。復号はできているので、暗号層の失敗（onError、切断の判断）とは分ける。
	 * 無ければ onError へ渡す。
	 */
	readonly onAssemblyError?: (error: Error) => void;
}

/** {@link FrameMuxOptions.onChunkOpened} へ渡す、チャンク1つ分の計測値。 */
export interface FrameChunkTiming {
	readonly ch: ChannelId;
	/** チャンクのペイロードのバイト数。 */
	readonly bytes: number;
	/** 続きのチャンクがあるか（false ならこのチャンクで論理フレームが完結する）。 */
	readonly more: boolean;
	/** 開封（復号）とフレームのデコードにかかった時間（ms）。 */
	readonly openMs: number;
}

/**
 * 版 4 の断片 1 つのペイロード上限。これを超える論理フレームは断片に切る。
 * PC の `PARADIS_MOBILE_FRAGMENT_BYTES` と一致させること。
 */
export const FRAME_CHUNK_BYTES = 16 * 1024;

/** 再結合バッファの上限（組み立て中の合計。これを超える論理フレームは破棄してエラー扱い）。 */
export const FRAME_REASSEMBLY_LIMIT = 32 * 1024 * 1024;

/** 同時に組み立てる送信の数の上限（PC は優先度ごとに 1 本ずつしか交互にしない）。 */
export const FRAME_MAX_CONCURRENT_TRANSFERS = 32;

interface PendingTransfer {
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
 * PC の `ParadisMobileFrameAssembler` と同じ規則。
 */
export class FrameAssembler {
	// 版 3: チャネル別のチャンク（more=true を結合し、more 無しで確定）
	private readonly legacy = new Map<ChannelId, Uint8Array[]>();
	// 版 4: 送信 ID 別
	private readonly transfers = new Map<number, PendingTransfer>();
	private assemblingBytes = 0;

	/** 組み立て中のバイト数（版 4 の断片の合計）。 */
	get pendingBytes(): number {
		return this.assemblingBytes;
	}

	/**
	 * 1 フレームを足す。論理フレームが完結したら返す。規則に反する断片は捨てて Error を返す
	 * （呼び出し側が onError へ渡す）。
	 */
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
		// 同時に組み立てる本数の上限で最古を捨てたときの知らせ。新しい送信は組み立て続け、合計の上限も確かめてから返す
		// （PC の ParadisMobileFrameAssembler と同じ順・同じ表記）
		let error: Error | undefined;
		if (index === 0) {
			if (transfer !== undefined) {
				// 同じ送信 ID が最初から始まり直した（相手が送るのをやめた）。古い方は捨てる
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
			transfer = this.addFirst(frame, id);
		} else {
			if (transfer === undefined) {
				// 始まりを捨てた送信の続き。黙って捨てる（上限で捨てたときは既に知らせている）
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

	private addFirst(frame: Frame, id: number): PendingTransfer {
		const transfer: PendingTransfer = { ch: frame.ch, ws: frame.ws, seq: frame.seq, chunks: [frame.payload], bytes: frame.payload.length, next: 1 };
		this.transfers.set(id, transfer);
		this.assemblingBytes += frame.payload.length;
		return transfer;
	}

	private drop(id: number, transfer: PendingTransfer): void {
		this.transfers.delete(id);
		this.assemblingBytes -= transfer.bytes;
	}
}

export class FrameMux {
	private readonly handlers = new Map<ChannelId, FrameHandler>();
	private readonly seq = new Map<ChannelId, number>();
	private readonly assembler = new FrameAssembler();
	private nextTransferId = 0;

	constructor(private readonly channel: SecureChannel, private readonly options: FrameMuxOptions) { }

	/** 指定チャネルの受信ハンドラを登録する。 */
	on(channel: ChannelId, handler: FrameHandler): void {
		this.handlers.set(channel, handler);
	}

	/** アプリ層フレームを送る（seqは自動採番。16KiB を超えるペイロードは断片に切って続けて送る）。 */
	send(channel: ChannelId, payload: Uint8Array, ws?: string): void {
		const seq = (this.seq.get(channel) ?? 0);
		this.seq.set(channel, (seq + 1) % 0x100000000);
		if (payload.length <= FRAME_CHUNK_BYTES) {
			// 断片の見出しを付けない（版 3 と同じバイト列）
			this.options.sendSealed(this.channel.seal(encodeFrame({ ch: channel, seq, payload, ...(ws !== undefined ? { ws } : {}) })));
			return;
		}
		const id = this.nextTransferId;
		this.nextTransferId = (this.nextTransferId + 1) % 0x100000000;
		for (let offset = 0, index = 0; offset < payload.length; offset += FRAME_CHUNK_BYTES, index++) {
			const end = Math.min(offset + FRAME_CHUNK_BYTES, payload.length);
			const frame: Frame = {
				ch: channel,
				seq,
				payload: payload.subarray(offset, end),
				...(ws !== undefined ? { ws } : {}),
				frag: { id, index, last: end >= payload.length },
			};
			this.options.sendSealed(this.channel.seal(encodeFrame(frame)));
		}
	}

	/** transportから届いた封緘バイト列を処理する。 */
	receive(sealed: Uint8Array): void {
		const onChunkOpened = this.options.onChunkOpened;
		const openStartedAt = onChunkOpened !== undefined ? Date.now() : 0;
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
		if (onChunkOpened !== undefined) {
			const more = frame.frag !== undefined ? !frame.frag.last : frame.more === true;
			try {
				onChunkOpened({ ch: frame.ch, bytes: frame.payload.length, more, openMs: Date.now() - openStartedAt });
			} catch { /* 計測の失敗で受信を止めない */ }
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
		const handler = this.handlers.get(full.ch);
		if (handler) {
			handler(full);
		}
	}
}
