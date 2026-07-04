// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ペアリング（初回紐付け）関連。
 *
 * PC側がQRコードとして提示するペイロードのエンコード/デコードと、
 * MITM検証用のSASコード（両端に表示して目視比較する6桁）の導出。
 * 設計書 §2 参照。
 */

import { decode, encode } from '@msgpack/msgpack';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import type { Identity } from './crypto.js';
import { fromBase64Url, toBase64Url } from './util.js';

export const PAIRING_URI_SCHEME = 'paracode-mobile://pair';
const SAS_INFO = new TextEncoder().encode('para-code-mobile/sas/1');

/** PCがQRコードとして提示するペアリング情報。 */
export interface PairingPayload {
	readonly version: 1;
	readonly relayUrl: string;
	readonly deviceId: string;
	/** 短命・1回限りのペアリングトークン。リレーがペアリング接続の認可に使う。 */
	readonly pairingToken: Uint8Array;
	/** PCの長期公開鍵（X25519）。 */
	readonly pcPublicKey: Uint8Array;
}

export function encodePairingUri(payload: PairingPayload): string {
	const packed = encode({
		v: payload.version,
		r: payload.relayUrl,
		d: payload.deviceId,
		t: payload.pairingToken,
		k: payload.pcPublicKey,
	});
	return `${PAIRING_URI_SCHEME}?d=${toBase64Url(packed)}`;
}

export function decodePairingUri(uri: string): PairingPayload {
	const prefix = `${PAIRING_URI_SCHEME}?d=`;
	if (!uri.startsWith(prefix)) {
		throw new Error('not a Para Code pairing URI');
	}
	const raw = decode(fromBase64Url(uri.slice(prefix.length))) as Record<string, unknown>;
	if (raw === null || typeof raw !== 'object' || raw['v'] !== 1) {
		throw new Error('unsupported pairing payload');
	}
	const relayUrl = raw['r'];
	const deviceId = raw['d'];
	const pairingToken = raw['t'];
	const pcPublicKey = raw['k'];
	if (typeof relayUrl !== 'string' || typeof deviceId !== 'string' || !(pairingToken instanceof Uint8Array) || !(pcPublicKey instanceof Uint8Array) || pcPublicKey.length !== 32) {
		throw new Error('malformed pairing payload');
	}
	return { version: 1, relayUrl, deviceId, pairingToken, pcPublicKey };
}

/**
 * SAS（Short Authentication String）6桁の導出。
 *
 * 静的鍵同士のDH共有秘密とペアリングトークンから導出するため、リレーがQRの中身
 * （公開鍵・トークン）を知っていても、どちらかの静的秘密鍵なしには同じ値を計算できない。
 * 両端で表示が一致すればMITMなしにペアリングできたことが確認できる。
 */
export function deriveSasCode(ownStatic: Identity, peerStaticPub: Uint8Array, pairingToken: Uint8Array): string {
	const shared = x25519.getSharedSecret(ownStatic.secretKey, peerStaticPub);
	const okm = hkdf(sha256, shared, sha256(pairingToken), SAS_INFO, 4);
	const value = (((okm[0] ?? 0) << 24) | ((okm[1] ?? 0) << 16) | ((okm[2] ?? 0) << 8) | (okm[3] ?? 0)) >>> 0;
	return String(value % 1_000_000).padStart(6, '0');
}
