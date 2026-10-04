/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	paradisClampVoiceGainDb,
	paradisEncodeVoiceStreamChunk,
	PARADIS_VOICE_STREAM_BATCH_BYTES,
	PARADIS_VOICE_STREAM_BATCH_MS,
	PARADIS_VOICE_STREAM_CONGESTION_BYTES,
	PARADIS_VOICE_STREAM_MAX_BYTES,
	PARADIS_VOICE_STREAM_MIME,
	ParadisMobileVoiceEvent,
	IParadisVoiceStreamEndMessage,
	IParadisVoiceStreamStartMessage,
} from './paradisMobileVoiceStream.js';

/** Mobile renews every 20 seconds; three missed renewals expire the voice subscription. */
export const PARADIS_VOICE_SUBSCRIPTION_TTL_MS = 60_000;

/** `voice.stream.v1`（paradisMobileCompat.ts の ParadisMobileCapability.VoiceStream と同じ値）。 */
const VOICE_STREAM_CAPABILITY = 'voice.stream.v1';
/** 同時に追う流れの上限。超えた分は 1 本まるごとも送らない（出どころは通知・SSH・手元の 3 つ）。 */
const MAX_ACTIVE_STREAMS = 16;

/** A currently subscribed and online mobile that can receive the next voice clip. */
export interface IParadisVoiceRecipient {
	readonly mobileId: string;
	readonly sid: string;
}

interface IParadisVoiceSubscription {
	readonly sid: string;
	readonly renewedAt: number;
}

/** Tracks the live voice recipients. */
export class ParadisVoiceSubscriptions {
	private readonly subscriptions = new Map<string, IParadisVoiceSubscription>();

	constructor(private readonly ttlMs = PARADIS_VOICE_SUBSCRIPTION_TTL_MS) { }

	start(mobileId: string, sid: string, now: number): void {
		this.subscriptions.set(mobileId, { sid, renewedAt: now });
	}

	stop(mobileId: string, sid: string): boolean {
		if (this.subscriptions.get(mobileId)?.sid !== sid) {
			return false;
		}
		this.subscriptions.delete(mobileId);
		return true;
	}

	drop(mobileId: string): void {
		this.subscriptions.delete(mobileId);
	}

	clear(): void {
		this.subscriptions.clear();
	}

	/** その端末が、その sid でまだ購読しているか（期限切れは購読していない扱い）。 */
	isSubscribed(mobileId: string, sid: string, now: number): boolean {
		const subscription = this.subscriptions.get(mobileId);
		return subscription !== undefined && subscription.sid === sid && now - subscription.renewedAt <= this.ttlMs;
	}

	recipients(now: number, isOnline: (mobileId: string) => boolean): IParadisVoiceRecipient[] {
		const recipients: IParadisVoiceRecipient[] = [];
		for (const [mobileId, subscription] of this.subscriptions) {
			if (now - subscription.renewedAt > this.ttlMs) {
				this.subscriptions.delete(mobileId);
				continue;
			}
			if (isOnline(mobileId)) {
				recipients.push({ mobileId, sid: subscription.sid });
			}
		}
		return recipients;
	}
}

/** 音声の配信に要る、モバイルとのセッションの面。 */
export interface IParadisVoiceDeliverySession {
	readonly hasCurrentProtocol: boolean;
	readonly isOnline: boolean;
	/** 暗号セッションの世代（張り直すたびに進む）。 */
	readonly epoch: number;
	readonly capabilities: readonly string[] | undefined;
	sendFrame(payload: Uint8Array): Promise<void>;
}

export interface IParadisVoiceDeliveryOptions {
	readonly getSession: (mobileId: string) => IParadisVoiceDeliverySession | undefined;
	/** PC からリレーへのソケット全体の送信の詰まり（列に残っている分 ＋ bufferedAmount）。 */
	readonly congestionBytes: () => number;
	readonly encodeBase64: (bytes: Uint8Array) => string;
	readonly warn: (message: string, error?: unknown) => void;
	readonly now?: () => number;
	readonly setTimeout?: (handler: () => void, ms: number) => unknown;
	readonly clearTimeout?: (handle: unknown) => void;
}

interface IVoiceTarget {
	readonly sid: string;
	readonly epoch: number;
	readonly mode: 'stream' | 'clip';
}

interface IActiveVoiceStream {
	readonly id: string;
	readonly gainDb: number;
	/** 最初の音で宛先と送り方を決めた。 */
	decided: boolean;
	readonly targets: Map<string, IVoiceTarget>;
	/** 次に送る断片の番号（＝送った断片の数）。 */
	seq: number;
	sentBytes: number;
	pending: Uint8Array[];
	pendingBytes: number;
	timer: unknown;
	/** 1 本まるごとで送る宛先のために控える音声。 */
	clipChunks: Uint8Array[];
	clipBytes: number;
	/** 上限を超えて切った。以後の音は捨てる。 */
	closed: boolean;
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * 音声通知をモバイルへ配る（`voice.stream.v1` と `voice-clip`、設計 3.5）。
 *
 * - 流すかは最初の音（鳴り始め）で決める。その端末が `voice.stream.v1` を広告していて、送信の詰まりが 256KiB 以下なら
 *   流す。そうでなければ全部受け取ってから 1 本まるごとの `voice-clip`（`gainDb` 付き）で送る
 * - 流し始めたら途中で切らない。切るとき（出どころが止めた・購読をやめた・上限）は必ず `aborted: true` の end を送る
 * - 流れを始めたときの暗号セッションの世代を控え、変わったら送るのをやめる（新しいセッションのアプリは知らない流れ）
 * - 端末ごとに同時 1 本の制限は持たない。送る順は送信の列（音声の優先度の中は積んだ順）に任せる
 */
export class ParadisMobileVoiceDelivery {
	private readonly streams = new Map<string, IActiveVoiceStream>();

	constructor(private readonly subscriptions: ParadisVoiceSubscriptions, private readonly options: IParadisVoiceDeliveryOptions) { }

	handle(event: ParadisMobileVoiceEvent): void {
		switch (event.kind) {
			case 'clip':
				if (event.audio.byteLength > 0 && event.audio.byteLength <= PARADIS_VOICE_STREAM_MAX_BYTES) {
					this.sendClip(event.audio, paradisClampVoiceGainDb(event.gainDb), this.liveRecipients().map(recipient => [recipient.mobileId, recipient.sid] as const));
				}
				return;
			case 'stream-start':
				this.startStream(event.streamId, event.gainDb);
				return;
			case 'stream-data':
				this.addData(event.streamId, event.chunk);
				return;
			case 'stream-end':
				this.endStream(event.streamId, event.aborted);
				return;
		}
	}

	/** 追っている流れを捨てる（リレーへの接続を畳んだ）。 */
	clear(): void {
		for (const stream of this.streams.values()) {
			this.clearTimer(stream);
		}
		this.streams.clear();
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private liveRecipients() {
		return this.subscriptions.recipients(this.now(), mobileId => {
			const session = this.options.getSession(mobileId);
			return session?.hasCurrentProtocol === true && session.isOnline;
		});
	}

	private startStream(streamId: string, gainDb: number): void {
		if (this.streams.has(streamId) || this.streams.size >= MAX_ACTIVE_STREAMS) {
			return;
		}
		this.streams.set(streamId, {
			id: streamId,
			gainDb: paradisClampVoiceGainDb(gainDb),
			decided: false,
			targets: new Map(),
			seq: 0,
			sentBytes: 0,
			pending: [],
			pendingBytes: 0,
			timer: undefined,
			clipChunks: [],
			clipBytes: 0,
			closed: false,
		});
	}

	/** 最初の音で、宛先と送り方を決める。 */
	private decide(stream: IActiveVoiceStream): void {
		stream.decided = true;
		const recipients = this.liveRecipients();
		if (recipients.length === 0) {
			return;
		}
		// 詰まりは端末ごとには測れない（PC からリレーへのソケットは全端末で 1 本）。全体の値で決める
		const congested = this.options.congestionBytes() > PARADIS_VOICE_STREAM_CONGESTION_BYTES;
		for (const { mobileId, sid } of recipients) {
			const session = this.options.getSession(mobileId);
			if (session === undefined) {
				continue;
			}
			const canStream = !congested && session.capabilities?.includes(VOICE_STREAM_CAPABILITY) === true;
			stream.targets.set(mobileId, { sid, epoch: session.epoch, mode: canStream ? 'stream' : 'clip' });
			if (canStream) {
				const start: IParadisVoiceStreamStartMessage = { t: 'voice-stream-start', sid, streamId: stream.id, mime: PARADIS_VOICE_STREAM_MIME, gainDb: stream.gainDb, epoch: session.epoch };
				this.send(session, new TextEncoder().encode(JSON.stringify(start)));
			}
		}
	}

	private addData(streamId: string, chunk: Uint8Array): void {
		const stream = this.streams.get(streamId);
		if (stream === undefined || stream.closed || chunk.byteLength === 0) {
			return;
		}
		const first = !stream.decided;
		if (first) {
			this.decide(stream);
		}
		if (stream.targets.size === 0) {
			return;
		}
		if (stream.sentBytes + stream.pendingBytes + chunk.byteLength > PARADIS_VOICE_STREAM_MAX_BYTES) {
			this.abortStream(stream);
			return;
		}
		let hasClip = false;
		let hasStream = false;
		for (const target of stream.targets.values()) {
			hasClip ||= target.mode === 'clip';
			hasStream ||= target.mode === 'stream';
		}
		if (hasClip) {
			stream.clipChunks.push(chunk);
			stream.clipBytes += chunk.byteLength;
		}
		if (!hasStream) {
			return;
		}
		stream.pending.push(chunk);
		stream.pendingBytes += chunk.byteLength;
		// 最初の音はすぐ送る（鳴り始めを遅らせない）。その後は 8KiB か 100ms ごとにまとめる
		if (first || stream.pendingBytes >= PARADIS_VOICE_STREAM_BATCH_BYTES) {
			this.flush(stream);
		} else if (stream.timer === undefined) {
			stream.timer = (this.options.setTimeout ?? setTimeout)(() => {
				stream.timer = undefined;
				this.flush(stream);
			}, PARADIS_VOICE_STREAM_BATCH_MS);
		}
	}

	/** 宛先がまだ受け取れるか。購読をやめた端末には aborted の end を送って外す。張り直した端末は黙って外す。 */
	private liveStreamTargets(stream: IActiveVoiceStream): [IParadisVoiceDeliverySession, IVoiceTarget][] {
		const live: [IParadisVoiceDeliverySession, IVoiceTarget][] = [];
		for (const [mobileId, target] of stream.targets) {
			if (target.mode !== 'stream') {
				continue;
			}
			const session = this.options.getSession(mobileId);
			const sameSession = session !== undefined && session.hasCurrentProtocol && session.isOnline && session.epoch === target.epoch;
			if (sameSession && this.subscriptions.isSubscribed(mobileId, target.sid, this.now())) {
				live.push([session, target]);
				continue;
			}
			stream.targets.delete(mobileId);
			if (sameSession) {
				this.sendEnd(session, stream, true);
			}
		}
		return live;
	}

	private flush(stream: IActiveVoiceStream): void {
		this.clearTimer(stream);
		if (stream.pendingBytes === 0) {
			return;
		}
		const data = stream.pending.length === 1 ? stream.pending[0]! : concatBytes(stream.pending, stream.pendingBytes);
		stream.pending = [];
		stream.pendingBytes = 0;
		const targets = this.liveStreamTargets(stream);
		if (targets.length === 0) {
			return;
		}
		const payload = paradisEncodeVoiceStreamChunk(stream.id, stream.seq, data);
		stream.seq++;
		stream.sentBytes += data.byteLength;
		for (const [session] of targets) {
			this.send(session, payload);
		}
	}

	private endStream(streamId: string, aborted: boolean): void {
		const stream = this.streams.get(streamId);
		if (stream === undefined) {
			return;
		}
		this.streams.delete(streamId);
		if (stream.closed) {
			return;
		}
		if (!aborted) {
			this.flush(stream);
		}
		this.clearTimer(stream);
		for (const [session] of this.liveStreamTargets(stream)) {
			this.sendEnd(session, stream, aborted);
		}
		if (aborted || stream.clipBytes === 0) {
			return;
		}
		const clipTargets: (readonly [string, string])[] = [];
		for (const [mobileId, target] of stream.targets) {
			if (target.mode === 'clip') {
				clipTargets.push([mobileId, target.sid]);
			}
		}
		this.sendClip(concatBytes(stream.clipChunks, stream.clipBytes), stream.gainDb, clipTargets);
	}

	private abortStream(stream: IActiveVoiceStream): void {
		stream.closed = true;
		this.clearTimer(stream);
		stream.pending = [];
		stream.pendingBytes = 0;
		stream.clipChunks = [];
		for (const [session] of this.liveStreamTargets(stream)) {
			this.sendEnd(session, stream, true);
		}
		stream.targets.clear();
	}

	private sendEnd(session: IParadisVoiceDeliverySession, stream: IActiveVoiceStream, aborted: boolean): void {
		const end: IParadisVoiceStreamEndMessage = { t: 'voice-stream-end', streamId: stream.id, seq: stream.seq, bytes: stream.sentBytes, aborted };
		this.send(session, new TextEncoder().encode(JSON.stringify(end)));
	}

	private sendClip(audio: Uint8Array, gainDb: number, recipients: readonly (readonly [string, string])[]): void {
		if (recipients.length === 0) {
			return;
		}
		const data = this.options.encodeBase64(audio);
		for (const [mobileId, sid] of recipients) {
			const session = this.options.getSession(mobileId);
			if (session === undefined || !session.hasCurrentProtocol || !session.isOnline) {
				continue;
			}
			this.send(session, new TextEncoder().encode(JSON.stringify({ t: 'voice-clip', sid, mime: PARADIS_VOICE_STREAM_MIME, data, gainDb })));
		}
	}

	private send(session: IParadisVoiceDeliverySession, payload: Uint8Array): void {
		let delivery: Promise<void>;
		try {
			delivery = session.sendFrame(payload);
		} catch (error) {
			this.options.warn('[paradisMobileRelay] voice send failed', error);
			return;
		}
		delivery.catch(error => this.options.warn('[paradisMobileRelay] voice send failed', error));
	}

	private clearTimer(stream: IActiveVoiceStream): void {
		if (stream.timer !== undefined) {
			(this.options.clearTimeout ?? clearTimeout)(stream.timer as ReturnType<typeof setTimeout>);
			stream.timer = undefined;
		}
	}
}
