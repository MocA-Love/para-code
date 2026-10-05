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
// - 画面の JPEG が先頭で 500ms 待ったら、操作・状態より先にその 1 枚を最後まで送る
// - bufferedAmount を信用せず時間で送っている間は、積む量を 2MiB までにする
// - 計測（F0、`paradisMobileLinkMetrics.ts`）がオンなら、各段の待ち・封緘の時間・送信バッファの深さを数える（送る順は変えない）
// - 順序ドメイン（ストリーム、設計 2.0 / 2.1）: 同じ owner・同じ stream の送信は、優先度が違っても積んだ順に送る。
//   各ストリームの先頭だけが候補になり、優先度は独立したストリームの間でだけ効く
// - 送信前の列に全体・端末（owner）・ストリームのバイト上限を置く（設計 2.3）。上限を守るのは `submit` で
//   `bounded` を付けた送信だけで、超えるなら列に入れずに busy を返す（小さな送信はいつでも受ける）
// - 取消は 2 種類ある。`cancelOwner` は暗号セッションごと捨てるとき（封緘中・送り途中も捨てる）、`cancelTag` は
//   renderer の世代が替わったときで、まだ 1 断片も封緘していない（nonce を予約していない）送信だけを取り下げる

import type { ParadisMobileLinkMetrics } from './paradisMobileLinkMetrics.js';

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
/** 計測の名前に使う優先度の呼び名。 */
const PRIORITY_NAMES = ['voice', 'control', 'screen'] as const;

/** 1 つの論理フレームの送り方。 */
export interface IParadisMobileSendTransfer {
	/** 送り手（FrameMux）。{@link ParadisMobileSendQueue.cancelOwner} で丸ごと取り下げる単位。 */
	readonly owner: object;
	readonly priority: ParadisMobileSendPriority;
	/** 同じ owner・同じ鍵の、まだ送り始めていない送信を置き換える（画面の JPEG）。 */
	readonly replaceKey?: string;
	/**
	 * 音声の列の中の順は守るが、操作・状態と 1 断片ずつ交互に送る（数 MB になりうる救済の `voice-clip`。遅い回線で操作を
	 * 止めない）。
	 */
	readonly interleave?: boolean;
	/**
	 * 順序ドメイン。同じ owner・同じ stream の送信は優先度が違っても積んだ順に送る（同じターミナルの出力、snapshot と
	 * その後の delta が追い越さない）。省略すると優先度ごとに 1 本（従来の「同じ owner・同じ優先度は積んだ順」）。
	 */
	readonly stream?: string;
	/**
	 * 取消の単位（送り手の renderer の世代など）。{@link ParadisMobileSendQueue.cancelTag} で、nonce を予約する前の
	 * 送信だけを取り下げる。暗号セッションの owner とは別のもの。
	 */
	readonly cancelTag?: string;
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
	/** 順序ドメインの鍵（{@link IParadisMobileSendTransfer.stream}、省略時は優先度から作る）。 */
	readonly stream: string;
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
	/** 積んだ時刻（計測の時計。計測がオフなら 0）。 */
	readonly enqueuedAt: number;
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
/**
 * 時間で決める速さで送っている間に積んでよい量の上限。本当に TCP が止まっている（相手が受け取らない）ときに、値が
 * 変わらないまま送り続けて送信バッファを際限なく膨らませないため。超えたら値が変わるまで待つ。
 */
export const PARADIS_MOBILE_PACING_MAX_BYTES = 2 * 1024 * 1024;

/** 送信前の列（全端末の合計）の上限。`bounded` の送信だけがこれで断られる。 */
export const PARADIS_MOBILE_QUEUE_GLOBAL_LIMIT_BYTES = 96 * 1024 * 1024;
/** 送信前の列（1 台の端末＝owner）の上限。 */
export const PARADIS_MOBILE_QUEUE_MOBILE_LIMIT_BYTES = 48 * 1024 * 1024;
/** 送信前の列（1 本のストリーム）の上限。ファイルの応答の上限（24MiB）が 1 件は必ず入る大きさ。 */
export const PARADIS_MOBILE_QUEUE_STREAM_LIMIT_BYTES = 32 * 1024 * 1024;
/**
 * これ以下の送信は上限を超えていても受ける（操作の結果・エラーの返事・端末の出力の小片を断ると、相手が待ち続けたり、
 * ストリームに穴が開いたりする）。端末の出力はアプリの ack で、通知は件数で、別に抑えられている。
 */
export const PARADIS_MOBILE_QUEUE_ALWAYS_ACCEPT_BYTES = 64 * 1024;

/** 積んだ送信の終わり方。 */
export type ParadisMobileSendResult = 'sent' | 'cancelled' | 'failed';

/**
 * `submit` の返り値。列に入れた（accepted）ことと、送り終えた（settled）ことを分ける。`accepted` が false なら
 * 列に入れておらず、`settled` は 'cancelled' で解決する。
 */
export interface IParadisMobileSendHandle {
	readonly accepted: boolean;
	/** 列に入れなかった理由。busy＝送信前の列が上限、closed＝暗号セッションが無い・閉じた。 */
	readonly reason?: 'busy' | 'closed';
	readonly settled: Promise<ParadisMobileSendResult>;
}

/** 列に入れなかったときの handle。 */
export function paradisMobileRejectedSend(reason: 'busy' | 'closed'): IParadisMobileSendHandle {
	return { accepted: false, reason, settled: Promise.resolve('cancelled') };
}

export interface IParadisMobileSendQueueOptions {
	/** リレーへのソケットの送信バッファ（bufferedAmount）。無ければ常に空とみなす。 */
	readonly bufferedAmount?: () => number;
	readonly highWaterBytes?: number;
	readonly setTimeout?: (handler: () => void, ms: number) => unknown;
	readonly now?: () => number;
	/** 通信の計測（F0）。オフの間は何も数えない。 */
	readonly metrics?: ParadisMobileLinkMetrics;
}

/** 全端末で 1 本の送信の列。 */
export class ParadisMobileSendQueue {
	// 優先度ごとに、owner ごとの列。Map は owner を積んだ順を保つので、その順に 1 断片ずつ回す
	private readonly lanes: Map<object, IQueuedTransfer[]>[] = Array.from({ length: PRIORITY_COUNT }, () => new Map());
	// owner ごと・ストリームごとの、積んだ順の列（優先度をまたぐ）。先頭だけが送る候補になる
	private readonly streams = new Map<object, Map<string, IQueuedTransfer[]>>();
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
	/** 時間で決める速さに切り替えてから積んだ量。 */
	private pacedBytes = 0;
	/** 直前に送ったのが、操作・状態と交互に送る音声（救済の clip）だった。 */
	private lastWasInterleaved = false;
	/** 待ちすぎて繰り上げた画面の JPEG。最後の断片まで続けて送る。 */
	private promotedScreen: IQueuedTransfer | undefined;
	/** 送信バッファが閾値を超えて待ち始めた時刻（計測の時計）。 */
	private blockedSince: number | undefined;

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
		return new Promise<boolean>((resolve, reject) => this.push(transfer, resolve, reject));
	}

	/**
	 * 送信を積み、列に入れたか（accepted）と、送り終えたか（settled）を分けて返す。`bounded` なら送信前の列の上限を
	 * 守り、超えるなら列に入れずに busy を返す（{@link admits}）。封緘・送出の失敗は 'failed' で解決する（例外にしない）。
	 */
	submit(transfer: IParadisMobileSendTransfer, options: { readonly bounded?: boolean } = {}): IParadisMobileSendHandle {
		if (options.bounded === true && !this.admits(transfer.owner, this.streamOf(transfer), transfer.bytes)) {
			this.options.metrics?.count('pc.queue.busy');
			return paradisMobileRejectedSend('busy');
		}
		const settled = new Promise<ParadisMobileSendResult>(resolve => this.push(transfer, sent => resolve(sent ? 'sent' : 'cancelled'), () => resolve('failed')));
		return { accepted: true, settled };
	}

	/**
	 * この大きさの送信を、上限を守って積めるか。{@link PARADIS_MOBILE_QUEUE_ALWAYS_ACCEPT_BYTES} 以下はいつでも積める。
	 * 送り手は番号（seq・送信 ID）を進める前にこれで確かめる（断った送信で番号に穴を開けない）。
	 */
	admits(owner: object, stream: string, bytes: number): boolean {
		if (bytes <= PARADIS_MOBILE_QUEUE_ALWAYS_ACCEPT_BYTES) {
			return true;
		}
		if (this.pendingBytes + bytes > PARADIS_MOBILE_QUEUE_GLOBAL_LIMIT_BYTES) {
			return false;
		}
		const ownerStreams = this.streams.get(owner);
		if (ownerStreams === undefined) {
			return bytes <= PARADIS_MOBILE_QUEUE_STREAM_LIMIT_BYTES;
		}
		let ownerBytes = 0;
		let streamBytes = 0;
		for (const [key, queue] of ownerStreams) {
			for (const queued of queue) {
				const unsent = queued.transfer.bytes - queued.sentBytes;
				ownerBytes += unsent;
				if (key === stream) {
					streamBytes += unsent;
				}
			}
		}
		return ownerBytes + bytes <= PARADIS_MOBILE_QUEUE_MOBILE_LIMIT_BYTES && streamBytes + bytes <= PARADIS_MOBILE_QUEUE_STREAM_LIMIT_BYTES;
	}

	/** 送信の順序ドメインの鍵。 */
	streamOf(transfer: IParadisMobileSendTransfer): string {
		return transfer.stream ?? `priority:${transfer.priority}`;
	}

	private push(transfer: IParadisMobileSendTransfer, resolve: (sent: boolean) => void, reject: (error: unknown) => void): void {
		const lane = this.lanes[transfer.priority]!;
		let queue = lane.get(transfer.owner);
		if (queue === undefined) {
			queue = [];
			lane.set(transfer.owner, queue);
		}
		let waitingSince = this.now();
		if (transfer.replaceKey !== undefined) {
			// まだ 1 断片も封緘していないものだけ差し替える（封緘中のものは nonce を採っているので必ず送る）
			for (const queued of [...queue]) {
				if (queued.next === 0 && !queued.sealing && queued.transfer.replaceKey === transfer.replaceKey) {
					this.options.metrics?.count('pc.queue.screenReplaced');
					// 待った時間は引き継ぐ（差し替えが続いても、繰り上げまでの 500ms が延びないように）
					waitingSince = Math.min(waitingSince, queued.waitingSince);
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
		const metrics = this.options.metrics;
		const measuring = metrics?.enabled === true;
		if (measuring) {
			metrics.observe('pc.queue.unsentBytesAtEnqueue', this.pendingBytes);
		}
		const stream = this.streamOf(transfer);
		const queued: IQueuedTransfer = { transfer, stream, next: 0, sentBytes: 0, sealing: false, settled: false, cancelled: false, waitingSince, enqueuedAt: measuring ? metrics.now() : 0, resolve, reject };
		queue.push(queued);
		let ownerStreams = this.streams.get(transfer.owner);
		if (ownerStreams === undefined) {
			ownerStreams = new Map();
			this.streams.set(transfer.owner, ownerStreams);
		}
		let streamQueue = ownerStreams.get(stream);
		if (streamQueue === undefined) {
			streamQueue = [];
			ownerStreams.set(stream, streamQueue);
		}
		streamQueue.push(queued);
		this.unsent[transfer.priority]! += transfer.bytes;
		this.pump();
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
				this.options.metrics?.count('pc.queue.cancelled');
				queued.cancelled = true;
				this.settle(queued);
				queued.resolve(false);
			}
		}
	}

	/**
	 * その印（送り手の renderer の世代など）を付けた送信のうち、まだ 1 断片も封緘していない（nonce を予約していない）
	 * ものだけを取り下げる。封緘中・送り途中のものは順番どおり最後まで送る（途中で捨てると、同じ鍵で続く相手の厳密な
	 * nonce の検証が永久にずれる。設計 2.3 / 2.12）。取り下げた数を返す。
	 */
	cancelTag(tag: string): number {
		let cancelled = 0;
		for (const lane of this.lanes) {
			for (const queue of [...lane.values()]) {
				for (const queued of [...queue]) {
					if (queued.transfer.cancelTag !== tag || queued.next !== 0 || queued.sealing || queued.settled) {
						continue;
					}
					queued.cancelled = true;
					this.settle(queued);
					queued.resolve(false);
					cancelled++;
				}
			}
		}
		if (cancelled > 0) {
			this.options.metrics?.count('pc.queue.cancelledByTag', cancelled);
		}
		return cancelled;
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
		if (this.promotedScreen === queued) {
			this.promotedScreen = undefined;
		}
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
		this.removeFromStream(queued);
	}

	private removeFromStream(queued: IQueuedTransfer): void {
		const ownerStreams = this.streams.get(queued.transfer.owner);
		const streamQueue = ownerStreams?.get(queued.stream);
		if (ownerStreams === undefined || streamQueue === undefined) {
			return;
		}
		const index = streamQueue.indexOf(queued);
		if (index >= 0) {
			streamQueue.splice(index, 1);
		}
		if (streamQueue.length === 0) {
			ownerStreams.delete(queued.stream);
			if (ownerStreams.size === 0) {
				this.streams.delete(queued.transfer.owner);
			}
		}
	}

	/** そのストリームの先頭（送る候補になれる）か。 */
	private isStreamHead(queued: IQueuedTransfer): boolean {
		return this.streams.get(queued.transfer.owner)?.get(queued.stream)?.[0] === queued;
	}

	/** その列の中で、最初にストリームの先頭になっている送信（同じストリームの前の送信が別の優先度で待っていれば飛ばす）。 */
	private firstSendable(queue: readonly IQueuedTransfer[]): IQueuedTransfer | undefined {
		for (const queued of queue) {
			if (this.isStreamHead(queued)) {
				return queued;
			}
		}
		return undefined;
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
			// ストリームの先頭だけが候補（優先度は独立したストリームの間でだけ効く）
			const sendable = this.firstSendable(queue);
			if (sendable === undefined) {
				continue;
			}
			this.lastServed[priority] = owner;
			return sendable;
		}
		return undefined;
	}

	/** 次に送る断片を選ぶ（音声 → 待ちすぎた画面 → 操作・状態 → 画面）。 */
	private pick(): IQueuedTransfer | undefined {
		const voice = this.pickIn(ParadisMobileSendPriority.Voice);
		if (voice !== undefined) {
			if (voice.transfer.interleave === true) {
				// 救済の clip は操作・状態と 1 断片ずつ交互に（音声の列の中の順は崩さない）
				if (this.lastWasInterleaved && this.lanes[ParadisMobileSendPriority.Control]!.size > 0) {
					const control = this.pickIn(ParadisMobileSendPriority.Control);
					if (control !== undefined) {
						this.lastWasInterleaved = false;
						return control;
					}
				}
				this.lastWasInterleaved = true;
				return voice;
			}
			this.lastWasInterleaved = false;
			return voice;
		}
		this.lastWasInterleaved = false;
		// 繰り上げた画面の JPEG は、操作・状態より先に最後まで続けて送る（1 断片ずつだと 1 枚が届くまで何秒もかかる）
		if (this.promotedScreen !== undefined && !this.promotedScreen.settled) {
			return this.promotedScreen;
		}
		const now = this.now();
		for (const queue of this.lanes[ParadisMobileSendPriority.Screen]!.values()) {
			const head = this.firstSendable(queue);
			if (head !== undefined && now - head.waitingSince >= PARADIS_MOBILE_SCREEN_MAX_WAIT_MS && this.lanes[ParadisMobileSendPriority.Control]!.size > 0) {
				this.promotedScreen = head;
				return head;
			}
		}
		return this.pickIn(ParadisMobileSendPriority.Control) ?? this.pickIn(ParadisMobileSendPriority.Screen);
	}

	/**
	 * 今は送れないなら待つ時間（ms）。bufferedAmount が閾値を超えていれば待つ。時間ベースの安全策に切り替えるのは、
	 * 閾値を超えたまま値が 2 秒「まったく変わらない」ときだけ（減らない・取れない実装への保険）。値が動いている間は、
	 * どれだけ大きくても待ち続ける。切り替えた後は 256KiB/秒 の速さで送り、値が変われば信用し直す。
	 */
	private waitBeforeSend(): number {
		const buffered = this.socketBuffered();
		const now = this.now();
		if (buffered !== this.observedBuffered) {
			this.observedBuffered = buffered;
			this.observedBufferedSince = now;
			this.pacing = false;
			this.pacedBytes = 0;
		}
		if (!this.pacing && buffered > this.highWater && now - this.observedBufferedSince >= PARADIS_MOBILE_STUCK_BUFFER_MS) {
			this.options.metrics?.count('pc.queue.pacingEntered');
			this.pacing = true;
			this.paceNextAt = now;
			this.pacedBytes = 0;
		}
		if (this.pacing) {
			if (this.pacedBytes >= PARADIS_MOBILE_PACING_MAX_BYTES) {
				// 値が変わらないまま上限まで積んだ。本当に止まっているかもしれないので、値が動くまで待つ
				return DRAIN_POLL_MS;
			}
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
			const metrics = this.options.metrics;
			if (wait > 0) {
				if (metrics?.enabled === true && this.blockedSince === undefined) {
					this.blockedSince = metrics.now();
				}
				await new Promise<void>(resolve => (this.options.setTimeout ?? setTimeout)(resolve, wait));
				continue;
			}
			const measuring = metrics?.enabled === true;
			if (this.blockedSince !== undefined) {
				// 送信バッファ（または時間で決める速さ）のせいで次の断片を出せなかった、ひと続きの時間
				metrics?.observeSince('pc.queue.blockedMs', this.blockedSince);
				this.blockedSince = undefined;
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
			const priorityName = PRIORITY_NAMES[transfer.priority];
			if (measuring && index === 0 && queued.enqueuedAt > 0) {
				// 積んでから最初の断片を封緘し始めるまで（列の中の待ち）
				metrics.observeSince(`pc.queue.${priorityName}.waitMs`, queued.enqueuedAt);
			}
			const sealStartedAt = measuring ? metrics.now() : 0;
			try {
				sealed = await transfer.sealFragment(index);
				if (measuring) {
					metrics.observeSince('pc.queue.sealMs', sealStartedAt);
				}
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
				this.pacedBytes += fragmentBytes + 64;
			}
			const last = queued.next >= transfer.fragmentCount;
			if (last) {
				this.settle(queued);
			}
			if (measuring) {
				metrics.observe('pc.socket.bufferedBytes', this.socketBuffered());
			}
			try {
				transfer.sendSealed(sealed, index);
			} catch (error) {
				this.settle(queued);
				queued.reject(error);
				continue;
			}
			if (last) {
				if (measuring && queued.enqueuedAt > 0) {
					// 積んでから最後の断片をソケットへ渡すまで
					metrics.observeSince(`pc.queue.${priorityName}.totalMs`, queued.enqueuedAt);
					metrics.observe(`pc.queue.${priorityName}.bytes`, transfer.bytes);
				}
				queued.resolve(true);
			}
		}
	}
}

const VOICE_STREAM_MAGIC = [0x50, 0x56, 0x53, 0x01]; // "PVS" + 1
const SCREEN_JPEG_MAGIC = [0x50, 0x4a, 0x46, 0x01]; // "PJF" + 1
const JSON_VOICE_PREFIX = '{"t":"voice-';
const JSON_VOICE_CLIP_PREFIX = '{"t":"voice-clip"';
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
 * それ以外のチャネル・ペイロードは操作・状態。1 本まるごとの `voice-clip`（詰まったときの救済・古いアプリ向け）も
 * 音声の列に置く（同じ端末の音声は積んだ順に送るので、救済の clip が後から始まった流れに追い越されない）。ただし数 MB に
 * なりうるので、操作・状態と 1 断片ずつ交互に送る（`interleave`）。
 */
export function paradisMobileSendPriorityOf(channel: string, payload: Uint8Array): { readonly priority: ParadisMobileSendPriority; readonly replaceKey?: string; readonly interleave?: boolean } {
	if (channel !== 'browser') {
		return { priority: ParadisMobileSendPriority.Control };
	}
	if (startsWithAscii(payload, JSON_VOICE_CLIP_PREFIX)) {
		return { priority: ParadisMobileSendPriority.Voice, interleave: true };
	}
	if (startsWithBytes(payload, VOICE_STREAM_MAGIC) || startsWithAscii(payload, JSON_VOICE_PREFIX)) {
		return { priority: ParadisMobileSendPriority.Voice };
	}
	if (startsWithBytes(payload, SCREEN_JPEG_MAGIC) || startsWithAscii(payload, JSON_FRAME_PREFIX)) {
		return { priority: ParadisMobileSendPriority.Screen, replaceKey: 'screencast' };
	}
	return { priority: ParadisMobileSendPriority.Control };
}
