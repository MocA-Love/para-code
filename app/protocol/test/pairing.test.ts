// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { generateIdentity, randomToken } from '../src/crypto.js';
import { decodePairingUri, deriveSasCode, encodePairingUri } from '../src/pairing.js';

describe('pairing payload', () => {
	test('QR URI roundtrip', () => {
		const pc = generateIdentity();
		const payload = {
			version: 1 as const,
			relayUrl: 'wss://relay.paradis.ltd',
			deviceId: 'dev_abc123',
			pairId: 'pair_xyz',
			pairingToken: randomToken(16),
			pcPublicKey: pc.publicKey,
		};
		const uri = encodePairingUri(payload);
		expect(uri.startsWith('paracode-mobile://pair?d=')).toBe(true);

		const decoded = decodePairingUri(uri);
		expect(decoded.relayUrl).toBe(payload.relayUrl);
		expect(decoded.deviceId).toBe(payload.deviceId);
		expect(decoded.pairId).toBe(payload.pairId);
		expect(Array.from(decoded.pairingToken)).toEqual(Array.from(payload.pairingToken));
		expect(Array.from(decoded.pcPublicKey)).toEqual(Array.from(pc.publicKey));
	});

	test('carries the PC name when the PC sends one, and stays readable when it does not', () => {
		const pc = generateIdentity();
		const base = {
			version: 1 as const,
			relayUrl: 'wss://relay.paradis.ltd',
			deviceId: 'dev_abc123',
			pairId: 'pair_xyz',
			pairingToken: randomToken(16),
			pcPublicKey: pc.publicKey,
		};
		// 名前を送ってくるPC（複数台とペアリングしたときの見分けに使う）。
		expect(decodePairingUri(encodePairingUri({ ...base, pcName: '  MacBook Pro  ' })).pcName).toBe('MacBook Pro');
		// 名前を送らない旧PCのURIも読めること（フィールドごと無いだけ）。
		expect(decodePairingUri(encodePairingUri(base)).pcName).toBeUndefined();
		// 長すぎる名前はQRを膨らませないよう切り詰める。
		expect(decodePairingUri(encodePairingUri({ ...base, pcName: 'x'.repeat(200) })).pcName?.length).toBe(64);
	});

	test('rejects non-pairing URIs', () => {
		expect(() => decodePairingUri('https://example.com')).toThrow();
		expect(() => decodePairingUri('paracode-mobile://pair?d=!!!')).toThrow();
	});
});

describe('SAS code', () => {
	test('both sides derive the same 6-digit code', () => {
		const pc = generateIdentity();
		const mobile = generateIdentity();
		const token = randomToken(16);

		const sasOnPc = deriveSasCode(pc, mobile.publicKey, token);
		const sasOnMobile = deriveSasCode(mobile, pc.publicKey, token);

		expect(sasOnPc).toBe(sasOnMobile);
		expect(sasOnPc).toMatch(/^\d{6}$/);
	});

	test('MITM (different keys on each side) yields different codes', () => {
		const pc = generateIdentity();
		const mobile = generateIdentity();
		const mitm = generateIdentity();
		const token = randomToken(16);

		// リレーが中間者として両側に自分の鍵を提示した場合
		const sasOnPc = deriveSasCode(pc, mitm.publicKey, token);
		const sasOnMobile = deriveSasCode(mobile, mitm.publicKey, token);

		// 1/1,000,000で偶然一致し得るが、実質的に不一致になることの確認
		expect(sasOnPc).not.toBe(sasOnMobile);
	});
});
