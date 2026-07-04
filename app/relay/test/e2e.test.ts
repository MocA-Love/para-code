// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * フルE2E統合テスト: モバイルクライアント(app/mobile) ↔ 実リレー(miniflare/DeviceDO) ↔
 * PCハーネス(@para/protocol responder = src/vs 実装のNode版相当)。
 *
 * これが通ることで「ペアリング(SAS) → 資格情報発行 → データ接続ハンドシェイク → 双方向フレーム中継」
 * の全経路が、実際のWebSocketリレーを介して成立することを保証する。src/vs 側のPCコードは
 * webcrypto版だが app/protocol とワイヤ互換(interop.test.ts)なので、この経路の正しさが担保される。
 */

import { SELF } from 'cloudflare:test';
import {
	Channels,
	FrameMux,
	type Frame,
	type Identity,
	type PairingPayload,
	createInitiator,
	decodeRelayControl,
	deriveSasCode,
	encodeRelayControl,
	fromBase64Url,
	generateIdentity,
	respondHandshake,
	toBase64Url,
} from '@para/protocol';
import { PairingClient } from '../../mobile/src/pairingClient.js';
import { RelayClient, type PairedCredentials, type SocketLike } from '../../mobile/src/relayClient.js';
import { afterEach, describe, expect, it } from 'vitest';

const openSockets: WebSocket[] = [];
afterEach(() => { for (const ws of openSockets.splice(0)) { try { ws.close(); } catch { /* ignore */ } } });

/** miniflare の WebSocket を SocketLike に適合させる（accept後に onopen を発火）。 */
function socketFactory(url: string): SocketLike {
	// SELF.fetch は Promise。SocketLike は同期生成を期待するので、接続確立を内部で橋渡しする。
	const listeners: Partial<Record<'open' | 'close' | 'error' | 'message', ((arg?: unknown) => void)>> = {};
	let realWs: WebSocket | undefined;
	const like: SocketLike = {
		binaryType: 'arraybuffer',
		send(data) { realWs?.send(data as ArrayBuffer); },
		close() { try { realWs?.close(); } catch { /* ignore */ } },
		onopen: null, onclose: null, onerror: null, onmessage: null,
	};
	void listeners;
	SELF.fetch(url, { headers: { Upgrade: 'websocket' } }).then(res => {
		if (res.status !== 101 || !res.webSocket) {
			like.onerror?.(new Error(`ws failed: ${res.status}`));
			return;
		}
		const ws = res.webSocket;
		ws.accept();
		realWs = ws;
		openSockets.push(ws);
		ws.addEventListener('message', ev => like.onmessage?.({ data: ev.data as string | ArrayBuffer }));
		ws.addEventListener('close', () => like.onclose?.());
		ws.addEventListener('error', () => like.onerror?.(new Error('ws error')));
		// 既に接続済み。次tickで onopen を発火。
		queueMicrotask(() => like.onopen?.());
	});
	return like;
}

async function openRaw(url: string): Promise<WebSocket> {
	const res = await SELF.fetch(url, { headers: { Upgrade: 'websocket' } });
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	openSockets.push(ws);
	return ws;
}

/**
 * PCハーネス: role=pc ソケットを保持し、ペアリング承認とデータ接続の responder を担う。
 * src/vs/paradis/contrib/mobileRelay/node/paradisMobileRelayService.ts のNode版相当。
 */
class PcHarness {
	private readonly mobilePubKeys = new Map<string, Uint8Array>();
	private pendingMobilePub: Uint8Array | undefined;
	private readonly sessions = new Map<string, { channel?: Awaited<ReturnType<typeof respondHandshake>>['channel']; verify?: (c: Uint8Array) => void; mux?: FrameMux; confirmed: boolean }>();
	readonly inbound: Frame[] = [];

	constructor(private readonly ws: WebSocket, private readonly pcIdentity: Identity, private readonly pairingToken: Uint8Array, private readonly pairId: string) {
		ws.addEventListener('message', ev => { void this.onMessage(ev.data as string | ArrayBuffer); });
	}

	private async onMessage(data: string | ArrayBuffer): Promise<void> {
		if (typeof data === 'string') {
			const msg = decodeRelayControl(data);
			if (msg.type === 'pairing-msg') {
				const inner = JSON.parse(new TextDecoder().decode(fromBase64Url(msg.data))) as { pub: string };
				this.pendingMobilePub = fromBase64Url(inner.pub);
				// SASを算出（モバイルと一致するはず。テストでは一致確認は呼び出し側で行う）。
				this.lastSas = deriveSasCode(this.pcIdentity, this.pendingMobilePub, this.pairingToken);
				this.ws.send(encodeRelayControl({ type: 'pairing-approve', pairId: msg.pairId ?? this.pairId, name: 'iPhone' }));
			} else if (msg.type === 'paired') {
				if (this.pendingMobilePub) {
					this.mobilePubKeys.set(msg.mobileId, this.pendingMobilePub);
					this.pendingMobilePub = undefined;
				}
			}
			return;
		}
		// バイナリ: [ver][mobileId][payload]
		const bytes = new Uint8Array(data);
		const mobileId = toBase64Url(bytes.subarray(1, 17));
		const payload = bytes.subarray(17);
		let session = this.sessions.get(mobileId);
		if (!session) {
			session = { confirmed: false };
			this.sessions.set(mobileId, session);
		}
		const pub = this.mobilePubKeys.get(mobileId);
		if (!pub) { return; }
		if (!session.channel) {
			const responder = await respondHandshake(this.pcIdentity, pub, payload);
			session.channel = responder.channel;
			session.verify = responder.verifyConfirm;
			this.sendToMobile(mobileId, responder.response);
		} else if (!session.confirmed) {
			session.verify!(payload);
			session.confirmed = true;
			session.mux = new FrameMux(session.channel, { sendSealed: s => this.sendToMobile(mobileId, s) });
			session.mux.on(Channels.State, f => this.inbound.push(f));
			session.mux.on(Channels.Terminal, f => this.inbound.push(f));
		} else {
			session.mux!.receive(payload);
		}
	}

	lastSas = '';

	private sendToMobile(mobileId: string, sealed: Uint8Array): void {
		const idBytes = fromBase64Url(mobileId);
		const framed = new Uint8Array(1 + 16 + sealed.length);
		framed[0] = 0x01;
		framed.set(idBytes, 1);
		framed.set(sealed, 17);
		this.ws.send(framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer);
	}

	/** PC側セッションが確立し mux が使えるか（モバイルのconfirm受信済みか）。 */
	isReady(mobileId: string): boolean {
		return this.sessions.get(mobileId)?.confirmed === true;
	}

	sendFrame(mobileId: string, ch: typeof Channels[keyof typeof Channels], payload: Uint8Array): void {
		this.sessions.get(mobileId)?.mux?.send(ch, payload);
	}
}

describe('full E2E: mobile <-> relay <-> PC', () => {
	// 実WebSocket(miniflare)+ポーリングを跨ぐ統合テストのため、CI負荷時の遅延を吸収する余裕を持たせる。
	it('pairs with SAS then exchanges data frames end to end', { timeout: 30_000 }, async () => {
		// 1. PC provision
		const pcIdentity = generateIdentity();
		const pcToken = 'pc-' + toBase64Url(generateIdentity().publicKey).slice(0, 20);
		const prov = await SELF.fetch('https://relay/device/new/provision', {
			method: 'POST',
			body: JSON.stringify({ pcPublicKey: toBase64Url(pcIdentity.publicKey), pcToken }),
		});
		const { deviceId } = await prov.json<{ deviceId: string }>();

		// 2. PC socket + harness
		const pcWs = await openRaw(`https://relay/device/${deviceId}/ws?role=pc&token=${pcToken}`);

		// 3. begin pairing（pcToken認証）
		const pairRes = await (await SELF.fetch(`https://relay/device/${deviceId}/pair/begin`, { method: 'POST', headers: { authorization: `Bearer ${pcToken}` } })).json<{ pairId: string; pairingToken: string }>();
		const pairingToken = fromBase64Url(pairRes.pairingToken);
		const harness = new PcHarness(pcWs, pcIdentity, pairingToken, pairRes.pairId);

		const payload: PairingPayload = {
			version: 1,
			relayUrl: 'https://relay',
			deviceId,
			pairId: pairRes.pairId,
			pairingToken,
			pcPublicKey: pcIdentity.publicKey,
		};

		// 4. mobile pairs
		const mobileIdentity = generateIdentity();
		let mobileSas = '';
		const pairing = new PairingClient(mobileIdentity, 'iPhone 15', socketFactory);
		const creds: PairedCredentials = await pairing.pair(payload, { onSasCode: c => { mobileSas = c; } });

		// SASが両側で一致
		expect(mobileSas).toMatch(/^\d{6}$/);
		expect(harness.lastSas).toBe(mobileSas);

		// 5. mobile data connection
		const received: Frame[] = [];
		const errors: unknown[] = [];
		const client = new RelayClient(mobileIdentity, creds, socketFactory, { onFrame: f => received.push(f), onError: e => errors.push(e) });
		client.connect();

		// 接続確立を待つ（モバイルのonline かつ PC側セッション(mux)確立の両方を待つ。
		// モバイルはconfirm送信で即onlineになるが、PCがそのconfirmを処理してmuxを張るのは
		// 僅かに後になるため、両方揃うまで待たないとPC→mobileフレームが取りこぼされる）。
		try {
			await waitFor(() => client.connectionState === 'online' && harness.isReady(creds.mobileId), 10000);
		} catch (e) {
			throw new Error(`not ready. state=${client.connectionState} pcReady=${harness.isReady(creds.mobileId)} errors=${JSON.stringify(errors.map(String))}`);
		}

		// 6. PC → mobile: state フレーム
		harness.sendFrame(creds.mobileId, Channels.State, new TextEncoder().encode('{"ok":true}'));
		await waitFor(() => received.length >= 1, 10000);
		expect(received[0]!.ch).toBe('state');
		expect(new TextDecoder().decode(received[0]!.payload)).toBe('{"ok":true}');

		// 7. mobile → PC: term フレーム
		client.send(Channels.Terminal, new TextEncoder().encode('whoami\n'), 'para-code');
		await waitFor(() => harness.inbound.some(f => f.ch === 'term'), 10000);
		const term = harness.inbound.find(f => f.ch === 'term')!;
		expect(new TextDecoder().decode(term.payload)).toBe('whoami\n');
		expect(term.ws).toBe('para-code');
	});
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor timeout');
		}
		await new Promise(r => setTimeout(r, 10));
	}
}
