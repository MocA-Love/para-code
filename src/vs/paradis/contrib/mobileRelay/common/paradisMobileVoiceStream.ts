/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 音声通知のストリーミング（`voice.stream.v1`、設計 3.5 / 3.6 N7）の形。
 *
 * **このファイルは import を持たない。** モバイルアプリ（`app/mobile`）が相対パスで直接 import し、PC とアプリで
 * 同じ読み書きを使う。
 *
 * 1 回の発話は次の順に browser チャネルで届く（宛先の端末が `voice.stream.v1` を広告しているときだけ）:
 *
 * 1. `voice-stream-start {sid, streamId, mime, gainDb, epoch}`（JSON）。`epoch` は PC の暗号セッションの世代で、記録用
 *    （アプリは使わない。張り直した後に届いた古い流れの続きは、知らない streamId として捨てるか、最後の断片から 8 秒で終える）
 * 2. 2 進の断片（先頭 4 バイトの印 `PVS\x01` ＋ streamId 16 バイト ＋ seq 4 バイト（BE）＋ MP3）。
 *    PC は 8KiB か 100ms ごとにまとめて送る
 * 3. `voice-stream-end {streamId, seq, bytes, aborted}`（JSON）。`seq` は送った断片の数、`bytes` は MP3 の合計。
 *    途中で切るときも必ず `aborted: true` の end を送る（張り直した後の古い流れを除く）
 *
 * 広告していない端末と、鳴り始めの時点で送信が詰まっていた端末には、その発話を全部受け取ってから
 * 1 本まるごとの `voice-clip {sid, mime, data, gainDb}` で送る。
 */

/** 2 進の断片の印（"PVS" + 版 1）。画面の JPEG の `PJF\x01` と同じ流儀。 */
export const PARADIS_VOICE_STREAM_MAGIC: readonly number[] = [0x50, 0x56, 0x53, 0x01];
/** streamId のバイト数（JSON では 32 桁の 16 進）。 */
export const PARADIS_VOICE_STREAM_ID_BYTES = 16;
/** 2 進の断片の見出しのバイト数（印 4 ＋ streamId 16 ＋ seq 4）。 */
export const PARADIS_VOICE_STREAM_HEADER_BYTES = 24;
export const PARADIS_VOICE_STREAM_MIME = 'audio/mpeg';
/** PC が断片にまとめる大きさ。 */
export const PARADIS_VOICE_STREAM_BATCH_BYTES = 8 * 1024;
/** PC が断片にまとめる間隔。 */
export const PARADIS_VOICE_STREAM_BATCH_MS = 100;
/** 鳴り始めの時点で送信の詰まりがこれを超えていたら、その発話は全部受け取ってから 1 本で送る。 */
export const PARADIS_VOICE_STREAM_CONGESTION_BYTES = 256 * 1024;
/** 流れ 1 本の上限（PC の取込上限と同じ）。 */
export const PARADIS_VOICE_STREAM_MAX_BYTES = 8 * 1024 * 1024;
/** 音量の補正の範囲。上げる方向は aivis-mcp と同じ +8dB まで。 */
export const PARADIS_VOICE_GAIN_MIN_DB = -30;
export const PARADIS_VOICE_GAIN_MAX_DB = 8;

const STREAM_ID_PATTERN = /^[0-9a-f]{32}$/;

/** 新しい streamId（32 桁の 16 進）。 */
export function paradisNewVoiceStreamId(): string {
	const bytes = new Uint8Array(PARADIS_VOICE_STREAM_ID_BYTES);
	globalThis.crypto.getRandomValues(bytes);
	let hex = '';
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex;
}

export function paradisIsVoiceStreamId(value: unknown): value is string {
	return typeof value === 'string' && STREAM_ID_PATTERN.test(value);
}

/** 音量の補正（dB）を範囲に収める。数でなければ 0。 */
export function paradisClampVoiceGainDb(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(PARADIS_VOICE_GAIN_MIN_DB, Math.min(PARADIS_VOICE_GAIN_MAX_DB, Math.round(value * 10) / 10));
}

/** 2 進の断片か（先頭の印だけを見る）。 */
export function paradisIsVoiceStreamChunk(payload: Uint8Array): boolean {
	return payload.length >= PARADIS_VOICE_STREAM_HEADER_BYTES
		&& payload[0] === PARADIS_VOICE_STREAM_MAGIC[0]
		&& payload[1] === PARADIS_VOICE_STREAM_MAGIC[1]
		&& payload[2] === PARADIS_VOICE_STREAM_MAGIC[2]
		&& payload[3] === PARADIS_VOICE_STREAM_MAGIC[3];
}

/** 2 進の断片を作る。 */
export function paradisEncodeVoiceStreamChunk(streamId: string, seq: number, data: Uint8Array): Uint8Array {
	if (!paradisIsVoiceStreamId(streamId)) {
		throw new Error('invalid voice stream id');
	}
	if (!Number.isSafeInteger(seq) || seq < 0 || seq > 0xffffffff) {
		throw new Error('voice stream seq out of range');
	}
	const out = new Uint8Array(PARADIS_VOICE_STREAM_HEADER_BYTES + data.length);
	out.set(PARADIS_VOICE_STREAM_MAGIC, 0);
	for (let i = 0; i < PARADIS_VOICE_STREAM_ID_BYTES; i++) {
		out[4 + i] = parseInt(streamId.slice(i * 2, i * 2 + 2), 16);
	}
	new DataView(out.buffer).setUint32(20, seq, false);
	out.set(data, PARADIS_VOICE_STREAM_HEADER_BYTES);
	return out;
}

export interface IParadisVoiceStreamChunk {
	readonly streamId: string;
	readonly seq: number;
	readonly data: Uint8Array;
}

/** 2 進の断片を読む。形が違えば undefined。 */
export function paradisDecodeVoiceStreamChunk(payload: Uint8Array): IParadisVoiceStreamChunk | undefined {
	if (!paradisIsVoiceStreamChunk(payload) || payload.length === PARADIS_VOICE_STREAM_HEADER_BYTES) {
		return undefined;
	}
	let streamId = '';
	for (let i = 0; i < PARADIS_VOICE_STREAM_ID_BYTES; i++) {
		streamId += (payload[4 + i] ?? 0).toString(16).padStart(2, '0');
	}
	const seq = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(20, false);
	return { streamId, seq, data: payload.subarray(PARADIS_VOICE_STREAM_HEADER_BYTES) };
}

export interface IParadisVoiceStreamStartMessage {
	readonly t: 'voice-stream-start';
	readonly sid: string;
	readonly streamId: string;
	readonly mime: string;
	readonly gainDb: number;
	readonly epoch: number;
}

export interface IParadisVoiceStreamEndMessage {
	readonly t: 'voice-stream-end';
	readonly streamId: string;
	/** 送った断片の数。 */
	readonly seq: number;
	/** 送った MP3 の合計バイト数。 */
	readonly bytes: number;
	readonly aborted: boolean;
}

/** `voice-stream-start` を読む。形が違えば undefined。 */
export function paradisParseVoiceStreamStart(message: { readonly t?: unknown; readonly sid?: unknown; readonly streamId?: unknown; readonly mime?: unknown; readonly gainDb?: unknown; readonly epoch?: unknown }): IParadisVoiceStreamStartMessage | undefined {
	if (message.t !== 'voice-stream-start' || typeof message.sid !== 'string' || message.sid.length === 0 || message.sid.length > 200 || !paradisIsVoiceStreamId(message.streamId)) {
		return undefined;
	}
	const mime = typeof message.mime === 'string' ? message.mime : PARADIS_VOICE_STREAM_MIME;
	if (mime !== PARADIS_VOICE_STREAM_MIME) {
		return undefined;
	}
	const epoch = typeof message.epoch === 'number' && Number.isSafeInteger(message.epoch) ? message.epoch : 0;
	return { t: 'voice-stream-start', sid: message.sid, streamId: message.streamId, mime, gainDb: paradisClampVoiceGainDb(message.gainDb), epoch };
}

/** `voice-stream-end` を読む。形が違えば undefined。 */
export function paradisParseVoiceStreamEnd(message: { readonly t?: unknown; readonly streamId?: unknown; readonly seq?: unknown; readonly bytes?: unknown; readonly aborted?: unknown }): IParadisVoiceStreamEndMessage | undefined {
	if (message.t !== 'voice-stream-end' || !paradisIsVoiceStreamId(message.streamId)) {
		return undefined;
	}
	const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
	return { t: 'voice-stream-end', streamId: message.streamId, seq: count(message.seq), bytes: count(message.bytes), aborted: message.aborted === true };
}

/**
 * 音声の出どころ（通知の読み上げ・SSH 先の声・手元のエージェントの声）から、モバイルへの配信（リレー）へ渡すイベント。
 * 同じ shared process の中だけで渡す（IPC を通らない）。
 */
export type ParadisMobileVoiceEvent =
	/** 1 本まるごと（流れを持たない古い経路）。 */
	| { readonly kind: 'clip'; readonly audio: Uint8Array; readonly gainDb: number }
	/** 流れの開始。まだ音は無い（流すかは最初の音で決める）。 */
	| { readonly kind: 'stream-start'; readonly streamId: string; readonly gainDb: number }
	| { readonly kind: 'stream-data'; readonly streamId: string; readonly chunk: Uint8Array }
	/** 流れの終わり。`aborted` なら途中で切れた（1 本まるごとでは送らない）。 */
	| { readonly kind: 'stream-end'; readonly streamId: string; readonly aborted: boolean };

/** 出どころが音声を流し込む口。 */
export interface IParadisMobileVoiceStreamWriter {
	write(chunk: Uint8Array): void;
	end(): void;
	abort(): void;
}

/** 流れ 1 本ぶんのイベントを出す。終えた後の書き込みは無視する。上限を超えたら途中で切る。 */
export class ParadisMobileVoiceStreamWriter implements IParadisMobileVoiceStreamWriter {
	readonly streamId = paradisNewVoiceStreamId();
	private bytes = 0;
	private closed = false;

	constructor(private readonly fire: (event: ParadisMobileVoiceEvent) => void, gainDb: number, private readonly maxBytes = PARADIS_VOICE_STREAM_MAX_BYTES) {
		this.fire({ kind: 'stream-start', streamId: this.streamId, gainDb: paradisClampVoiceGainDb(gainDb) });
	}

	write(chunk: Uint8Array): void {
		if (this.closed || chunk.byteLength === 0) {
			return;
		}
		this.bytes += chunk.byteLength;
		if (this.bytes > this.maxBytes) {
			this.abort();
			return;
		}
		// 呼び出し側が同じ領域を使い回しても壊れないよう写す
		this.fire({ kind: 'stream-data', streamId: this.streamId, chunk: chunk.slice() });
	}

	end(): void {
		this.close(false);
	}

	abort(): void {
		this.close(true);
	}

	private close(aborted: boolean): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.fire({ kind: 'stream-end', streamId: this.streamId, aborted: aborted || this.bytes === 0 });
	}
}
