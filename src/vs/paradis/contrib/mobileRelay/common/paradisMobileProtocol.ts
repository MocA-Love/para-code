/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code Mobile の共有プロトコル（PC側の移植）。
//
// **重要**: このファイルは `app/protocol`（モバイル/リレーが使う @noble 実装）と
// **ワイヤ互換**でなければならない。フレーム/ペアリング/リレーの各コーデックは依存ゼロなので
// app/protocol からほぼ逐語移植している。暗号（AES-256-GCM + X25519 + HKDF-SHA256）は
// vscode本体へ新規npm依存を持ち込まないため Node/Web の webcrypto で実装する
// （app/protocol/test/interop.test.ts が @noble ↔ webcrypto のバイト互換を保証している）。
// app/protocol 側を変更したら必ずこちらも更新し interop テストを通すこと。

// ---- チャネル定義（app/protocol/src/frames.ts と一致） ----

export const Channels = Object.freeze({
	State: 'state',
	Terminal: 'term',
	Scm: 'scm',
	Fs: 'fs',
	Browser: 'browser',
	Notify: 'notify',
	Agent: 'agent',
} as const);

export type ChannelId = typeof Channels[keyof typeof Channels];

const CHANNEL_TO_ID: Record<ChannelId, number> = { state: 1, term: 2, scm: 3, fs: 4, browser: 5, notify: 6, agent: 7 };
const ID_TO_CHANNEL = new Map<number, ChannelId>((Object.entries(CHANNEL_TO_ID) as [ChannelId, number][]).map(([ch, id]) => [id, ch]));

export interface Frame {
	readonly ch: ChannelId;
	readonly ws?: string;
	readonly seq: number;
	readonly payload: Uint8Array;
	/** 続きのチャンクがある（分割された論理フレームの途中。FrameMuxが再結合する）。 */
	readonly more?: boolean;
}

export function encodeFrame(frame: Frame): Uint8Array {
	const chId = CHANNEL_TO_ID[frame.ch];
	if (chId === undefined) {
		throw new Error(`unknown frame channel: ${String(frame.ch)}`);
	}
	if (!Number.isSafeInteger(frame.seq) || frame.seq < 0 || frame.seq > 0xffffffff) {
		throw new Error('frame seq out of range');
	}
	const wsBytes = frame.ws !== undefined ? new TextEncoder().encode(frame.ws) : new Uint8Array(0);
	if (wsBytes.length > 0xffff) {
		throw new Error('frame ws too long');
	}
	const header = new Uint8Array(8);
	const view = new DataView(header.buffer);
	view.setUint8(0, chId);
	view.setUint8(1, (frame.ws !== undefined ? 0x01 : 0x00) | (frame.more === true ? 0x02 : 0x00));
	view.setUint32(2, frame.seq, false);
	view.setUint16(6, wsBytes.length, false);
	const out = new Uint8Array(header.length + wsBytes.length + frame.payload.length);
	out.set(header, 0);
	out.set(wsBytes, header.length);
	out.set(frame.payload, header.length + wsBytes.length);
	return out;
}

export function decodeFrame(bytes: Uint8Array): Frame {
	if (bytes.length < 8) {
		throw new Error('malformed frame: too short');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ch = ID_TO_CHANNEL.get(view.getUint8(0));
	if (ch === undefined) {
		throw new Error(`unknown frame channel id: ${view.getUint8(0)}`);
	}
	const flags = view.getUint8(1);
	const hasWs = (flags & 0x01) !== 0;
	const more = (flags & 0x02) !== 0;
	const seq = view.getUint32(2, false);
	const wsLen = view.getUint16(6, false);
	if (8 + wsLen > bytes.length) {
		throw new Error('malformed frame: ws length exceeds buffer');
	}
	const ws = hasWs ? new TextDecoder().decode(bytes.subarray(8, 8 + wsLen)) : undefined;
	const payload = bytes.subarray(8 + wsLen);
	return {
		ch,
		seq,
		payload,
		...(ws !== undefined ? { ws } : {}),
		...(more ? { more: true } : {}),
	};
}

// ---- リレー制御メッセージ（app/protocol/src/relay.ts と一致） ----

export const RELAY_DATA_VERSION = 0x01;
export const MOBILE_ID_LENGTH = 16;

export type RelayControlMessage =
	| { readonly type: 'pairing-msg'; readonly data: string; readonly pairId?: string }
	| { readonly type: 'pairing-approve'; readonly pairId: string; readonly name: string }
	| { readonly type: 'pairing-reject'; readonly pairId: string }
	| { readonly type: 'paired'; readonly deviceId: string; readonly mobileId: string; readonly mobileToken: string }
	| { readonly type: 'presence'; readonly peer: 'pc' | 'mobile'; readonly mobileId?: string; readonly online: boolean }
	| { readonly type: 'error'; readonly message: string }
	// APNsプッシュ: モバイルがトークンを登録し（register-push）、PCがオフラインのモバイル宛に
	// 暗号文ペイロード（通知鍵で封緘済み・リレーは復号不可）のプッシュ配送を依頼する（push-notify）
	| { readonly type: 'register-push'; readonly token: string; readonly env?: 'prod' | 'dev' }
	| { readonly type: 'push-notify'; readonly mobileId: string; readonly payload: string }
	// リレー→PC: モバイル自身がペアリングを解除した（self-revoke）。PCは登録一覧から取り除く
	| { readonly type: 'mobile-revoked'; readonly mobileId: string };

export function encodeRelayControl(message: RelayControlMessage): string {
	return JSON.stringify(message);
}

export function decodeRelayControl(text: string): RelayControlMessage {
	const raw = JSON.parse(text) as { type?: unknown };
	if (raw === null || typeof raw !== 'object' || typeof raw.type !== 'string') {
		throw new Error('malformed relay control message');
	}
	return raw as RelayControlMessage;
}

export function packPcData(mobileId: Uint8Array, payload: Uint8Array): Uint8Array {
	if (mobileId.length !== MOBILE_ID_LENGTH) {
		throw new Error(`mobileId must be ${MOBILE_ID_LENGTH} bytes`);
	}
	const out = new Uint8Array(1 + MOBILE_ID_LENGTH + payload.length);
	out[0] = RELAY_DATA_VERSION;
	out.set(mobileId, 1);
	out.set(payload, 1 + MOBILE_ID_LENGTH);
	return out;
}

export function unpackPcData(bytes: Uint8Array): { mobileId: Uint8Array; payload: Uint8Array } {
	if (bytes.length < 1 + MOBILE_ID_LENGTH || bytes[0] !== RELAY_DATA_VERSION) {
		throw new Error('malformed relay data message');
	}
	return { mobileId: bytes.subarray(1, 1 + MOBILE_ID_LENGTH), payload: bytes.subarray(1 + MOBILE_ID_LENGTH) };
}

// ---- base64url（app/protocol/src/util.ts と一致） ----

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i] ?? 0;
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		out += BASE64URL[b0 >> 2];
		out += BASE64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
		if (b1 !== undefined) { out += BASE64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]; }
		if (b2 !== undefined) { out += BASE64URL[b2 & 0x3f]; }
	}
	return out;
}

export function fromBase64Url(text: string): Uint8Array {
	const len = text.length;
	if (len % 4 === 1) {
		throw new Error('invalid base64url length');
	}
	const out = new Uint8Array(Math.floor((len * 3) / 4));
	let outPos = 0;
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < len; i++) {
		const idx = BASE64URL.indexOf(text[i]!);
		if (idx < 0) {
			throw new Error(`invalid base64url character at ${i}`);
		}
		buffer = (buffer << 6) | idx;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[outPos++] = (buffer >> bits) & 0xff;
		}
	}
	return out.subarray(0, outPos);
}

export function mobileIdToString(mobileId: Uint8Array): string {
	return toBase64Url(mobileId);
}

export function mobileIdFromString(text: string): Uint8Array {
	const bytes = fromBase64Url(text);
	if (bytes.length !== MOBILE_ID_LENGTH) {
		throw new Error('invalid mobileId');
	}
	return bytes;
}

// ---- ペアリングペイロード（app/protocol/src/pairing.ts と一致） ----

export const PAIRING_URI_SCHEME = 'paracode-mobile://pair';

export interface PairingPayload {
	readonly version: 1;
	readonly relayUrl: string;
	readonly deviceId: string;
	readonly pairId: string;
	readonly pairingToken: Uint8Array;
	readonly pcPublicKey: Uint8Array;
}

// ---- notify チャネルのペイロード（app/protocol/src/notify.ts と一致） ----

export type NotifyKind = 'agent-question' | 'agent-done' | 'agent-error' | 'disconnected';

export interface NotifyPayload {
	readonly kind: NotifyKind;
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly ws?: string;
	readonly terminalId?: number;
	readonly at: number;
}

export function encodeNotify(payload: NotifyPayload): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(payload));
}

/**
 * Notifyペイロードから種別だけを読む（APNsプッシュ抑制の判定用）。
 * 形式不正なら undefined（呼び出し側は「抑制しない」に倒す）。
 */
export function peekNotifyKind(bytes: Uint8Array): NotifyKind | undefined {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { kind?: unknown };
		const kind = parsed.kind;
		if (kind === 'agent-question' || kind === 'agent-done' || kind === 'agent-error' || kind === 'disconnected') {
			return kind;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * notify チャネル上の制御メッセージ（NotifyPayloadとは別形。`t` フィールドで区別する）。
 * - dismiss: モバイルが通知一覧で項目をタップ/クリアした（M→PC）。
 * - dismissed: PCが他の端末へ「その通知は既に処理された」ことを伝える（PC→M、複数端末間の一覧同期用）。
 */
export type NotifyControlMessage =
	| { readonly t: 'dismiss'; readonly id: string }
	| { readonly t: 'dismissed'; readonly id: string };

export function encodeNotifyDismissed(id: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'dismissed', id }));
}

/**
 * notify チャネルの受信バイト列を制御メッセージとして読む。NotifyPayload（`kind`を持つ）や
 * 形式不正なバイト列に対しては undefined を返す（呼び出し側は通常のNotifyPayloadとしての
 * デコードにフォールバックする）。
 */
export function decodeNotifyControl(bytes: Uint8Array): NotifyControlMessage | undefined {
	try {
		const raw = JSON.parse(new TextDecoder().decode(bytes)) as { t?: unknown; id?: unknown };
		if ((raw.t === 'dismiss' || raw.t === 'dismissed') && typeof raw.id === 'string') {
			return { t: raw.t, id: raw.id };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export function encodePairingUri(payload: PairingPayload): string {
	const json = JSON.stringify({
		v: payload.version,
		r: payload.relayUrl,
		d: payload.deviceId,
		p: payload.pairId,
		t: toBase64Url(payload.pairingToken),
		k: toBase64Url(payload.pcPublicKey),
	});
	return `${PAIRING_URI_SCHEME}?d=${toBase64Url(new TextEncoder().encode(json))}`;
}
