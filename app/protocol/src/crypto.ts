// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Para Code Mobile の E2E 暗号レイヤー。
 *
 * - 長期鍵: X25519（PC・モバイルがペアリング時に公開鍵を交換済みであることが前提）
 * - セッション確立: 両側 ephemeral + 静的鍵の 4-DH（Noise IK/XX 相当の考え方の簡略実装）。
 *   ephemeral を両側で混ぜるため前方秘匿性を持つ。相手の静的秘密鍵を持たない攻撃者は
 *   セッション鍵を導出できず、最初の封緘メッセージの復号に失敗する（=なりすまし検出）。
 * - フレーム暗号: AES-256-GCM（webcrypto と @noble の双方が実装しバイト互換にできるため採用。
 *   選定理由の詳細は下の NONCE_LENGTH/KEY_LENGTH 付近のコメント参照）、方向別鍵 + 単調増加
 *   カウンタnonce（トランスポートは WSS で順序保証があるため、受信側はカウンタの厳密一致を
 *   要求し、リプレイ/欠落を検出する）
 *
 * 注意: これはハンドシェイクの手書き実装であり、リリース前に必ず暗号レビューを行うこと
 * （設計書 §8 参照）。プリミティブは @noble/*（監査済み・純JS・Node/Workers/RN共通）を使う。
 */

import { gcm } from '@noble/ciphers/aes';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { concatBytes } from './util.js';

const PROTOCOL_INFO = new TextEncoder().encode('para-code-mobile/1');
const ACK_PAYLOAD = new TextEncoder().encode('para-hs-ack');
const CONFIRM_PAYLOAD = new TextEncoder().encode('para-hs-confirm');
// プッシュ通知用の鍵導出パラメータ。セッション鍵と混ざらないよう salt/info を分離する。
const NOTIFY_SALT = new TextEncoder().encode('paradis-mobile-notify-v1');
const NOTIFY_INFO = new TextEncoder().encode('notify');
// AES-256-GCM を採用（Node/Web の webcrypto と @noble の双方が実装するため、
// PC側=webcrypto / モバイル側=@noble でバイト互換にできる。nonceは12バイトのカウンタ。
// セッション鍵は接続毎にephemeral DHで新規導出されるため、カウンタnonceの再利用は起きない）。
const NONCE_LENGTH = 12;
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
 * セッションのフレームの AES-256-GCM（12 バイト nonce・16 バイトのタグ）を実際に計算する実装。
 *
 * 既定は {@link nobleAesGcm}（純 JS）。モバイルアプリは起動時に {@link setAesGcmBackend} でネイティブの実装
 * （iOS の CryptoKit）を登録する。ワイヤ形式は実装によらず `nonce(12) || 暗号文 || タグ(16)` で、PC 側の
 * webcrypto と同じ。カウンタ nonce の照合と進め方は {@link DirectionalCipher} が持ち、実装には任せない。
 */
export interface AesGcmBackend {
	/** 計測・ログで見分けるための名前。 */
	readonly name: string;
	/**
	 * `sealed`（`nonce(12) || 暗号文 || タグ(16)`）を開く。認証に失敗したら throw する。
	 * 返す平文は呼び出し側が自由に持ってよい（`sealed` の一部を指す view を返さない）。
	 */
	open(key: Uint8Array, sealed: Uint8Array): Uint8Array;
	/** `plaintext` を封緘し、`nonce(12) || 暗号文 || タグ(16)` を返す。 */
	seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
}

/** 純 JS（@noble/ciphers）の実装。既定。ネイティブの実装の自己検査の基準にも使う。 */
export const nobleAesGcm: AesGcmBackend = {
	name: 'noble',
	open: (key, sealed) => {
		if (sealed.length < NONCE_LENGTH) {
			throw new Error('message too short');
		}
		return gcm(key, sealed.subarray(0, NONCE_LENGTH)).decrypt(sealed.subarray(NONCE_LENGTH));
	},
	seal: (key, nonce, plaintext) => concatBytes(nonce, gcm(key, nonce).encrypt(plaintext)),
};

let aesGcmBackend: AesGcmBackend = nobleAesGcm;

/**
 * セッションのフレームの AES-GCM の実装を差し替える。`undefined` で既定（noble）へ戻す。
 * 確立済みのチャネルにも次のフレームから効く（鍵とカウンタはチャネル側が持つため）。
 */
export function setAesGcmBackend(backend: AesGcmBackend | undefined): void {
	aesGcmBackend = backend ?? nobleAesGcm;
}

/** いま使っている AES-GCM の実装。 */
export function getAesGcmBackend(): AesGcmBackend {
	return aesGcmBackend;
}

/**
 * 差し替えた実装の例外を、noble と同じ素の `Error` に包み直す。ネイティブの例外（Expo の同期 Function の例外は
 * `Error.prototype` そのものの `Error` に `code` を足した形で届く）の形に呼び出し側が依存しないようにし、
 * ログでどの実装が失敗したか分かるよう `aes/gcm (<name>):` を付ける。元の例外は `cause` に残す。
 * 既定の noble の例外は今までどおりそのまま投げる。
 */
function asPlainError(error: unknown, backend: AesGcmBackend): unknown {
	if (backend === nobleAesGcm) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`aes/gcm (${backend.name}): ${message}`, { cause: error });
}

/**
 * 一方向の暗号チャネル。鍵は方向ごとに独立で、nonceは単調増加カウンタ。
 */
class DirectionalCipher {
	private counter = 0n;

	constructor(private readonly key: Uint8Array) { }

	seal(plaintext: Uint8Array): Uint8Array {
		const nonce = this.nonceFor(this.counter);
		const backend = aesGcmBackend;
		let sealed: Uint8Array;
		try {
			sealed = backend.seal(this.key, nonce, plaintext);
		} catch (error) {
			throw asPlainError(error, backend);
		}
		this.counter++;
		return sealed;
	}

	open(message: Uint8Array): Uint8Array {
		if (message.length < NONCE_LENGTH) {
			throw new Error('message too short');
		}
		const nonce = message.subarray(0, NONCE_LENGTH);
		const expected = this.nonceFor(this.counter);
		for (let i = 0; i < NONCE_LENGTH; i++) {
			if (nonce[i] !== expected[i]) {
				throw new Error('unexpected nonce (out-of-order or replayed message)');
			}
		}
		// 復号（認証失敗はthrow）が成功して初めてカウンタを進める。失敗時に進めると
		// 不正・欠落フレーム1個で受信側が恒久desyncするため（H-1）。差し替えた実装でも同じ。
		// nonce は上で expected と一致を確かめたので、message をそのまま渡す。
		const backend = aesGcmBackend;
		let plaintext: Uint8Array;
		try {
			plaintext = backend.open(this.key, message);
		} catch (error) {
			throw asPlainError(error, backend);
		}
		this.counter++;
		return plaintext;
	}

	private nonceFor(value: bigint): Uint8Array {
		const nonce = new Uint8Array(NONCE_LENGTH);
		// 先頭8バイトにカウンタをビッグエンディアンで置く（残り4バイトは0固定）。
		// webcrypto実装と一致させるため配置を厳密に定める。
		for (let i = 7; i >= 0; i--) {
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

/**
 * プッシュ通知用の「通知鍵」を双方の長期鍵から導出する（32バイト）。
 *
 * セッション鍵と違い ephemeral を混ぜないため、WS接続なしでも両側が同じ鍵を計算できる
 * （iOS の Notification Service Extension はアプリ未起動・接続なしで復号する必要がある）。
 * X25519 の対称性により、PC側 (PC秘密鍵, モバイル公開鍵) とモバイル側 (モバイル秘密鍵,
 * PC公開鍵) が同一の共有秘密＝同一の通知鍵になる。
 */
export function deriveNotifyKey(ownSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
	const ikm = x25519.getSharedSecret(ownSecretKey, peerPublicKey);
	return hkdf(sha256, ikm, NOTIFY_SALT, NOTIFY_INFO, KEY_LENGTH);
}

/**
 * 通知ペイロードを通知鍵で封緘する: 12バイトのランダムnonce || AES-256-GCM暗号文(tag込み)。
 *
 * セッション暗号は順序保証のあるWS上でカウンタnonceを使うが、通知は低頻度かつ長期鍵で
 * カウンタ状態を共有できない（送信は複数プロセス・受信はNSE）ため、ランダムnonceにする。
 */
export function sealNotify(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
	const nonce = randomBytes(NONCE_LENGTH);
	return concatBytes(nonce, gcm(key, nonce).encrypt(plaintext));
}

/** 封緘された通知を開封する（認証失敗はthrow）。 */
export function openNotify(key: Uint8Array, sealed: Uint8Array): Uint8Array {
	if (sealed.length < NONCE_LENGTH) {
		throw new Error('sealed notify too short');
	}
	const nonce = sealed.subarray(0, NONCE_LENGTH);
	return gcm(key, nonce).decrypt(sealed.subarray(NONCE_LENGTH));
}
