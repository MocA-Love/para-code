// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Para Code Mobile の E2E 暗号レイヤー。
 *
 * - 長期鍵: X25519（PC・モバイルがペアリング時に公開鍵を交換済みであることが前提）
 * - セッション確立: 両側 ephemeral + 静的鍵の 4-DH（Noise IK/XX 相当の考え方の簡略実装）。
 *   ephemeral を両側で混ぜるため前方秘匿性を持つ。相手の静的秘密鍵を持たない攻撃者は
 *   セッション鍵を導出できず、最初の封緘メッセージの復号に失敗する（=なりすまし検出）。
 * - フレーム暗号: XChaCha20-Poly1305、方向別鍵 + 単調増加カウンタnonce（トランスポートは
 *   WSS で順序保証があるため、受信側はカウンタの厳密一致を要求し、リプレイ/欠落を検出する）
 *
 * 注意: これはハンドシェイクの手書き実装であり、リリース前に必ず暗号レビューを行うこと
 * （設計書 §8 参照）。プリミティブは @noble/*（監査済み・純JS・Node/Workers/RN共通）を使う。
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { concatBytes } from './util.js';

const PROTOCOL_INFO = new TextEncoder().encode('para-code-mobile/1');
const ACK_PAYLOAD = new TextEncoder().encode('para-hs-ack');
const CONFIRM_PAYLOAD = new TextEncoder().encode('para-hs-confirm');
const NONCE_LENGTH = 24;
const KEY_LENGTH = 32;

export interface Identity {
	readonly publicKey: Uint8Array;
	readonly secretKey: Uint8Array;
}

export function generateIdentity(): Identity {
	const secretKey = x25519.utils.randomPrivateKey();
	return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/**
 * 一方向の暗号チャネル。鍵は方向ごとに独立で、nonceは単調増加カウンタ。
 */
class DirectionalCipher {
	private counter = 0n;

	constructor(private readonly key: Uint8Array) { }

	seal(plaintext: Uint8Array): Uint8Array {
		const nonce = this.nextNonce();
		return concatBytes(nonce, xchacha20poly1305(this.key, nonce).encrypt(plaintext));
	}

	open(message: Uint8Array): Uint8Array {
		if (message.length < NONCE_LENGTH) {
			throw new Error('message too short');
		}
		const nonce = message.subarray(0, NONCE_LENGTH);
		const expected = this.nextNonce();
		for (let i = 0; i < NONCE_LENGTH; i++) {
			if (nonce[i] !== expected[i]) {
				throw new Error('unexpected nonce (out-of-order or replayed message)');
			}
		}
		return xchacha20poly1305(this.key, expected).decrypt(message.subarray(NONCE_LENGTH));
	}

	private nextNonce(): Uint8Array {
		const nonce = new Uint8Array(NONCE_LENGTH);
		let value = this.counter++;
		for (let i = 0; i < 8; i++) {
			nonce[i] = Number(value & 0xffn);
			value >>= 8n;
		}
		return nonce;
	}
}

/** ハンドシェイク完了後の双方向セキュアチャネル。 */
export class SecureChannel {
	private readonly tx: DirectionalCipher;
	private readonly rx: DirectionalCipher;

	constructor(txKey: Uint8Array, rxKey: Uint8Array) {
		this.tx = new DirectionalCipher(txKey);
		this.rx = new DirectionalCipher(rxKey);
	}

	seal(plaintext: Uint8Array): Uint8Array {
		return this.tx.seal(plaintext);
	}

	open(message: Uint8Array): Uint8Array {
		return this.rx.open(message);
	}
}

interface DerivedKeys {
	readonly initiatorToResponder: Uint8Array;
	readonly responderToInitiator: Uint8Array;
}

function deriveSessionKeys(
	dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array, dh4: Uint8Array,
	transcript: Uint8Array,
): DerivedKeys {
	const okm = hkdf(sha256, concatBytes(dh1, dh2, dh3, dh4), sha256(transcript), PROTOCOL_INFO, KEY_LENGTH * 2);
	return {
		initiatorToResponder: okm.slice(0, KEY_LENGTH),
		responderToInitiator: okm.slice(KEY_LENGTH, KEY_LENGTH * 2),
	};
}

function buildTranscript(initiatorEphPub: Uint8Array, responderEphPub: Uint8Array, initiatorStaticPub: Uint8Array, responderStaticPub: Uint8Array): Uint8Array {
	return concatBytes(PROTOCOL_INFO, initiatorEphPub, responderEphPub, initiatorStaticPub, responderStaticPub);
}

/**
 * イニシエータ（モバイル側）のハンドシェイク状態。
 *
 * 1. `createInitiator()` → `hello` を相手へ送る
 * 2. 相手からの `response` を `finish()` に渡す → `confirm` を送り返し、チャネル確立
 */
export interface InitiatorHandshake {
	/** 相手に送る最初のメッセージ（ephemeral公開鍵）。 */
	readonly hello: Uint8Array;
	/** レスポンダの応答を検証してチャネルを確立し、最後の確認メッセージを返す。 */
	finish(response: Uint8Array): { channel: SecureChannel; confirm: Uint8Array };
}

export function createInitiator(initiatorStatic: Identity, responderStaticPub: Uint8Array): InitiatorHandshake {
	const eph = generateIdentity();
	return {
		hello: eph.publicKey,
		finish: (response: Uint8Array) => {
			if (response.length < 32) {
				throw new Error('handshake response too short');
			}
			const responderEphPub = response.subarray(0, 32);
			const sealedAck = response.subarray(32);

			const transcript = buildTranscript(eph.publicKey, responderEphPub, initiatorStatic.publicKey, responderStaticPub);
			const keys = deriveSessionKeys(
				x25519.getSharedSecret(eph.secretKey, responderEphPub),
				x25519.getSharedSecret(eph.secretKey, responderStaticPub),
				x25519.getSharedSecret(initiatorStatic.secretKey, responderEphPub),
				x25519.getSharedSecret(initiatorStatic.secretKey, responderStaticPub),
				transcript,
			);
			const channel = new SecureChannel(keys.initiatorToResponder, keys.responderToInitiator);

			// レスポンダの静的秘密鍵を持つ者だけが正しい鍵で ack を封緘できる。
			const ack = channel.open(sealedAck);
			if (ack.length !== ACK_PAYLOAD.length || !ack.every((b, i) => b === ACK_PAYLOAD[i])) {
				throw new Error('handshake ack mismatch');
			}
			return { channel, confirm: channel.seal(CONFIRM_PAYLOAD) };
		},
	};
}

/**
 * レスポンダ（PC側）のハンドシェイク処理。
 *
 * 1. 相手の `hello` を `respondHandshake()` に渡す → `response` を送り返す
 * 2. 相手からの `confirm` を `verifyConfirm()` で検証（イニシエータの静的鍵所持の確認）
 */
export interface ResponderHandshake {
	readonly response: Uint8Array;
	readonly channel: SecureChannel;
	verifyConfirm(confirm: Uint8Array): void;
}

export function respondHandshake(responderStatic: Identity, initiatorStaticPub: Uint8Array, hello: Uint8Array): ResponderHandshake {
	if (hello.length !== 32) {
		throw new Error('handshake hello must be 32 bytes');
	}
	const eph = generateIdentity();
	const transcript = buildTranscript(hello, eph.publicKey, initiatorStaticPub, responderStatic.publicKey);
	const keys = deriveSessionKeys(
		x25519.getSharedSecret(eph.secretKey, hello),
		x25519.getSharedSecret(responderStatic.secretKey, hello),
		x25519.getSharedSecret(eph.secretKey, initiatorStaticPub),
		x25519.getSharedSecret(responderStatic.secretKey, initiatorStaticPub),
		transcript,
	);
	// レスポンダから見ると tx=responder→initiator, rx=initiator→responder。
	const channel = new SecureChannel(keys.responderToInitiator, keys.initiatorToResponder);
	return {
		response: concatBytes(eph.publicKey, channel.seal(ACK_PAYLOAD)),
		channel,
		verifyConfirm: (confirm: Uint8Array) => {
			const payload = channel.open(confirm);
			if (payload.length !== CONFIRM_PAYLOAD.length || !payload.every((b, i) => b === CONFIRM_PAYLOAD[i])) {
				throw new Error('handshake confirm mismatch');
			}
		},
	};
}

/** 暗号学的乱数（ペアリングトークン等に使用）。 */
export function randomToken(length: number): Uint8Array {
	return randomBytes(length);
}
