// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PairingClient がソケットの失敗を、利用者向けの文に変えられる形で返すこと。
 */

import { generateIdentity, type PairingPayload } from '@para/protocol';
import { describe, expect, it } from 'vitest';
import { pairingErrorMessage } from './features/pairing/pairingInput.js';
import { PairingClient } from './pairingClient.js';
import type { SocketLike } from './relayClient.js';

class FakeSocket implements SocketLike {
	onopen: (() => void) | null = null;
	onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;
	onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
	binaryType = 'arraybuffer';

	send(): void { }

	close(): void {
		this.onclose?.({ code: 0 });
	}
}

const timers = { setTimeout: () => 0, clearTimeout: () => { } };

describe('PairingClient', () => {
	it('中継サーバーへの接続エラー（RN はイベントのオブジェクトを渡す）を「つながりませんでした」の文にする', async () => {
		const socket = new FakeSocket();
		const client = new PairingClient(generateIdentity(), 'phone', () => socket, timers);
		const payload: PairingPayload = {
			version: 1,
			relayUrl: 'wss://relay.example',
			deviceId: 'pc-1',
			pairId: 'pair-1',
			pairingToken: new Uint8Array(32),
			pcPublicKey: generateIdentity().publicKey,
		};
		const pairing = client.pair(payload);
		socket.onerror?.({ type: 'error', message: 'The operation could not be completed.' });
		const error = await pairing.catch((reason: unknown) => reason);
		expect(pairingErrorMessage(error)).toBe('中継サーバーにつながりませんでした。通信状態を確かめて、もう一度読み取ってください。');
	});
});
