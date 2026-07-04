// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * E2Eチャネル上に流す多重化フレームの定義とコーデック（設計書 §3）。
 * フレームは手書きのコンパクトなバイナリ形式でエンコードした後、SecureChannel.seal()
 * で封緘して送る。外部依存（msgpack等）を持たないことで、PC側(webcrypto)への移植も容易。
 *
 * バイナリ形式:
 *   [chId:u8][flags:u8][seq:u32 BE][wsLen:u16 BE][ws bytes(UTF-8)][payload...]
 *   flags bit0: ws が存在するか
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
	const header = new Uint8Array(1 + 1 + 4 + 2);
	const view = new DataView(header.buffer);
	view.setUint8(0, chId);
	view.setUint8(1, frame.ws !== undefined ? 0x01 : 0x00);
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
	const chId = view.getUint8(0);
	const ch = ID_TO_CHANNEL.get(chId);
	if (ch === undefined) {
		throw new Error(`unknown frame channel id: ${chId}`);
	}
	const hasWs = (view.getUint8(1) & 0x01) !== 0;
	const seq = view.getUint32(2, false);
	const wsLen = view.getUint16(6, false);
	if (8 + wsLen > bytes.length) {
		throw new Error('malformed frame: ws length exceeds buffer');
	}
	const ws = hasWs ? new TextDecoder().decode(bytes.subarray(8, 8 + wsLen)) : undefined;
	const payload = bytes.subarray(8 + wsLen);
	return ws === undefined ? { ch, seq, payload } : { ch, ws, seq, payload };
}
