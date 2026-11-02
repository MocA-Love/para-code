/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDP プロキシ（paradisCdpFilterProxy.ts）のページの経路とブラウザの経路が共に使う、1 フレームの扱い:
// RawData の長さと文字列、上限付きの送信、クライアントへ返すエラーのフレーム。

import type * as wsTypes from 'ws';

// Debugger metadata can legitimately contain multi-megabyte inline source maps in a single
// frame. Keep every transport stage on the same bounded ceiling so a valid frame accepted by
// the parser is not rejected by an earlier queue or later backpressure check.
export const MAX_CDP_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_CDP_OPEN_BUFFERED_BYTES = MAX_CDP_FRAME_BYTES;

export function rawDataByteLength(data: wsTypes.RawData): number {
	if (Array.isArray(data)) {
		return data.reduce((total, chunk) => total + chunk.byteLength, 0);
	}
	return data.byteLength;
}

export function rawDataText(data: wsTypes.RawData): string {
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}
	return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

// `buffer.isUtf8` is not importable under the node layer's import rules; a fatal decoder is the
// same check without the dependency.
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** 上流から来た 1 フレーム。バイト列の連結と文字列への読み出しを 1 回だけにするため、読んだものを持ち回る。 */
export interface IParadisCdpFrame {
	readonly data: wsTypes.RawData;
	readonly bytes: number;
	readonly text: string;
}

export function paradisReadCdpFrame(data: wsTypes.RawData, bytes = rawDataByteLength(data)): IParadisCdpFrame {
	return { data, bytes, text: rawDataText(data) };
}

/**
 * クライアントへそのまま送ってよい形（{@link reencodeUtf8} と同じ結果）。読み出した文字列に U+FFFD が無ければ
 * 元のバイト列は正しい UTF-8 なので、厳密な検証（全体の decode）を省いて元のまま返す。U+FFFD があるときだけ
 * （壊れた並びか、本当に U+FFFD を含むか）検証する。
 */
export function paradisForwardableCdpFrame(frame: IParadisCdpFrame): wsTypes.RawData | string {
	return frame.text.includes('\uFFFD') ? reencodeUtf8(frame.data) : frame.data;
}

/**
 * Returns the frame unchanged when it is already valid UTF-8 (no re-encoded copy for multi-megabyte
 * screenshot frames); otherwise decodes it with U+FFFD replacement so the client's own `ws`
 * validation accepts the forwarded text frame.
 */
function reencodeUtf8(data: wsTypes.RawData): wsTypes.RawData | string {
	const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
	try {
		strictUtf8Decoder.decode(buffer);
		return data;
	} catch {
		return buffer.toString('utf8');
	}
}

export function payloadByteLength(data: wsTypes.RawData | string): number {
	return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : rawDataByteLength(data);
}

export type ParadisBoundedSendOutcome = 'sent' | 'frame-too-large' | 'buffer-full' | 'send-failed';

export function sendWithBoundedBackpressureOutcome(socket: wsTypes.WebSocket, data: wsTypes.RawData | string, forceText = false): ParadisBoundedSendOutcome {
	const bytes = payloadByteLength(data);
	// スクリーンショットのフレームも同じ上限（MAX_CDP_FRAME_BYTES の上のコメント）。送り先に溜められる量も同じ値
	const frameLimit = MAX_CDP_FRAME_BYTES;
	const bufferedLimit = MAX_CDP_OPEN_BUFFERED_BYTES;
	const bufferedAmount = Number.isSafeInteger(socket.bufferedAmount) && socket.bufferedAmount >= 0 ? socket.bufferedAmount : bufferedLimit + 1;
	if (bytes > frameLimit) {
		return 'frame-too-large';
	}
	if (bufferedAmount + bytes > bufferedLimit) {
		return 'buffer-full';
	}
	try {
		// CDPはテキスト専用プロトコル。Bufferをそのまま送るとwsがバイナリフレーム化し、
		// Chromium DevToolsエンドポイントが最初のバイナリフレーム受信で接続を切断する。
		// ページ経路はRawData(Buffer)を素通しするため、テキストフレームを強制する。
		if (forceText) {
			socket.send(data, { binary: false });
		} else {
			socket.send(data);
		}
		return 'sent';
	} catch {
		return 'send-failed';
	}
}

export function sendWithBoundedBackpressure(socket: wsTypes.WebSocket, data: wsTypes.RawData | string, forceText = false): boolean {
	return sendWithBoundedBackpressureOutcome(socket, data, forceText) === 'sent';
}

/** クライアントの命令への CDP のエラーの答え（`sessionId` は命令にあったときだけ付ける）。 */
export function paradisCdpErrorResponse(id: number, sessionId: string | undefined, message: string): { readonly id: number; readonly sessionId?: string; readonly error: { readonly code: number; readonly message: string } } {
	return { id, ...(sessionId !== undefined ? { sessionId } : {}), error: { code: -32000, message } };
}

/** {@link paradisCdpErrorResponse} を送る形の文字列にしたもの。 */
export function paradisCdpErrorFrame(id: number, sessionId: string | undefined, message: string): string {
	return JSON.stringify(paradisCdpErrorResponse(id, sessionId, message));
}
