// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ペアリング（初回紐付け）関連。
 *
 * PC側がQRコードとして提示するペイロードのエンコード/デコードと、
 * MITM検証用のSASコード（両端に表示して目視比較する6桁）の導出。
 * 設計書 §2 参照。
 */

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
	/** リレーが払い出したペアリングセッションID（公開識別子）。 */
	readonly pairId: string;
	/** 短命・1回限りのペアリングトークン。リレーがペアリング接続の認可に使う。 */
	readonly pairingToken: Uint8Array;
	/** PCの長期公開鍵（X25519）。 */
	readonly pcPublicKey: Uint8Array;
	/**
	 * PCの表示名（省略可）。モバイルが複数のPCとペアリングしたときに一覧で見分けるために使う。
	 * 旧PCは送ってこないので、受け取れなかった場合はモバイル側で既定名を付ける。
	 */
	readonly pcName?: string;
}

/** ペアリングURIへ載せるPC名の上限。QRの情報量を増やしすぎないための切り詰め。 */
export const PAIRING_PC_NAME_MAX_LENGTH = 64;

export function encodePairingUri(payload: PairingPayload): string {
	const pcName = payload.pcName?.trim().slice(0, PAIRING_PC_NAME_MAX_LENGTH);
	const json = JSON.stringify({
		v: payload.version,
		r: payload.relayUrl,
		d: payload.deviceId,
		p: payload.pairId,
		t: toBase64Url(payload.pairingToken),
		k: toBase64Url(payload.pcPublicKey),
		...(pcName ? { n: pcName } : {}),
	});
	return `${PAIRING_URI_SCHEME}?d=${toBase64Url(new TextEncoder().encode(json))}`;
}

export function decodePairingUri(uri: string): PairingPayload {
	const prefix = `${PAIRING_URI_SCHEME}?d=`;
	if (!uri.startsWith(prefix)) {
		throw new Error('not a Para Code pairing URI');
	}
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(new TextDecoder().decode(fromBase64Url(uri.slice(prefix.length)))) as Record<string, unknown>;
	} catch {
		throw new Error('malformed pairing payload');
	}
	if (raw === null || typeof raw !== 'object' || raw['v'] !== 1) {
		throw new Error('unsupported pairing payload');
	}
	const relayUrl = raw['r'];
	const deviceId = raw['d'];
	const pairId = raw['p'];
	const token = raw['t'];
	const key = raw['k'];
	if (typeof relayUrl !== 'string' || typeof deviceId !== 'string' || typeof pairId !== 'string' || typeof token !== 'string' || typeof key !== 'string') {
		throw new Error('malformed pairing payload');
	}
	// deviceId はモバイル側でPCの識別子として保存名（Keychainのアカウント名・ファイル名）に
	// 使われる。パスや保存名を壊せる文字は最初から受け付けない。
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(deviceId)) {
		throw new Error('malformed pairing payload: deviceId');
	}
	const pcPublicKey = fromBase64Url(key);
	if (pcPublicKey.length !== 32) {
		throw new Error('malformed pairing payload: pcPublicKey');
	}
	// PC名は後から足したフィールドなので、無い・文字列でない場合も失敗させない。
	const rawName = raw['n'];
	const pcName = typeof rawName === 'string' ? rawName.trim().slice(0, PAIRING_PC_NAME_MAX_LENGTH) : '';
	return {
		version: 1, relayUrl, deviceId, pairId, pairingToken: fromBase64Url(token), pcPublicKey,
		...(pcName ? { pcName } : {}),
	};
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
