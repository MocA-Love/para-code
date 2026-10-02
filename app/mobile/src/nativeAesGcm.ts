// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { bytesEqual, nobleAesGcm, setAesGcmBackend, type AesGcmBackend } from '@para/protocol';

/**
 * ネイティブの AES-256-GCM（`modules/para-aes-gcm`）の JS から見た形。どちらも同期で、失敗は throw。
 * 戻り値はネイティブのメモリを指す ArrayBuffer（コピーしない）。
 */
export interface NativeAesGcmModule {
	open(key: Uint8Array, sealed: Uint8Array): ArrayBuffer;
	seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): ArrayBuffer;
}

/** ネイティブのモジュールを `@para/protocol` の AES-GCM の実装の形に包む。 */
export function createNativeAesGcmBackend(native: NativeAesGcmModule): AesGcmBackend {
	return {
		name: 'native',
		open: (key, sealed) => toBytes(native.open(key, sealed)),
		seal: (key, nonce, plaintext) => toBytes(native.seal(key, nonce, plaintext)),
	};
}

/** `installNativeAesGcm` の結果。`noble` のときは理由を持つ。 */
export type NativeAesGcmInstallResult =
	| { readonly backend: 'native' }
	| { readonly backend: 'noble'; readonly reason: 'unavailable' | 'self-check-failed'; readonly detail?: string };

/**
 * ネイティブの実装があれば、セッションのフレームの AES-GCM に登録する。無い（古いバイナリ・Android）なら
 * 既定の noble のまま。
 *
 * 登録の前に、固定の値で noble と同じバイト列になるか（封緘）と、noble の封緘を開けるか・改ざんを弾くか（開封）を
 * 1 回だけ確かめる（数十バイトなので 1ms もかからない）。食い違う実装を登録すると、全フレームの復号に失敗して
 * 接続がつながらなくなるため、そのときは noble に残す。
 */
export function installNativeAesGcm(native: NativeAesGcmModule | null): NativeAesGcmInstallResult {
	if (native === null) {
		setAesGcmBackend(undefined);
		return { backend: 'noble', reason: 'unavailable' };
	}
	const backend = createNativeAesGcmBackend(native);
	const problem = checkAgainstNoble(backend);
	if (problem !== undefined) {
		setAesGcmBackend(undefined);
		return { backend: 'noble', reason: 'self-check-failed', detail: problem };
	}
	setAesGcmBackend(backend);
	return { backend: 'native' };
}

/**
 * 固定の値で noble と突き合わせる。問題が無ければ `undefined`、あれば説明。
 *
 * 本番ではハンドシェイクの `response.subarray(32)` のように byteOffset が 0 でない view も渡るので、
 * 先頭に余分なバイトを付けた配列の `subarray` でも、封緘（平文）と開封（封緘）を 1 回ずつ確かめる。
 */
export function checkAgainstNoble(backend: AesGcmBackend, plaintext: Uint8Array = SELF_CHECK_PLAINTEXT): string | undefined {
	try {
		const expected = nobleAesGcm.seal(SELF_CHECK_KEY, SELF_CHECK_NONCE, plaintext);
		const sealed = backend.seal(SELF_CHECK_KEY, SELF_CHECK_NONCE, plaintext);
		if (!bytesEqual(sealed, expected)) {
			return 'seal differs from noble';
		}
		if (!bytesEqual(backend.seal(SELF_CHECK_KEY, SELF_CHECK_NONCE, withOffset(plaintext)), expected)) {
			return 'seal of an offset view differs from noble';
		}
		if (!bytesEqual(backend.open(SELF_CHECK_KEY, expected), plaintext)) {
			return 'open differs from noble';
		}
		if (!bytesEqual(backend.open(SELF_CHECK_KEY, withOffset(expected)), plaintext)) {
			return 'open of an offset view differs from noble';
		}
		const tampered = Uint8Array.from(expected);
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
		try {
			backend.open(SELF_CHECK_KEY, tampered);
		} catch {
			return undefined;
		}
		return 'open accepted a tampered tag';
	} catch (error) {
		return `threw: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * 同じ中身を、先頭に 5 バイトの別の値を置いた配列の `subarray(5)`（byteOffset が 5 の view）として返す。
 * byteOffset を無視して先頭から読む実装を見つけるため。
 */
export function withOffset(bytes: Uint8Array): Uint8Array {
	const padded = new Uint8Array(bytes.length + 5);
	padded.fill(0xa5, 0, 5);
	padded.set(bytes, 5);
	return padded.subarray(5);
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	return new Uint8Array(value);
}

const SELF_CHECK_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 7) & 0xff);
// 先頭 8 バイトにカウンタ（ビッグエンディアン）、残り 4 バイトは 0（crypto.ts の nonceFor と同じ配置）。
const SELF_CHECK_NONCE = Uint8Array.from([0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0]);
// ブロック境界（16 バイト）をまたぐ長さにする。
const SELF_CHECK_PLAINTEXT = Uint8Array.from({ length: 37 }, (_, i) => (i * 13 + 1) & 0xff);
