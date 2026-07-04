// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * リレーサーバ（app/relay）とのトランスポート層の取り決め。
 *
 * - バイナリメッセージ = E2E暗号化済みデータ（リレーは復号できない）
 *   - モバイル→リレー: ペイロードのみ（リレーが送信元mobileIdを知っているため）
 *   - リレー→PC / PC→リレー: [1Bバージョン][16B mobileId][ペイロード] で多重化
 *   - リレー→モバイル: ペイロードのみ
 * - テキストメッセージ = 制御JSON（ペアリング進行・presence・エラー通知）。
 *   ペアリング中の `pairing-msg` の中身（E2Eハンドシェイク）も暗号化済みでリレーには不透明。
 */

import { concatBytes, fromBase64Url, toBase64Url } from './util.js';

export const RELAY_DATA_VERSION = 0x01;
export const MOBILE_ID_LENGTH = 16;

/** PC⇔リレー間のバイナリメッセージを組み立てる（mobileIdで多重化）。 */
export function packPcData(mobileId: Uint8Array, payload: Uint8Array): Uint8Array {
	if (mobileId.length !== MOBILE_ID_LENGTH) {
		throw new Error(`mobileId must be ${MOBILE_ID_LENGTH} bytes`);
	}
	return concatBytes(new Uint8Array([RELAY_DATA_VERSION]), mobileId, payload);
}

export function unpackPcData(bytes: Uint8Array): { mobileId: Uint8Array; payload: Uint8Array } {
	if (bytes.length < 1 + MOBILE_ID_LENGTH || bytes[0] !== RELAY_DATA_VERSION) {
		throw new Error('malformed relay data message');
	}
	return {
		mobileId: bytes.subarray(1, 1 + MOBILE_ID_LENGTH),
		payload: bytes.subarray(1 + MOBILE_ID_LENGTH),
	};
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

/** リレーの制御メッセージ（テキストフレーム、JSON）。 */
export type RelayControlMessage =
	// ペアリングソケット⇔PCソケット間の中継（dataはE2Eハンドシェイクの断片、base64url）
	| { readonly type: 'pairing-msg'; readonly data: string }
	// PC→リレー: このペアリングを承認し、モバイル用の資格情報を発行せよ
	| { readonly type: 'pairing-approve'; readonly name: string }
	// PC→リレー: ペアリングを拒否
	| { readonly type: 'pairing-reject' }
	// リレー→ペアリングソケット: 承認完了。モバイルはこの資格情報で以後 ws/mobile に接続する
	| { readonly type: 'paired'; readonly deviceId: string; readonly mobileId: string; readonly mobileToken: string }
	// リレー→PC: モバイルの接続状態変化 / リレー→モバイル: PCの接続状態変化
	| { readonly type: 'presence'; readonly peer: 'pc' | 'mobile'; readonly mobileId?: string; readonly online: boolean }
	| { readonly type: 'error'; readonly message: string };

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
