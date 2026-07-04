// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * E2Eチャネル上に流す多重化フレームの定義とコーデック（設計書 §3）。
 * フレームは msgpack でエンコードした後、SecureChannel.seal() で封緘して送る。
 */

import { decode, encode } from '@msgpack/msgpack';

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

const KNOWN_CHANNELS: ReadonlySet<string> = new Set(Object.values(Channels));

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
	return encode({ c: frame.ch, w: frame.ws, s: frame.seq, p: frame.payload });
}

export function decodeFrame(bytes: Uint8Array): Frame {
	const raw = decode(bytes) as Record<string, unknown>;
	if (raw === null || typeof raw !== 'object') {
		throw new Error('malformed frame');
	}
	const ch = raw['c'];
	const ws = raw['w'];
	const seq = raw['s'];
	const payload = raw['p'];
	if (typeof ch !== 'string' || !KNOWN_CHANNELS.has(ch)) {
		throw new Error(`unknown frame channel: ${String(ch)}`);
	}
	if (ws !== undefined && ws !== null && typeof ws !== 'string') {
		throw new Error('malformed frame: ws');
	}
	if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
		throw new Error('malformed frame: seq');
	}
	if (!(payload instanceof Uint8Array)) {
		throw new Error('malformed frame: payload');
	}
	return { ch: ch as ChannelId, ws: ws ?? undefined, seq, payload };
}
