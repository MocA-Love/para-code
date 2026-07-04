// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * @noble実装(モバイル/リレー) と webcrypto参照実装(PC側src/vsへ移植) のバイト互換を検証する。
 * これが通る限り、PC側(Node webcrypto)とモバイル側(@noble)は同じE2Eチャネルで通信できる。
 */

import { describe, expect, test } from 'vitest';
import { createInitiator, generateIdentity, respondHandshake } from '../src/crypto.js';
import { generateWebIdentity, webInitiate, webRespond } from './webcryptoRef.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('noble <-> webcrypto interop', () => {
	test('noble initiator (mobile) <-> webcrypto responder (PC)', async () => {
		const mobile = generateIdentity();          // noble
		const pc = await generateWebIdentity();      // webcrypto

		const initiator = createInitiator(mobile, pc.publicKey);
		const responder = await webRespond(pc, mobile.publicKey, initiator.hello);
		const { channel: mobileCh, confirm } = initiator.finish(responder.response);
		await responder.verifyConfirm(confirm);

		// mobile(noble) が封緘 → PC(webcrypto) が開封
		const sealed = mobileCh.seal(enc('terminal keystroke'));
		expect(dec(await responder.channel.open(sealed))).toBe('terminal keystroke');

		// PC(webcrypto) が封緘 → mobile(noble) が開封
		const back = await responder.channel.seal(enc('pty output'));
		expect(dec(mobileCh.open(back))).toBe('pty output');
	});

	test('webcrypto initiator (PC) <-> noble responder (relay-side)', async () => {
		const initiatorStatic = await generateWebIdentity();
		const responderStatic = generateIdentity();

		const initiator = await webInitiate(initiatorStatic, responderStatic.publicKey);
		const responder = respondHandshake(responderStatic, initiatorStatic.publicKey, initiator.hello);
		const { channel: initCh, confirm } = await initiator.finish(responder.response);
		responder.verifyConfirm(confirm);

		const sealed = await initCh.seal(enc('ping'));
		expect(dec(responder.channel.open(sealed))).toBe('ping');

		const back = responder.channel.seal(enc('pong'));
		expect(dec(await initCh.open(back))).toBe('pong');
	});

	test('impostor webcrypto responder without pc static key fails against noble initiator', async () => {
		const mobile = generateIdentity();
		const pc = await generateWebIdentity();
		const impostor = await generateWebIdentity();

		const initiator = createInitiator(mobile, pc.publicKey);
		const fake = await webRespond(impostor, mobile.publicKey, initiator.hello);
		expect(() => initiator.finish(fake.response)).toThrow();
	});
});
