/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `aivis-mcp --ingest`（aivis-mcp 2.5.0 以上）の標準入出力の枠。取り決めの正は aivis-mcp の
// docs/ingest-protocol.md（取り決めの版 1）。1 枠 = 型 1 バイト ＋ 長さ 4 バイト（符号なし・ビッグ
// エンディアン）＋ 中身。型 0x01 は JSON の制御、0x02 は音声（流れ ID の長さ 1 バイト ＋ ID ＋ MP3）。

/** 話せる取り決めの版。 */
export const PARADIS_INGEST_PROTOCOL_VERSION = 1;

const FRAME_HEADER_BYTES = 5;
/** 1 枠の中身の上限。これを超える長さを名乗る枠は壊れているとみなす。 */
export const PARADIS_INGEST_MAX_FRAME_PAYLOAD = 1024 * 1024;
/** 音声の枠に載せる MP3 の上限（枠の上限から流れ ID の分を引いて余裕を持たせる）。 */
export const PARADIS_INGEST_MAX_AUDIO_PER_FRAME = 256 * 1024;

const FRAME_TYPE_CONTROL = 0x01;
const FRAME_TYPE_AUDIO = 0x02;

/** aivis-mcp から届いた制御の枠。必ず文字列の `type` を持つ。 */
export interface IParadisIngestMessage {
	readonly type: string;
	readonly [key: string]: unknown;
}

export class ParadisIngestFrameError extends Error { }

function frame(type: number, payload: Buffer): Buffer {
	if (payload.length > PARADIS_INGEST_MAX_FRAME_PAYLOAD) {
		throw new ParadisIngestFrameError(`frame payload too large: ${payload.length}`);
	}
	const header = Buffer.alloc(FRAME_HEADER_BYTES);
	header.writeUInt8(type, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

/** 制御の枠（JSON）を作る。 */
export function paradisEncodeIngestControl(message: { readonly type: string;[key: string]: unknown }): Buffer {
	return frame(FRAME_TYPE_CONTROL, Buffer.from(JSON.stringify(message), 'utf8'));
}

/** 音声の枠を作る。`data` は枠の上限に収まる大きさにしてから渡す。 */
export function paradisEncodeIngestAudio(id: string, data: Uint8Array): Buffer {
	const idBytes = Buffer.from(id, 'utf8');
	if (idBytes.length === 0 || idBytes.length > 255) {
		throw new ParadisIngestFrameError('stream id must be 1..255 bytes');
	}
	return frame(FRAME_TYPE_AUDIO, Buffer.concat([Buffer.from([idBytes.length]), idBytes, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]));
}

/**
 * aivis-mcp の標準出力から枠を切り出す。区切りはどこで来てもよい。aivis-mcp から親へは制御の枠しか
 * 来ない取り決めなので、それ以外の型・壊れた枠は {@link ParadisIngestFrameError} を投げる
 * （以後の境目が分からないので、呼び出し側は子を起動し直す）。
 */
export class ParadisIngestFrameDecoder {
	private pending: Buffer = Buffer.alloc(0);

	push(chunk: Uint8Array): IParadisIngestMessage[] {
		const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		this.pending = this.pending.length === 0 ? incoming : Buffer.concat([this.pending, incoming]);
		const messages: IParadisIngestMessage[] = [];
		while (this.pending.length >= FRAME_HEADER_BYTES) {
			const type = this.pending.readUInt8(0);
			const length = this.pending.readUInt32BE(1);
			if (length > PARADIS_INGEST_MAX_FRAME_PAYLOAD) {
				throw new ParadisIngestFrameError(`frame payload too large: ${length}`);
			}
			if (this.pending.length < FRAME_HEADER_BYTES + length) {
				break;
			}
			const payload = this.pending.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length);
			this.pending = this.pending.subarray(FRAME_HEADER_BYTES + length);
			if (type !== FRAME_TYPE_CONTROL) {
				throw new ParadisIngestFrameError(`unexpected frame type: ${type}`);
			}
			let message: unknown;
			try {
				message = JSON.parse(payload.toString('utf8'));
			} catch {
				throw new ParadisIngestFrameError('control frame is not JSON');
			}
			if (typeof message !== 'object' || message === null || Array.isArray(message) || typeof (message as { type?: unknown }).type !== 'string') {
				throw new ParadisIngestFrameError('control frame must be an object with a string "type"');
			}
			messages.push(message as IParadisIngestMessage);
		}
		if (this.pending.length === 0) {
			this.pending = Buffer.alloc(0);
		} else {
			// 切り出した残りが元の大きな Buffer を握り続けないよう複製する
			this.pending = Buffer.from(this.pending);
		}
		return messages;
	}
}
