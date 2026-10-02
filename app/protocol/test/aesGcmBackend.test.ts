// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * AES-GCM の実装の差し替え（`setAesGcmBackend`）を確かめる。モバイルのネイティブ（CryptoKit）の代役として、
 * node の `createCipheriv` / `createDecipheriv`（同期・OpenSSL）を登録する。
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { createInitiator, generateIdentity, getAesGcmBackend, nobleAesGcm, respondHandshake, setAesGcmBackend, type AesGcmBackend } from '../src/crypto.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** node の OpenSSL で同じ形（nonce(12) || 暗号文 || タグ(16)）を作る代役。呼ばれた回数を数える。 */
function nodeBackend(): AesGcmBackend & { opens: number; seals: number } {
	const backend = {
		name: 'node',
		opens: 0,
		seals: 0,
		open(key: Uint8Array, sealed: Uint8Array): Uint8Array {
			backend.opens++;
			const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
			decipher.setAuthTag(sealed.subarray(sealed.length - 16));
			const head = decipher.update(sealed.subarray(12, sealed.length - 16));
			const tail = decipher.final(); // タグが合わなければここで throw（node の例外は素の Error）
			return new Uint8Array(Buffer.concat([head, tail]));
		},
		seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
			backend.seals++;
			const cipher = createCipheriv('aes-256-gcm', key, nonce);
			return new Uint8Array(Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
		},
	};
	return backend;
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

describe('AES-GCM backend', () => {
	test('defaults to noble and undefined restores it', () => {
		expect(getAesGcmBackend()).toBe(nobleAesGcm);
		setAesGcmBackend(nodeBackend());
		expect(getAesGcmBackend().name).toBe('node');
		setAesGcmBackend(undefined);
		expect(getAesGcmBackend()).toBe(nobleAesGcm);
	});

	test('noble and a registered backend produce identical bytes and interoperate', () => {
		const key = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
		const nonce = Uint8Array.from({ length: 12 }, (_, i) => i === 7 ? 5 : 0);
		const native = nodeBackend();
		for (const size of [0, 1, 15, 16, 17, 4096, 700 * 1024]) {
			const plaintext = Uint8Array.from({ length: size }, (_, i) => (i * 31 + size) & 0xff);
			const fromNoble = nobleAesGcm.seal(key, nonce, plaintext);
			const fromNative = native.seal(key, nonce, plaintext);
			expect(fromNative).toEqual(fromNoble);
			expect(native.open(key, fromNoble)).toEqual(plaintext);
			expect(nobleAesGcm.open(key, fromNative)).toEqual(plaintext);
		}
	});

	test('a registered backend is used by established channels', () => {
		const { mobileChannel, pcChannel } = establish();
		const native = nodeBackend();

		// PC（noble で封緘した側）→ モバイル（登録した実装で開く）
		const fromPc = pcChannel.seal(enc('hello from pc'));
		setAesGcmBackend(native);
		expect(dec(mobileChannel.open(fromPc))).toBe('hello from pc');
		expect(native.opens).toBe(1);

		// モバイル（登録した実装で封緘）→ PC（noble で開く）
		const fromMobile = mobileChannel.seal(enc('hello from mobile'));
		expect(native.seals).toBe(1);
		setAesGcmBackend(undefined);
		expect(dec(pcChannel.open(fromMobile))).toBe('hello from mobile');
	});

	test('a failed open does not advance the receive counter and keeps a plain Error', () => {
		const { mobileChannel, pcChannel } = establish();
		const p1 = pcChannel.seal(enc('first'));
		const p2 = pcChannel.seal(enc('second'));
		setAesGcmBackend(nodeBackend());

		const tampered = Uint8Array.from(p1);
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
		const error = captureError(() => mobileChannel.open(tampered));
		expect({ proto: Object.getPrototypeOf(error) === Error.prototype, prefixed: error.message.startsWith('aes/gcm (node): '), hasCause: error.cause instanceof Error }).toEqual({
			proto: true, prefixed: true, hasCause: true,
		});

		// カウンタが進んでいなければ、正しい p1・p2 は順に開ける
		expect(dec(mobileChannel.open(p1))).toBe('first');
		expect(dec(mobileChannel.open(p2))).toBe('second');
	});

	test('a native-shaped error (plain Error with code) is rethrown as a plain Error with the original as cause', () => {
		const { mobileChannel, pcChannel } = establish();
		const p1 = pcChannel.seal(enc('first'));
		const thrown = fakeNativeError('authenticationFailure');
		let failNext = true;
		setAesGcmBackend({
			name: 'fake-native',
			open: (key, sealed) => {
				if (failNext) {
					failNext = false;
					throw thrown;
				}
				return nobleAesGcm.open(key, sealed);
			},
			seal: nobleAesGcm.seal,
		});

		const error = captureError(() => mobileChannel.open(p1));
		expect({ proto: Object.getPrototypeOf(error) === Error.prototype, message: error.message, cause: error.cause }).toEqual({
			proto: true,
			message: 'aes/gcm (fake-native): authenticationFailure',
			cause: thrown,
		});
		expect(dec(mobileChannel.open(p1))).toBe('first');
	});

	test('noble errors are thrown unchanged', () => {
		const { mobileChannel, pcChannel } = establish();
		const tampered = Uint8Array.from(pcChannel.seal(enc('x')));
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
		const error = captureError(() => mobileChannel.open(tampered));
		expect({ message: error.message, cause: error.cause }).toEqual({ message: 'aes/gcm: invalid ghash tag', cause: undefined });
	});

	test('a failed seal does not advance the send counter', () => {
		const { mobileChannel, pcChannel } = establish();
		setAesGcmBackend({
			name: 'broken',
			open: nobleAesGcm.open,
			seal: () => { throw fakeNativeError('seal failed'); },
		});
		expect(() => mobileChannel.seal(enc('lost'))).toThrow('aes/gcm (broken): seal failed');

		setAesGcmBackend(undefined);
		// 失敗した封緘で nonce を消費していなければ、次の封緘は相手の期待するカウンタ 1 番で届く
		expect(dec(pcChannel.open(mobileChannel.seal(enc('next'))))).toBe('next');
	});

	test('nonce checks stay in the channel regardless of the backend', () => {
		const { mobileChannel, pcChannel } = establish();
		const native = nodeBackend();
		setAesGcmBackend(native);
		const p1 = pcChannel.seal(enc('once'));
		mobileChannel.open(p1);
		expect(() => mobileChannel.open(p1)).toThrow(/nonce/);
		expect(native.opens).toBe(1);
	});
});

function captureError(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
		throw new Error(`non-Error thrown: ${String(error)}`);
	}
	throw new Error('expected an error');
}
