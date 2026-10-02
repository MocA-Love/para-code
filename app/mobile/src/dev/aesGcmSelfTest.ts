// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { bytesEqual, getAesGcmBackend, nobleAesGcm, type AesGcmBackend } from '@para/protocol';
import { createNativeAesGcmBackend, withOffset, type NativeAesGcmModule } from '../nativeAesGcm.js';

/**
 * 開発ビルド専用: ネイティブの AES-GCM（`modules/para-aes-gcm`）を noble と突き合わせ、所要時間を測る
 * （`globalThis.__paraDev.aesGcmSelfTest()`。ネイティブは実機・シミュレータでしか動かないため、ここで確かめる）。
 *
 * - `kat`: GCM の仕様書の試験値（AES-256、鍵・IV・平文が全部 0、Test Case 14）とネイティブの封緘が一致するか
 * - `vectors`: 長さを変えた固定の値（0 バイトの空の平文を含む）で、封緘のバイト列が noble と一致し、互いの封緘を開けるか。
 *   byteOffset が 0 でない view（ハンドシェイクの `response.subarray(32)` と同じ形）を渡しても同じ結果になるか（`offsetViewMatches`）
 * - `tamperRejected`: タグを 1 ビット変えた封緘をネイティブが弾くか
 * - `timing`: `totalBytes`（既定 21MB）を `chunkBytes`（既定 700KiB。`FRAME_CHUNK_BYTES` と同じ）ずつ開く時間。
 *   noble は数秒かかるので `skipNoble: true` で省ける
 */
export interface AesGcmSelfTestOptions {
	readonly totalBytes?: number;
	readonly chunkBytes?: number;
	readonly skipNoble?: boolean;
	readonly now?: () => number;
}

export interface AesGcmSelfTestResult {
	/** いまセッションに使っている実装の名前。 */
	readonly activeBackend: string;
	readonly nativeAvailable: boolean;
	readonly kat?: boolean;
	readonly vectors?: readonly { readonly size: number; readonly sealMatches: boolean; readonly nativeOpensNoble: boolean; readonly nobleOpensNative: boolean; readonly offsetViewMatches: boolean }[];
	readonly tamperRejected?: boolean;
	readonly timing?: {
		readonly bytes: number;
		readonly chunks: number;
		readonly nativeOpenMs: number;
		readonly nativeSealMs: number;
		readonly nobleOpenMs?: number;
		readonly plaintextMatches: boolean;
	};
	/** 全部一致したか（`timing` の所要時間は含まない）。 */
	readonly ok: boolean;
	readonly error?: string;
}

const KAT_KEY = new Uint8Array(32);
const KAT_NONCE = new Uint8Array(12);
const KAT_PLAINTEXT = new Uint8Array(16);
// The Galois/Counter Mode of Operation (McGrew & Viega), Test Case 14: 暗号文 cea7403d4d606b6e074ec5d3baf39d18 ・ タグ d0d1c8a799996bf0265b98b5d48ab919
const KAT_SEALED_HEX = '000000000000000000000000' + 'cea7403d4d606b6e074ec5d3baf39d18' + 'd0d1c8a799996bf0265b98b5d48ab919';

// 0 は空の平文（ネイティブ側で `NativeArrayBuffer.allocate(size: 0)` を返す分岐）を通すため。
const VECTOR_SIZES = [0, 1, 15, 16, 37, 4096, 700 * 1024];

export function runAesGcmSelfTest(native: NativeAesGcmModule | null, options: AesGcmSelfTestOptions = {}): AesGcmSelfTestResult {
	const activeBackend = getAesGcmBackend().name;
	if (native === null) {
		return { activeBackend, nativeAvailable: false, ok: false };
	}
	const backend = createNativeAesGcmBackend(native);
	const now = options.now ?? defaultNow;
	try {
		const kat = toHex(backend.seal(KAT_KEY, KAT_NONCE, KAT_PLAINTEXT)) === KAT_SEALED_HEX;
		const key = pattern(32, 3);
		const nonce = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 0]);
		const vectors = VECTOR_SIZES.map(size => {
			const plaintext = pattern(size, size);
			const fromNoble = nobleAesGcm.seal(key, nonce, plaintext);
			const fromNative = backend.seal(key, nonce, plaintext);
			return {
				size,
				sealMatches: bytesEqual(fromNative, fromNoble),
				nativeOpensNoble: bytesEqual(backend.open(key, fromNoble), plaintext),
				nobleOpensNative: bytesEqual(nobleAesGcm.open(key, fromNative), plaintext),
				offsetViewMatches: bytesEqual(backend.seal(key, nonce, withOffset(plaintext)), fromNoble)
					&& bytesEqual(backend.open(key, withOffset(fromNoble)), plaintext),
			};
		});
		const tamperRejected = rejectsTampered(backend, key, nonce);
		const timing = measure(backend, key, options, now);
		const ok = kat && tamperRejected && timing.plaintextMatches && vectors.every(v => v.sealMatches && v.nativeOpensNoble && v.nobleOpensNative && v.offsetViewMatches);
		return { activeBackend, nativeAvailable: true, kat, vectors, tamperRejected, timing, ok };
	} catch (error) {
		return { activeBackend, nativeAvailable: true, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function rejectsTampered(backend: AesGcmBackend, key: Uint8Array, nonce: Uint8Array): boolean {
	const sealed = nobleAesGcm.seal(key, nonce, pattern(100, 9));
	for (const index of [12, 60, sealed.length - 1]) {
		const tampered = Uint8Array.from(sealed);
		tampered[index] = (tampered[index] ?? 0) ^ 0x01;
		try {
			backend.open(key, tampered);
			return false;
		} catch {
			// 弾いた
		}
	}
	return true;
}

function measure(backend: AesGcmBackend, key: Uint8Array, options: AesGcmSelfTestOptions, now: () => number): NonNullable<AesGcmSelfTestResult['timing']> {
	const totalBytes = options.totalBytes ?? 21 * 1024 * 1024;
	const chunkBytes = options.chunkBytes ?? 700 * 1024;
	const plaintexts: Uint8Array[] = [];
	for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
		plaintexts.push(pattern(Math.min(chunkBytes, totalBytes - offset), offset));
	}
	const nonces = plaintexts.map((_, index) => counterNonce(index));

	let startedAt = now();
	const sealed = plaintexts.map((plaintext, index) => backend.seal(key, nonces[index]!, plaintext));
	const nativeSealMs = now() - startedAt;

	startedAt = now();
	const opened = sealed.map(message => backend.open(key, message));
	const nativeOpenMs = now() - startedAt;
	const plaintextMatches = opened.every((plaintext, index) => bytesEqual(plaintext, plaintexts[index]!));

	let nobleOpenMs: number | undefined;
	if (options.skipNoble !== true) {
		startedAt = now();
		for (const message of sealed) {
			nobleAesGcm.open(key, message);
		}
		nobleOpenMs = now() - startedAt;
	}
	return { bytes: totalBytes, chunks: sealed.length, nativeOpenMs, nativeSealMs, ...(nobleOpenMs !== undefined ? { nobleOpenMs } : {}), plaintextMatches };
}

/** 決まった値で埋めたバイト列（乱数を使わず、毎回同じ値で比べられるようにする）。 */
function pattern(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let x = (seed * 2654435761) >>> 0 || 1;
	for (let i = 0; i < length; i++) {
		x ^= x << 13; x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5; x >>>= 0;
		bytes[i] = x & 0xff;
	}
	return bytes;
}

function counterNonce(counter: number): Uint8Array {
	const nonce = new Uint8Array(12);
	new DataView(nonce.buffer).setUint32(4, counter);
	return nonce;
}

function toHex(bytes: Uint8Array): string {
	let hex = '';
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex;
}

function defaultNow(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

