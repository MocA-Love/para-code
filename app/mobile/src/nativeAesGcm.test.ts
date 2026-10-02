// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createCipheriv, createDecipheriv } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { createInitiator, generateIdentity, getAesGcmBackend, nobleAesGcm, respondHandshake, setAesGcmBackend } from '@para/protocol';
import { checkAgainstNoble, createNativeAesGcmBackend, installNativeAesGcm, withOffset, type NativeAesGcmModule } from './nativeAesGcm.js';
import { runAesGcmSelfTest } from './dev/aesGcmSelfTest.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** CryptoKit の代役（node の OpenSSL）。戻り値はネイティブと同じく ArrayBuffer。呼ばれた回数を数える。 */
function fakeNative(): NativeAesGcmModule & { opens: number; seals: number } {
	const native = {
		opens: 0,
		seals: 0,
		open(key: Uint8Array, sealed: Uint8Array): ArrayBuffer {
			native.opens++;
			const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
			decipher.setAuthTag(sealed.subarray(sealed.length - 16));
			return toArrayBuffer(Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]));
		},
		seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): ArrayBuffer {
			native.seals++;
			const cipher = createCipheriv('aes-256-gcm', key, nonce);
			return toArrayBuffer(Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
		},
	};
	return native;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
	const copy = new ArrayBuffer(buffer.length);
	new Uint8Array(copy).set(buffer);
	return copy;
}

/** ネイティブの例外の代役。Expo の同期 Function の例外は、素の `Error` に `code` を足した形で届く。 */
function fakeNativeError(message: string): Error {
	return Object.assign(new Error(message), { code: 'ERR_PARA_AES_GCM' });
}

function establish() {
	const mobile = generateIdentity();
	const pc = generateIdentity();
	const initiator = createInitiator(mobile, pc.publicKey);
	const responder = respondHandshake(pc, mobile.publicKey, initiator.hello);
	const { channel: mobileChannel, confirm } = initiator.finish(responder.response);
	responder.verifyConfirm(confirm);
	return { mobileChannel, pcChannel: responder.channel };
}

afterEach(() => {
	setAesGcmBackend(undefined);
});

describe('native AES-GCM install', () => {
	test('falls back to noble when the native module is missing', () => {
		expect(installNativeAesGcm(null)).toEqual({ backend: 'noble', reason: 'unavailable' });
		expect(getAesGcmBackend()).toBe(nobleAesGcm);
	});

	test('registers the native module and the channel uses it for both directions', () => {
		const native = fakeNative();
		expect(installNativeAesGcm(native)).toEqual({ backend: 'native' });
		expect(getAesGcmBackend().name).toBe('native');
		const checkCalls = { opens: native.opens, seals: native.seals };

		const { mobileChannel, pcChannel } = establish();
		const afterHandshake = { opens: native.opens, seals: native.seals };
		// ハンドシェイクの ack（開封）と confirm（封緘）はモバイル側・PC 側の両方が同じ実装を通る（同じプロセスのため）
		expect(afterHandshake.opens - checkCalls.opens).toBe(2);
		expect(afterHandshake.seals - checkCalls.seals).toBe(2);

		expect(dec(mobileChannel.open(pcChannel.seal(enc('from pc'))))).toBe('from pc');
		expect(dec(pcChannel.open(mobileChannel.seal(enc('from mobile'))))).toBe('from mobile');
		expect({ opens: native.opens - afterHandshake.opens, seals: native.seals - afterHandshake.seals }).toEqual({ opens: 2, seals: 2 });
	});

	test('keeps noble when the native module disagrees with noble', () => {
		const native = fakeNative();
		const broken: NativeAesGcmModule = {
			open: native.open,
			seal: (key, nonce, plaintext) => {
				const sealed = new Uint8Array(native.seal(key, nonce, plaintext));
				sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0x01;
				return sealed.buffer;
			},
		};
		expect(installNativeAesGcm(broken)).toEqual({ backend: 'noble', reason: 'self-check-failed', detail: 'seal differs from noble' });
		expect(getAesGcmBackend()).toBe(nobleAesGcm);

		const throwing: NativeAesGcmModule = { open: native.open, seal: () => { throw fakeNativeError('module crashed'); } };
		expect(installNativeAesGcm(throwing)).toEqual({ backend: 'noble', reason: 'self-check-failed', detail: 'threw: module crashed' });

		// タグが合わなくても throw しない実装
		const accepting: NativeAesGcmModule = {
			seal: native.seal,
			open: (key, sealed) => {
				try {
					return native.open(key, sealed);
				} catch {
					return new ArrayBuffer(0);
				}
			},
		};
		expect(checkAgainstNoble(createNativeAesGcmBackend(accepting))).toBe('open accepted a tampered tag');
	});

	test('keeps noble when the native module ignores the byteOffset of its input', () => {
		const native = fakeNative();
		// view の byteOffset を無視して、元の ArrayBuffer の先頭から読む実装
		const fromStart = (bytes: Uint8Array) => new Uint8Array(bytes.buffer, 0, bytes.length);
		const ignoresOffsetOnOpen: NativeAesGcmModule = { seal: native.seal, open: (key, sealed) => native.open(key, fromStart(sealed)) };
		expect(checkAgainstNoble(createNativeAesGcmBackend(ignoresOffsetOnOpen))).toBe('threw: Unsupported state or unable to authenticate data');
		const ignoresOffsetOnSeal: NativeAesGcmModule = { open: native.open, seal: (key, nonce, plaintext) => native.seal(key, nonce, fromStart(plaintext)) };
		expect(installNativeAesGcm(ignoresOffsetOnSeal)).toEqual({ backend: 'noble', reason: 'self-check-failed', detail: 'seal of an offset view differs from noble' });
		expect(withOffset(Uint8Array.of(1, 2, 3))).toEqual(Uint8Array.of(1, 2, 3));
		expect(withOffset(Uint8Array.of(1)).byteOffset).toBe(5);
	});

	test('a failed native open does not advance the receive counter and surfaces a plain Error', () => {
		const { mobileChannel, pcChannel } = establish();
		const p1 = pcChannel.seal(enc('first'));
		const p2 = pcChannel.seal(enc('second'));
		const native = fakeNative();
		const thrown = fakeNativeError('AES-GCM authentication failed: authenticationFailure');
		// 登録時の自己検査は通し、登録後のチャネルの最初の開封だけ失敗させる
		let failNext = false;
		expect(installNativeAesGcm({
			seal: native.seal,
			open: (key, sealed) => {
				if (failNext) {
					failNext = false;
					throw thrown;
				}
				return native.open(key, sealed);
			},
		})).toEqual({ backend: 'native' });
		failNext = true;

		let error: unknown;
		try {
			mobileChannel.open(p1);
		} catch (e) {
			error = e;
		}
		expect(error instanceof Error && Object.getPrototypeOf(error) === Error.prototype).toBe(true);
		expect((error as Error).message).toBe('aes/gcm (native): AES-GCM authentication failed: authenticationFailure');
		expect((error as Error).cause).toBe(thrown);

		expect(dec(mobileChannel.open(p1))).toBe('first');
		expect(dec(mobileChannel.open(p2))).toBe('second');
	});
});

describe('aesGcmSelfTest', () => {
	test('reports agreement with noble and the known-answer vector', () => {
		let clock = 0;
		const result = runAesGcmSelfTest(fakeNative(), { totalBytes: 100_000, chunkBytes: 30_000, now: () => clock++ });
		expect({ ok: result.ok, kat: result.kat, tamperRejected: result.tamperRejected, chunks: result.timing?.chunks, matches: result.timing?.plaintextMatches }).toEqual({
			ok: true, kat: true, tamperRejected: true, chunks: 4, matches: true,
		});
		expect(result.vectors?.map(v => v.size)[0]).toBe(0);
		expect(result.vectors?.every(v => v.sealMatches && v.nativeOpensNoble && v.nobleOpensNative && v.offsetViewMatches)).toBe(true);
	});

	test('reports a missing native module', () => {
		expect(runAesGcmSelfTest(null)).toEqual({ activeBackend: 'noble', nativeAvailable: false, ok: false });
	});
});
