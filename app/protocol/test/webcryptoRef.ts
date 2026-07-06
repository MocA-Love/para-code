// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC側(src/vs, Node webcrypto)で使う暗号実装の「参照実装」。
 *
 * これは app/protocol の @noble 実装とバイト互換であることをテスト(interop.test.ts)で保証し、
 * src/vs/paradis/contrib/mobileRelay/common/paradisMobileCrypto.ts はこのコードを
 * ほぼそのまま移植する（import経路のみ差し替え）。ロジックを二重に持つことになるため、
 * 変更時は必ず両方を更新し interop テストを通すこと。
 *
 * アルゴリズム: X25519 + HKDF-SHA256 + AES-256-GCM(12Bカウンタnonce)。
 */

const PROTOCOL_INFO = new TextEncoder().encode('para-code-mobile/1');
const ACK_PAYLOAD = new TextEncoder().encode('para-hs-ack');
const CONFIRM_PAYLOAD = new TextEncoder().encode('para-hs-confirm');
const NOTIFY_SALT = new TextEncoder().encode('paradis-mobile-notify-v1');
const NOTIFY_INFO = new TextEncoder().encode('notify');
const NONCE_LENGTH = 12;

const subtle = globalThis.crypto.subtle;

export interface WebIdentity {
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

export async function generateWebIdentity(): Promise<WebIdentity> {
	const pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
	const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
	return { publicKey: raw, privateKey: pair.privateKey };
}

export async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
	return subtle.importKey('raw', raw as BufferSource, { name: 'X25519' }, false, []);
}

async function dh(privateKey: CryptoKey, peerPublic: Uint8Array): Promise<Uint8Array> {
	const pub = await importPublicKey(peerPublic);
	const bits = await subtle.deriveBits({ name: 'X25519', public: pub } as unknown as AlgorithmIdentifier, privateKey, 256);
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

class WebCipher {
	private counter = 0n;
	constructor(private readonly key: CryptoKey) { }

	async seal(plaintext: Uint8Array): Promise<Uint8Array> {
		const nonce = nonceFor(this.counter++);
		const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, this.key, plaintext as BufferSource));
		return concat(nonce, ct);
	}

	async open(message: Uint8Array): Promise<Uint8Array> {
		const nonce = message.subarray(0, NONCE_LENGTH);
		const expected = nonceFor(this.counter++);
		for (let i = 0; i < NONCE_LENGTH; i++) {
			if (nonce[i] !== expected[i]) { throw new Error('nonce mismatch'); }
		}
		const pt = await subtle.decrypt({ name: 'AES-GCM', iv: expected as BufferSource }, this.key, message.subarray(NONCE_LENGTH) as BufferSource);
		return new Uint8Array(pt);
	}
}

export class WebSecureChannel {
	private readonly tx: WebCipher;
	private readonly rx: WebCipher;
	constructor(txKey: CryptoKey, rxKey: CryptoKey) {
		this.tx = new WebCipher(txKey);
		this.rx = new WebCipher(rxKey);
	}
	seal(plaintext: Uint8Array): Promise<Uint8Array> { return this.tx.seal(plaintext); }
	open(message: Uint8Array): Promise<Uint8Array> { return this.rx.open(message); }
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
	return subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

interface WebKeys { initiatorToResponder: CryptoKey; responderToInitiator: CryptoKey }

async function deriveKeys(dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array, dh4: Uint8Array, transcript: Uint8Array): Promise<WebKeys> {
	const okm = await hkdfSha256(concat(dh1, dh2, dh3, dh4), await sha256(transcript), PROTOCOL_INFO, 64);
	return {
		initiatorToResponder: await importAesKey(okm.slice(0, 32)),
		responderToInitiator: await importAesKey(okm.slice(32, 64)),
	};
}

function transcriptOf(initEph: Uint8Array, respEph: Uint8Array, initStatic: Uint8Array, respStatic: Uint8Array): Uint8Array {
	return concat(PROTOCOL_INFO, initEph, respEph, initStatic, respStatic);
}

/** レスポンダ（PC側）のハンドシェイク。app/protocol の respondHandshake と互換。 */
export async function webRespond(responderStatic: WebIdentity, initiatorStaticPub: Uint8Array, hello: Uint8Array): Promise<{ response: Uint8Array; channel: WebSecureChannel; verifyConfirm: (c: Uint8Array) => Promise<void> }> {
	const eph = await generateWebIdentity();
	const transcript = transcriptOf(hello, eph.publicKey, initiatorStaticPub, responderStatic.publicKey);
	const keys = await deriveKeys(
		await dh(eph.privateKey, hello),
		await dh(responderStatic.privateKey, hello),
		await dh(eph.privateKey, initiatorStaticPub),
		await dh(responderStatic.privateKey, initiatorStaticPub),
		transcript,
	);
	const channel = new WebSecureChannel(keys.responderToInitiator, keys.initiatorToResponder);
	const response = concat(eph.publicKey, await channel.seal(ACK_PAYLOAD));
	return {
		response,
		channel,
		verifyConfirm: async (confirm: Uint8Array) => {
			const payload = await channel.open(confirm);
			if (payload.length !== CONFIRM_PAYLOAD.length || !payload.every((b, i) => b === CONFIRM_PAYLOAD[i])) {
				throw new Error('confirm mismatch');
			}
		},
	};
}

/** 通知鍵導出のwebcrypto版。app/protocol の deriveNotifyKey と互換（生の32バイト鍵を返す）。 */
export async function webDeriveNotifyKey(ownPrivateKey: CryptoKey, peerPublicKey: Uint8Array): Promise<Uint8Array> {
	const ikm = await dh(ownPrivateKey, peerPublicKey);
	return hkdfSha256(ikm, NOTIFY_SALT, NOTIFY_INFO, 32);
}

/** 通知の封緘のwebcrypto版（12Bランダムnonce || AES-256-GCM暗号文）。 */
export async function webSealNotify(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	const nonce = new Uint8Array(NONCE_LENGTH);
	globalThis.crypto.getRandomValues(nonce);
	const aesKey = await importAesKey(key);
	const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, plaintext as BufferSource));
	return concat(nonce, ct);
}

/** 通知の開封のwebcrypto版（認証失敗はthrow）。 */
export async function webOpenNotify(key: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
	if (sealed.length < NONCE_LENGTH) { throw new Error('sealed notify too short'); }
	const nonce = sealed.subarray(0, NONCE_LENGTH);
	const aesKey = await importAesKey(key);
	const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, sealed.subarray(NONCE_LENGTH) as BufferSource);
	return new Uint8Array(pt);
}

/** イニシエータ（モバイル側）のwebcrypto版。interopの両方向テスト用。 */
export async function webInitiate(initiatorStatic: WebIdentity, responderStaticPub: Uint8Array): Promise<{ hello: Uint8Array; finish: (r: Uint8Array) => Promise<{ channel: WebSecureChannel; confirm: Uint8Array }> }> {
	const eph = await generateWebIdentity();
	return {
		hello: eph.publicKey,
		finish: async (response: Uint8Array) => {
			const respEph = response.subarray(0, 32);
			const sealedAck = response.subarray(32);
			const transcript = transcriptOf(eph.publicKey, respEph, initiatorStatic.publicKey, responderStaticPub);
			const keys = await deriveKeys(
				await dh(eph.privateKey, respEph),
				await dh(eph.privateKey, responderStaticPub),
				await dh(initiatorStatic.privateKey, respEph),
				await dh(initiatorStatic.privateKey, responderStaticPub),
				transcript,
			);
			const channel = new WebSecureChannel(keys.initiatorToResponder, keys.responderToInitiator);
			const ack = await channel.open(sealedAck);
			if (ack.length !== ACK_PAYLOAD.length || !ack.every((b, i) => b === ACK_PAYLOAD[i])) {
				throw new Error('ack mismatch');
			}
			return { channel, confirm: await channel.seal(CONFIRM_PAYLOAD) };
		},
	};
}
