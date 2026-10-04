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
	/** 断片を封緘している最中（nonce を採った）。差し替えの対象にしない。 */
	sealing: boolean;
	/** 列から外れた（送り終えた・取り下げた・失敗した）。未送信のバイト数は外したときに 1 回だけ引く。 */
	settled: boolean;
	/** cancelOwner で取り下げた。封緘し終えた断片も送らない（鍵ごと捨てたセッション）。 */
	cancelled: boolean;
	/** 列の先頭で待ち始めた時刻（画面の JPEG の繰り上げに使う）。 */
	waitingSince: number;
	readonly resolve: (sent: boolean) => void;
	readonly reject: (error: unknown) => void;
}

/** 画面の JPEG は、操作・状態が流れ続けても、先頭でこれだけ待ったら操作・状態より先に 1 断片送る。 */
export const PARADIS_MOBILE_SCREEN_MAX_WAIT_MS = 500;
/**
 * bufferedAmount が閾値を超えたままこれだけ変わらなければ、その値を信用しない（減らない実装・取れない実装への保険。
 * Electron 43 の Node 24.20 の WebSocket では送るたびに減ることを確かめてある）。
 */
export const PARADIS_MOBILE_STUCK_BUFFER_MS = 2_000;
/** 信用しないときの、時間で決める送る速さ。 */
export const PARADIS_MOBILE_FALLBACK_PACE_BYTES_PER_SECOND = 256 * 1024;

export interface IParadisMobileSendQueueOptions {
	/** リレーへのソケットの送信バッファ（bufferedAmount）。無ければ常に空とみなす。 */
	readonly bufferedAmount?: () => number;
	readonly highWaterBytes?: number;
	readonly setTimeout?: (handler: () => void, ms: number) => unknown;
	readonly now?: () => number;
}

/** 全端末で 1 本の送信の列。 */
export class ParadisMobileSendQueue {
	// 優先度ごとに、owner ごとの列。Map は owner を積んだ順を保つので、その順に 1 断片ずつ回す
	private readonly lanes: Map<object, IQueuedTransfer[]>[] = Array.from({ length: PRIORITY_COUNT }, () => new Map());
	// 優先度ごとの、最後に断片を送った owner（次はその次の owner から回す）
	private readonly lastServed: (object | undefined)[] = new Array(PRIORITY_COUNT).fill(undefined);
	// 優先度ごとの、まだ送っていないバイト数
	private readonly unsent: number[] = new Array(PRIORITY_COUNT).fill(0);
	private pumping = false;
	private readonly highWater: number;
	// bufferedAmount を信用できるかの見張り
	private observedBuffered = -1;
	private observedBufferedSince = 0;
	private pacing = false;
	private paceNextAt = 0;

	constructor(private readonly options: IParadisMobileSendQueueOptions = {}) {
		this.highWater = options.highWaterBytes ?? PARADIS_MOBILE_SOCKET_HIGH_WATER_BYTES;
	}

	/** まだ送っていない（列に残っている）ペイロードのバイト数。 */
	get pendingBytes(): number {
		return this.unsent.reduce((sum, bytes) => sum + bytes, 0);
	}

	/** bufferedAmount を信用せず、時間で決める速さで送っているか。 */
	get isPacing(): boolean {
		return this.pacing;
	}

	/**
	 * 音声の送信の詰まり（ソケットの送信バッファ ＋ 音声の列の未送信分）。画面の JPEG・ファイルの応答のように、音声より
	 * 後に送る列は数えない（音声はそれらを追い越すので、流しても遅れない）。
	 */
	congestionBytes(): number {
		return this.unsent[ParadisMobileSendPriority.Voice]! + this.socketBuffered();
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
				// まだ 1 断片も封緘していないものだけ差し替える（封緘中のものは nonce を採っているので必ず送る）
				for (const queued of [...queue]) {
					if (queued.next === 0 && !queued.sealing && queued.transfer.replaceKey === transfer.replaceKey) {
						this.settle(queued);
						queued.resolve(false);
					}
				}
			}
			// 差し替えで列が空になると owner ごと外れているので、積み直す先を取り直す
			queue = lane.get(transfer.owner);
			if (queue === undefined) {
				queue = [];
				lane.set(transfer.owner, queue);
			}
			queue.push({ transfer, next: 0, sentBytes: 0, sealing: false, settled: false, cancelled: false, waitingSince: this.now(), resolve, reject });
			this.unsent[transfer.priority]! += transfer.bytes;
			this.pump();
		});
	}

	/** その owner の送信を全部取り下げる（暗号セッションを張り替えた・捨てた）。送り途中・封緘中のものも捨てる。 */
	cancelOwner(owner: object): void {
		for (let priority = 0; priority < PRIORITY_COUNT; priority++) {
			const queue = this.lanes[priority]!.get(owner);
			if (this.lastServed[priority] === owner) {
				this.lastServed[priority] = undefined;
			}
			if (queue === undefined) {
				continue;
			}
			for (const queued of [...queue]) {
				queued.cancelled = true;
				this.settle(queued);
				queued.resolve(false);
			}
		}
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private socketBuffered(): number {
		try {
			const value = this.options.bufferedAmount?.() ?? 0;
			return Number.isFinite(value) && value > 0 ? value : 0;
		} catch {
			return 0;
		}
	}

	/** 列から外し、未送信のバイト数を 1 回だけ引く。 */
	private settle(queued: IQueuedTransfer): void {
		if (queued.settled) {
			return;
		}
		queued.settled = true;
		this.unsent[queued.transfer.priority]! -= queued.transfer.bytes - queued.sentBytes;
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

	/** 優先度の中で、owner を順に回して次の送信を選ぶ。 */
	private pickIn(priority: number): IQueuedTransfer | undefined {
		const lane = this.lanes[priority]!;
		if (lane.size === 0) {
			return undefined;
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
		return undefined;
	}

	/** 次に送る断片を選ぶ（音声 → 待ちすぎた画面 → 操作・状態 → 画面）。 */
	private pick(): IQueuedTransfer | undefined {
		const voice = this.pickIn(ParadisMobileSendPriority.Voice);
		if (voice !== undefined) {
			return voice;
		}
		const now = this.now();
		for (const queue of this.lanes[ParadisMobileSendPriority.Screen]!.values()) {
			const head = queue[0];
			if (head !== undefined && now - head.waitingSince >= PARADIS_MOBILE_SCREEN_MAX_WAIT_MS && this.lanes[ParadisMobileSendPriority.Control]!.size > 0) {
				return head;
			}
		}
		return this.pickIn(ParadisMobileSendPriority.Control) ?? this.pickIn(ParadisMobileSendPriority.Screen);
	}

	/**
	 * 今は送れないなら待つ時間（ms）。bufferedAmount が閾値を超えていれば待つ。超えたまま 2 秒変わらなければその値を
	 * 信用せず、256KiB/秒 の速さで送る。値が変われば信用し直す。
	 */
	private waitBeforeSend(): number {
		const buffered = this.socketBuffered();
		const now = this.now();
		if (buffered !== this.observedBuffered) {
			this.observedBuffered = buffered;
			this.observedBufferedSince = now;
			this.pacing = false;
		}
		if (!this.pacing && buffered > this.highWater && now - this.observedBufferedSince >= PARADIS_MOBILE_STUCK_BUFFER_MS) {
			this.pacing = true;
			this.paceNextAt = now;
		}
		if (this.pacing) {
			return Math.max(0, this.paceNextAt - now);
		}
		return buffered > this.highWater ? DRAIN_POLL_MS : 0;
	}

	private pump(): void {
		if (this.pumping) {
			return;
		}
		this.pumping = true;
		void this.drain();
	}

	private async drain(): Promise<void> {
		for (; ;) {
			if (this.lanes.every(lane => lane.size === 0)) {
				// 同期で戻す（ここから次の enqueue の pump までの間に、取りこぼす隙を作らない）
				this.pumping = false;
				return;
			}
			// 待つかは選ぶ前に決める（待つ間に順番を回さない）
			const wait = this.waitBeforeSend();
			if (wait > 0) {
				await new Promise<void>(resolve => (this.options.setTimeout ?? setTimeout)(resolve, wait));
				continue;
			}
			const queued = this.pick();
			if (queued === undefined) {
				this.pumping = false;
				return;
			}
			const transfer = queued.transfer;
			const index = queued.next;
			let sealed: Uint8Array;
			queued.sealing = true;
			try {
				sealed = await transfer.sealFragment(index);
			} catch (error) {
				queued.sealing = false;
				const wasSettled = queued.settled;
				this.settle(queued);
				if (!wasSettled) {
					queued.reject(error);
				}
				continue;
			} finally {
				queued.sealing = false;
			}
			if (queued.cancelled) {
				// 封緘している間に鍵ごと捨てられた（セッションを張り替えた）。古い鍵のバイト列は送らない
				continue;
			}
			const remaining = transfer.bytes - queued.sentBytes;
			const fragmentBytes = index === transfer.fragmentCount - 1 ? remaining : Math.min(PARADIS_MOBILE_FRAGMENT_BYTES, remaining);
			queued.next++;
			queued.sentBytes += fragmentBytes;
			this.unsent[transfer.priority]! -= fragmentBytes;
			queued.waitingSince = this.now();
			if (this.pacing) {
				this.paceNextAt = Math.max(this.paceNextAt, this.now()) + (fragmentBytes + 64) * 1000 / PARADIS_MOBILE_FALLBACK_PACE_BYTES_PER_SECOND;
			}
			const last = queued.next >= transfer.fragmentCount;
			if (last) {
				this.settle(queued);
			}
			try {
				transfer.sendSealed(sealed, index);
			} catch (error) {
				this.settle(queued);
				queued.reject(error);
				continue;
			}
			if (last) {
				queued.resolve(true);
			}
		}
	}
}

const VOICE_STREAM_MAGIC = [0x50, 0x56, 0x53, 0x01]; // "PVS" + 1
const SCREEN_JPEG_MAGIC = [0x50, 0x4a, 0x46, 0x01]; // "PJF" + 1
const JSON_VOICE_PREFIX = '{"t":"voice-stream-';
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
 * browser チャネルのペイロードから優先度を決める。音声の流れ（2 進の断片 `PVS\x01`、`voice-stream-*` の JSON）は先に、
 * 画面（2 進の JPEG `PJF\x01`、`frame` の JSON）は後に送る。PC のシリアライズは常に `t` が先頭のキー。
 * それ以外のチャネル・ペイロードは操作・状態。1 本まるごとの `voice-clip`（詰まったときの救済・古いアプリ向け）は
 * 数 MB になりうるので操作・状態に置く（音声の列を塞がない）。
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
