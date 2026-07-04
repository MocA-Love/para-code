/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code Mobile の E2E 暗号（PC側、Node/Web webcrypto 実装）。
// app/protocol/test/webcryptoRef.ts の移植元と同一ロジック。@noble 実装（モバイル側）との
// バイト互換は app/protocol/test/interop.test.ts が保証する。アルゴリズムは
// X25519 + HKDF-SHA256 + AES-256-GCM(12Bカウンタnonce)。

const PROTOCOL_INFO = new TextEncoder().encode('para-code-mobile/1');
const ACK_PAYLOAD = new TextEncoder().encode('para-hs-ack');
const CONFIRM_PAYLOAD = new TextEncoder().encode('para-hs-confirm');
const NONCE_LENGTH = 12;

// globalThis.crypto は Electron の shared process(Node)/renderer 双方で利用可能。
const subtle = globalThis.crypto.subtle;

export interface MobileIdentity {
	readonly publicKey: Uint8Array;
	readonly privateKey: CryptoKey;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((s, a) => s + a.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const a of arrays) { out.set(a, o); o += a.length; }
	return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) { return false; }
	let diff = 0;
	for (let i = 0; i < a.length; i++) { diff |= (a[i] ?? 0) ^ (b[i] ?? 0); }
	return diff === 0;
}

function asKeyPair(key: CryptoKey | CryptoKeyPair): CryptoKeyPair {
	// X25519 は非対称鍵なので generateKey は必ず CryptoKeyPair を返す。単一の CryptoKey
	// (CryptoKeyインスタンス) が返るのは対称鍵アルゴリズムのときだけ。
	if (key instanceof CryptoKey) {
		throw new Error('expected a CryptoKeyPair');
	}
	return key;
}

export async function generateMobileIdentity(): Promise<MobileIdentity> {
	const pair = asKeyPair(await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']));
	const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
	return { publicKey: raw, privateKey: pair.privateKey };
}

/** 生の秘密鍵(pkcs8)から Identity を復元する（永続化した鍵の読み戻し用）。 */
export async function importIdentity(pkcs8: Uint8Array, publicKey: Uint8Array): Promise<MobileIdentity> {
	const privateKey = await subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'X25519' }, false, ['deriveBits']);
	return { privateKey, publicKey };
}

/** 保存可能な鍵ペアを生成し、pkcs8秘密鍵も返す。 */
export async function generatePersistableIdentity(): Promise<{ identity: MobileIdentity; pkcs8: Uint8Array }> {
	const pair = asKeyPair(await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']));
	const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
	const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
	// 以後の deriveBits 用に non-extractable として再importしておく（秘密鍵の露出面を減らす）。
	const privateKey = await subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'X25519' }, false, ['deriveBits']);
	return { identity: { publicKey, privateKey }, pkcs8 };
}

async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
	return subtle.importKey('raw', raw as BufferSource, { name: 'X25519' }, false, []);
}

async function dh(privateKey: CryptoKey, peerPublic: Uint8Array): Promise<Uint8Array> {
	const pub = await importPublicKey(peerPublic);
	// X25519 の deriveBits パラメータは EcdhKeyDeriveParams と同形（{name, public}）。
	const params: EcdhKeyDeriveParams = { name: 'X25519', public: pub };
	const bits = await subtle.deriveBits(params, privateKey, 256);
	return new Uint8Array(bits);
}

async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const base = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
	const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, base, length * 8);
	return new Uint8Array(bits);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await subtle.digest('SHA-256', data as BufferSource));
}

function nonceFor(counter: bigint): Uint8Array {
	const nonce = new Uint8Array(NONCE_LENGTH);
	let v = counter;
	for (let i = 7; i >= 0; i--) { nonce[i] = Number(v & 0xffn); v >>= 8n; }
	return nonce;
}

class Cipher {
	private counter = 0n;
	constructor(private readonly key: CryptoKey) { }

	async seal(plaintext: Uint8Array): Promise<Uint8Array> {
		const nonce = nonceFor(this.counter);
		const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, this.key, plaintext as BufferSource));
		this.counter++;
		return concat(nonce, ct);
	}

	async open(message: Uint8Array): Promise<Uint8Array> {
		if (message.length < NONCE_LENGTH) { throw new Error('message too short'); }
		const nonce = message.subarray(0, NONCE_LENGTH);
		const expected = nonceFor(this.counter);
		for (let i = 0; i < NONCE_LENGTH; i++) {
			if (nonce[i] !== expected[i]) { throw new Error('unexpected nonce (out-of-order or replayed message)'); }
		}
		// 復号成功時のみカウンタを進める（失敗時に進めると1フレームで恒久desyncする。H-1）。
		const pt = await subtle.decrypt({ name: 'AES-GCM', iv: expected as BufferSource }, this.key, message.subarray(NONCE_LENGTH) as BufferSource);
		this.counter++;
		return new Uint8Array(pt);
	}
}

export class SecureChannel {
	private readonly tx: Cipher;
	private readonly rx: Cipher;
	constructor(txKey: CryptoKey, rxKey: CryptoKey) {
		this.tx = new Cipher(txKey);
		this.rx = new Cipher(rxKey);
	}
	seal(plaintext: Uint8Array): Promise<Uint8Array> { return this.tx.seal(plaintext); }
	open(message: Uint8Array): Promise<Uint8Array> { return this.rx.open(message); }
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
	return subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function deriveKeys(dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array, dh4: Uint8Array, transcript: Uint8Array): Promise<{ initiatorToResponder: CryptoKey; responderToInitiator: CryptoKey }> {
	const okm = await hkdfSha256(concat(dh1, dh2, dh3, dh4), await sha256(transcript), PROTOCOL_INFO, 64);
	return {
		initiatorToResponder: await importAesKey(okm.slice(0, 32)),
		responderToInitiator: await importAesKey(okm.slice(32, 64)),
	};
}

function transcriptOf(initEph: Uint8Array, respEph: Uint8Array, initStatic: Uint8Array, respStatic: Uint8Array): Uint8Array {
	return concat(PROTOCOL_INFO, initEph, respEph, initStatic, respStatic);
}

/**
 * レスポンダ（PC側）のハンドシェイク。モバイル(イニシエータ)の hello を受け、
 * response を返す。confirm 検証でイニシエータの静的鍵所持を確認する。
 */
export async function respondHandshake(responderStatic: MobileIdentity, initiatorStaticPub: Uint8Array, hello: Uint8Array): Promise<{ response: Uint8Array; channel: SecureChannel; verifyConfirm: (confirm: Uint8Array) => Promise<void> }> {
	if (hello.length !== 32) { throw new Error('handshake hello must be 32 bytes'); }
	const eph = await generateMobileIdentity();
	const transcript = transcriptOf(hello, eph.publicKey, initiatorStaticPub, responderStatic.publicKey);
	const keys = await deriveKeys(
		await dh(eph.privateKey, hello),
		await dh(responderStatic.privateKey, hello),
		await dh(eph.privateKey, initiatorStaticPub),
		await dh(responderStatic.privateKey, initiatorStaticPub),
		transcript,
	);
	const channel = new SecureChannel(keys.responderToInitiator, keys.initiatorToResponder);
	const response = concat(eph.publicKey, await channel.seal(ACK_PAYLOAD));
	return {
		response,
		channel,
		verifyConfirm: async (confirm: Uint8Array) => {
			const payload = await channel.open(confirm);
			if (!equalBytes(payload, CONFIRM_PAYLOAD)) { throw new Error('handshake confirm mismatch'); }
		},
	};
}

/** SAS 6桁コード導出（app/protocol/src/pairing.ts と一致）。 */
export async function deriveSasCode(ownStatic: MobileIdentity, peerStaticPub: Uint8Array, pairingToken: Uint8Array): Promise<string> {
	const shared = await dh(ownStatic.privateKey, peerStaticPub);
	const okm = await hkdfSha256(shared, await sha256(pairingToken), new TextEncoder().encode('para-code-mobile/sas/1'), 4);
	const value = (((okm[0] ?? 0) << 24) | ((okm[1] ?? 0) << 16) | ((okm[2] ?? 0) << 8) | (okm[3] ?? 0)) >>> 0;
	return String(value % 1_000_000).padStart(6, '0');
}
