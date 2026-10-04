/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PC からモバイルへ送るフレームの送信の列（mux の版 4、設計 3.5 / 3.6 N7）。
//
// - 大きなフレームは 16KiB ずつの断片に切る。送る順は断片ごとに優先度（音声 → 操作・状態 → 画面 JPEG）で決める
// - 暗号化（AES-GCM のカウンタ nonce）は送る直前に 1 断片ずつ行い、1 断片ずつ順に送る。nonce の順＝送る順が保たれる
// - PC からリレーへのソケットは全端末で 1 本なので、列も全端末で 1 本にし、そのソケットの bufferedAmount が
//   32KiB を超えている間は次を積まない
// - 同じ端末・同じ優先度の中は積んだ順（送信をまたいで交互にしない）。端末の間は 1 断片ずつ順番に回す
// - まだ 1 断片も送っていない画面の JPEG は、同じ端末の新しい JPEG が来たら捨てる

/** 送る順の優先度。小さいほど先に送る。 */
export const ParadisMobileSendPriority = {
	Voice: 0,
	Control: 1,
	Screen: 2,
} as const;
export type ParadisMobileSendPriority = typeof ParadisMobileSendPriority[keyof typeof ParadisMobileSendPriority];

/** 断片 1 つのペイロード上限（app/protocol/src/mux.ts の FRAME_CHUNK_BYTES と一致）。 */
export const PARADIS_MOBILE_FRAGMENT_BYTES = 16 * 1024;
/** リレーへのソケットの送信バッファがこれを超えたら、次の断片を積まない。 */
export const PARADIS_MOBILE_SOCKET_HIGH_WATER_BYTES = 32 * 1024;
/** 送信バッファが空くのを確かめる間隔。 */
const DRAIN_POLL_MS = 5;

const PRIORITY_COUNT = 3;

/** 1 つの論理フレームの送り方。 */
export interface IParadisMobileSendTransfer {
	/** 送り手（FrameMux）。{@link ParadisMobileSendQueue.cancelOwner} で丸ごと取り下げる単位。 */
	readonly owner: object;
	readonly priority: ParadisMobileSendPriority;
	/** 同じ owner・同じ鍵の、まだ送り始めていない送信を置き換える（画面の JPEG）。 */
	readonly replaceKey?: string;
	/** 断片の数。 */
	readonly fragmentCount: number;
	/** ペイロードのバイト数（詰まりの計算に使う）。 */
	readonly bytes: number;
	/** index 番目の断片を封緘する（nonce を採る）。送る直前に 1 つずつ呼ぶ。 */
	sealFragment(index: number): Promise<Uint8Array>;
	/** 封緘した断片を送る。 */
	sendSealed(sealed: Uint8Array, index: number): void;
}

interface IQueuedTransfer {
	readonly transfer: IParadisMobileSendTransfer;
	next: number;
	sentBytes: number;
	readonly resolve: (sent: boolean) => void;
	readonly reject: (error: unknown) => void;
}

export interface IParadisMobileSendQueueOptions {
	/** リレーへのソケットの送信バッファ（bufferedAmount）。無ければ常に空とみなす。 */
	readonly bufferedAmount?: () => number;
	readonly highWaterBytes?: number;
	readonly setTimeout?: (handler: () => void, ms: number) => unknown;
}

/** 全端末で 1 本の送信の列。 */
export class ParadisMobileSendQueue {
	// 優先度ごとに、owner ごとの列。Map は owner を積んだ順を保つので、その順に 1 断片ずつ回す
	private readonly lanes: Map<object, IQueuedTransfer[]>[] = Array.from({ length: PRIORITY_COUNT }, () => new Map());
	// 優先度ごとの、最後に断片を送った owner（次はその次の owner から回す）
	private readonly lastServed: (object | undefined)[] = new Array(PRIORITY_COUNT).fill(undefined);
	private pumping = false;
	private unsentBytes = 0;
	private readonly highWater: number;

	constructor(private readonly options: IParadisMobileSendQueueOptions = {}) {
		this.highWater = options.highWaterBytes ?? PARADIS_MOBILE_SOCKET_HIGH_WATER_BYTES;
	}

	/** まだ送っていない（列に残っている）ペイロードのバイト数。 */
	get pendingBytes(): number {
		return this.unsentBytes;
	}

	/** 送信の詰まり（列に残っている分 ＋ ソケットの送信バッファ）。 */
	congestionBytes(): number {
		return this.unsentBytes + this.socketBuffered();
	}

	/**
	 * 送信を積む。最後の断片を送ったら true、送り始める前に取り下げられたら false で解決する。
	 * 呼んだ時点で列に入る（同じ owner・同じ優先度の中は呼んだ順に送る）。
	 */
	enqueue(transfer: IParadisMobileSendTransfer): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			const lane = this.lanes[transfer.priority]!;
			let queue = lane.get(transfer.owner);
			if (queue === undefined) {
				queue = [];
				lane.set(transfer.owner, queue);
			}
			if (transfer.replaceKey !== undefined) {
				for (let i = queue.length - 1; i >= 0; i--) {
					const queued = queue[i]!;
					if (queued.next === 0 && queued.transfer.replaceKey === transfer.replaceKey) {
						queue.splice(i, 1);
						this.unsentBytes -= queued.transfer.bytes;
						queued.resolve(false);
					}
				}
			}
			queue.push({ transfer, next: 0, sentBytes: 0, resolve, reject });
			this.unsentBytes += transfer.bytes;
			this.pump();
		});
	}

	/** その owner の送信を全部取り下げる（暗号セッションを張り替えた・捨てた）。送り途中のものも捨てる。 */
	cancelOwner(owner: object): void {
		for (const lane of this.lanes) {
			const queue = lane.get(owner);
			if (queue === undefined) {
				continue;
			}
			lane.delete(owner);
			for (const queued of queue) {
				this.unsentBytes -= queued.transfer.bytes - queued.sentBytes;
				queued.resolve(false);
			}
		}
	}

	private socketBuffered(): number {
		try {
			const value = this.options.bufferedAmount?.() ?? 0;
			return Number.isFinite(value) && value > 0 ? value : 0;
		} catch {
			return 0;
		}
	}

	/** 次に送る断片を選ぶ（優先度の高い順、同じ優先度の中は owner を順に回す）。 */
	private pick(): IQueuedTransfer | undefined {
		for (let priority = 0; priority < PRIORITY_COUNT; priority++) {
			const lane = this.lanes[priority]!;
			if (lane.size === 0) {
				continue;
			}
			const owners = [...lane.keys()];
			const start = owners.indexOf(this.lastServed[priority]!) + 1;
			for (let step = 0; step < owners.length; step++) {
				const owner = owners[(start + step) % owners.length]!;
				const queue = lane.get(owner)!;
				if (queue.length === 0) {
					lane.delete(owner);
					continue;
				}
				this.lastServed[priority] = owner;
				return queue[0]!;
			}
		}
		return undefined;
	}

	private pump(): void {
		if (this.pumping) {
			return;
		}
		this.pumping = true;
		void this.drain().finally(() => {
			this.pumping = false;
		});
	}

	private async drain(): Promise<void> {
		for (; ;) {
			const queued = this.pick();
			if (queued === undefined) {
				return;
			}
			if (this.socketBuffered() > this.highWater) {
				await new Promise<void>(resolve => (this.options.setTimeout ?? setTimeout)(resolve, DRAIN_POLL_MS));
				continue;
			}
			const transfer = queued.transfer;
			const index = queued.next;
			let sealed: Uint8Array;
			try {
				sealed = await transfer.sealFragment(index);
			} catch (error) {
				this.remove(queued);
				this.unsentBytes -= transfer.bytes - queued.sentBytes;
				queued.reject(error);
				continue;
			}
			if (!this.contains(queued)) {
				// 封緘している間に取り下げられた（セッションを張り替えた）。古い鍵のバイト列は送らない
				continue;
			}
			const fragmentBytes = index === transfer.fragmentCount - 1 ? transfer.bytes - queued.sentBytes : Math.min(PARADIS_MOBILE_FRAGMENT_BYTES, transfer.bytes - queued.sentBytes);
			queued.next++;
			queued.sentBytes += fragmentBytes;
			this.unsentBytes -= fragmentBytes;
			const last = queued.next >= transfer.fragmentCount;
			if (last) {
				this.remove(queued);
			}
			try {
				transfer.sendSealed(sealed, index);
			} catch (error) {
				if (!last) {
					this.remove(queued);
					this.unsentBytes -= transfer.bytes - queued.sentBytes;
				}
				queued.reject(error);
				continue;
			}
			if (last) {
				queued.resolve(true);
			}
		}
	}

	private contains(queued: IQueuedTransfer): boolean {
		return this.lanes[queued.transfer.priority]!.get(queued.transfer.owner)?.includes(queued) === true;
	}

	private remove(queued: IQueuedTransfer): void {
		const lane = this.lanes[queued.transfer.priority]!;
		const queue = lane.get(queued.transfer.owner);
		if (queue === undefined) {
			return;
		}
		const index = queue.indexOf(queued);
		if (index >= 0) {
			queue.splice(index, 1);
		}
		if (queue.length === 0) {
			lane.delete(queued.transfer.owner);
		}
	}
}

const VOICE_STREAM_MAGIC = [0x50, 0x56, 0x53, 0x01]; // "PVS" + 1
const SCREEN_JPEG_MAGIC = [0x50, 0x4a, 0x46, 0x01]; // "PJF" + 1
const JSON_VOICE_PREFIX = '{"t":"voice-';
const JSON_FRAME_PREFIX = '{"t":"frame"';

function startsWithBytes(payload: Uint8Array, magic: readonly number[]): boolean {
	if (payload.length < magic.length) {
		return false;
	}
	for (let i = 0; i < magic.length; i++) {
		if (payload[i] !== magic[i]) {
			return false;
		}
	}
	return true;
}

function startsWithAscii(payload: Uint8Array, prefix: string): boolean {
	if (payload.length < prefix.length) {
		return false;
	}
	for (let i = 0; i < prefix.length; i++) {
		if (payload[i] !== prefix.charCodeAt(i)) {
			return false;
		}
	}
	return true;
}

/**
 * browser チャネルのペイロードから優先度を決める。音声（2 進の断片 `PVS\x01`、`voice-*` の JSON）は先に、
 * 画面（2 進の JPEG `PJF\x01`、`frame` の JSON）は後に送る。PC のシリアライズは常に `t` が先頭のキー。
 * それ以外のチャネル・ペイロードは操作・状態。
 */
export function paradisMobileSendPriorityOf(channel: string, payload: Uint8Array): { readonly priority: ParadisMobileSendPriority; readonly replaceKey?: string } {
	if (channel !== 'browser') {
		return { priority: ParadisMobileSendPriority.Control };
	}
	if (startsWithBytes(payload, VOICE_STREAM_MAGIC) || startsWithAscii(payload, JSON_VOICE_PREFIX)) {
		return { priority: ParadisMobileSendPriority.Voice };
	}
	if (startsWithBytes(payload, SCREEN_JPEG_MAGIC) || startsWithAscii(payload, JSON_FRAME_PREFIX)) {
		return { priority: ParadisMobileSendPriority.Screen, replaceKey: 'screencast' };
	}
	return { priority: ParadisMobileSendPriority.Control };
}
