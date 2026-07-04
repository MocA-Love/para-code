// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { createInitiator, generateIdentity, respondHandshake } from '../src/crypto.js';

const text = (s: string) => new TextEncoder().encode(s);

function establish() {
	const mobile = generateIdentity();
	const pc = generateIdentity();
	const initiator = createInitiator(mobile, pc.publicKey);
	const responder = respondHandshake(pc, mobile.publicKey, initiator.hello);
	const { channel: mobileChannel, confirm } = initiator.finish(responder.response);
	responder.verifyConfirm(confirm);
	return { mobileChannel, pcChannel: responder.channel };
}

describe('handshake + secure channel', () => {
	test('roundtrip both directions', () => {
		const { mobileChannel, pcChannel } = establish();

		const m1 = mobileChannel.seal(text('hello from mobile'));
		expect(new TextDecoder().decode(pcChannel.open(m1))).toBe('hello from mobile');

		const p1 = pcChannel.seal(text('hello from pc'));
		expect(new TextDecoder().decode(mobileChannel.open(p1))).toBe('hello from pc');

		// 連続送信（カウンタが進む）
		for (let i = 0; i < 10; i++) {
			const sealed = mobileChannel.seal(text(`msg ${i}`));
			expect(new TextDecoder().decode(pcChannel.open(sealed))).toBe(`msg ${i}`);
		}
	});

	test('tampered ciphertext is rejected', () => {
		const { mobileChannel, pcChannel } = establish();
		const sealed = mobileChannel.seal(text('important'));
		sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0x01;
		expect(() => pcChannel.open(sealed)).toThrow();
	});

	test('replayed message is rejected', () => {
		const { mobileChannel, pcChannel } = establish();
		const sealed = mobileChannel.seal(text('once'));
		pcChannel.open(sealed);
		expect(() => pcChannel.open(sealed)).toThrow(/nonce/);
	});

	test('impostor without pc static key cannot complete handshake', () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const impostor = generateIdentity(); // リレー侵害者を想定: pcの公開鍵は知っているが秘密鍵は持たない

		const initiator = createInitiator(mobile, pc.publicKey);
		// 攻撃者が自分の鍵でレスポンダを演じる
		const fakeResponder = respondHandshake(impostor, mobile.publicKey, initiator.hello);
		expect(() => initiator.finish(fakeResponder.response)).toThrow();
	});

	test('impostor without mobile static key is detected by confirm', () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const impostor = generateIdentity();

		// 攻撃者がモバイルを演じてPCに接続を試みる
		const initiator = createInitiator(impostor, pc.publicKey);
		const responder = respondHandshake(pc, mobile.publicKey, initiator.hello);
		// PC側は登録済みモバイル(mobile.publicKey)向けの鍵を導出するため、攻撃者はackを開けない
		expect(() => initiator.finish(responder.response)).toThrow();
	});
});
