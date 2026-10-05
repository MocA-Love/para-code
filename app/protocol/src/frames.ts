// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { decodeUtf8 } from './utf8.js';

/**
 * E2Eチャネル上に流す多重化フレームの定義とコーデック（設計書 §3）。
 * フレームは手書きのコンパクトなバイナリ形式でエンコードした後、SecureChannel.seal()
 * で封緘して送る。外部依存（msgpack等）を持たないことで、PC側(webcrypto)への移植も容易。
 *
 * バイナリ形式:
 *   [chId:u8][flags:u8][seq:u32 BE][wsLen:u16 BE][ws bytes(UTF-8)][payload...]
 *   flags bit0: ws が存在するか
 *   flags bit1: 続きのチャンクがある（版 3 までの分割。受け取りだけ残す）
 *   flags bit2: 版 4 の断片。ws の後ろに [送信ID:u32 BE][何番目か:u32 BE] が続く
 *   flags bit3: 版 4 の最後の断片
 *
 * 版 4 の FrameMux は 16KiB を超える論理フレームを断片に切り、送信 ID ごとに組み立て直す
 * （断片は交互に届いてよい）。16KiB 以下は断片の見出しを付けず、版 3 と同じバイト列で送る
 * （古い相手に「更新してください」を伝える State の案内はこの形で届く）。
 */

/** 論理チャネルID。 */
export const Channels = Object.freeze({
	/** ワークスペース/ターミナル/エージェント状態のスナップショット+差分 (PC→M) */
	State: 'state',
	/** PTY入出力・resize・タブ操作 (双方向) */
	Terminal: 'term',
	/** ソース管理 (双方向) */
	Scm: 'scm',
	/** ファイル閲覧 (M→PC要求/PC→M応答) */
	Fs: 'fs',
	/** para-browserミラー (双方向) */
	Browser: 'browser',
	/** プッシュ対象イベント (PC→M) */
	Notify: 'notify',
	/** エージェント(Claude Code / Codex)セッションのチャットミラー (双方向) */
	Agent: 'agent',
} as const);

export type ChannelId = typeof Channels[keyof typeof Channels];

// チャネル ↔ 1バイトID の対応（ワイヤ効率と将来の互換のため明示的に固定）。
const CHANNEL_TO_ID: Record<ChannelId, number> = {
	state: 1,
	term: 2,
	scm: 3,
	fs: 4,
	browser: 5,
	notify: 6,
	agent: 7,
};
const ID_TO_CHANNEL = new Map<number, ChannelId>(
	(Object.entries(CHANNEL_TO_ID) as [ChannelId, number][]).map(([ch, id]) => [id, ch]),
);

export interface Frame {
	/** 論理チャネル。 */
	readonly ch: ChannelId;
	/** 対象ワークスペースID（ワークスペースに紐付かないフレームでは省略）。 */
	readonly ws?: string;
	/** チャネル内シーケンス番号。 */
	readonly seq: number;
	/** チャネル固有のペイロード。 */
	readonly payload: Uint8Array;
	/** 続きのチャンクがある（版 3 までの分割。受け取りだけ残す。FrameMuxが再結合する）。 */
	readonly more?: boolean;
	/** 版 4 の断片（送信 ID・何番目か・最後か）。FrameMux が送信 ID ごとに組み立て直す。 */
	readonly frag?: FrameFragment;
}

/** 版 4 の断片の見出し。 */
export interface FrameFragment {
	/** 送信 ID（送り手ごとに採番。u32）。 */
	readonly id: number;
	/** 何番目か（0 始まり。u32）。 */
	readonly index: number;
	/** 最後の断片か。 */
	readonly last: boolean;
}

const FLAG_FRAGMENT = 0x04;
const FLAG_FRAGMENT_LAST = 0x08;
const FRAGMENT_HEADER_BYTES = 8;

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
	const frag = frame.frag;
	if (frag !== undefined && (!Number.isSafeInteger(frag.id) || frag.id < 0 || frag.id > 0xffffffff || !Number.isSafeInteger(frag.index) || frag.index < 0 || frag.index > 0xffffffff)) {
		throw new Error('frame fragment out of range');
	}
	const fragBytes = frag !== undefined ? FRAGMENT_HEADER_BYTES : 0;
	const out = new Uint8Array(8 + wsBytes.length + fragBytes + frame.payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, chId);
	view.setUint8(1, (frame.ws !== undefined ? 0x01 : 0x00) | (frame.more === true ? 0x02 : 0x00)
		| (frag !== undefined ? FLAG_FRAGMENT : 0x00) | (frag?.last === true ? FLAG_FRAGMENT_LAST : 0x00));
	view.setUint32(2, frame.seq, false);
	view.setUint16(6, wsBytes.length, false);
	out.set(wsBytes, 8);
	if (frag !== undefined) {
		view.setUint32(8 + wsBytes.length, frag.id, false);
		view.setUint32(8 + wsBytes.length + 4, frag.index, false);
	}
	out.set(frame.payload, 8 + wsBytes.length + fragBytes);
	return out;
}

export function decodeFrame(bytes: Uint8Array): Frame {
	if (bytes.length < 8) {
		throw new Error('malformed frame: too short');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chId = view.getUint8(0);
	const ch = ID_TO_CHANNEL.get(chId);
	if (ch === undefined) {
		throw new Error(`unknown frame channel id: ${chId}`);
	}
	const flags = view.getUint8(1);
	const hasWs = (flags & 0x01) !== 0;
	const more = (flags & 0x02) !== 0;
	const seq = view.getUint32(2, false);
	const wsLen = view.getUint16(6, false);
	if (8 + wsLen > bytes.length) {
		throw new Error('malformed frame: ws length exceeds buffer');
	}
	const ws = hasWs ? decodeUtf8(bytes.subarray(8, 8 + wsLen)) : undefined;
	let frag: FrameFragment | undefined;
	let payloadStart = 8 + wsLen;
	if ((flags & FLAG_FRAGMENT) !== 0) {
		if (payloadStart + FRAGMENT_HEADER_BYTES > bytes.length) {
			throw new Error('malformed frame: fragment header exceeds buffer');
		}
		frag = { id: view.getUint32(payloadStart, false), index: view.getUint32(payloadStart + 4, false), last: (flags & FLAG_FRAGMENT_LAST) !== 0 };
		payloadStart += FRAGMENT_HEADER_BYTES;
	}
	const payload = bytes.subarray(payloadStart);
	return {
		ch,
		seq,
		payload,
		...(ws !== undefined ? { ws } : {}),
		...(more ? { more: true } : {}),
		...(frag !== undefined ? { frag } : {}),
	};
}
