// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * APNsプッシュ経路のテスト:
 *  - register-push の保存とトークンバリデーション
 *  - push-notify のオフライン判定分岐（オンラインなら送らない）
 *  - APNs fetch のモックによるヘッダ/ボディ形状の検証と JWTキャッシュ再利用
 *  - 410 Unregistered でのトークン削除
 *
 * APNsシークレットは vitest.config.ts の miniflare.bindings に使い捨てP-256鍵で注入している。
 */

import { SELF } from 'cloudflare:test';
import { decodeRelayControl, encodeRelayControl, generateIdentity, toBase64Url } from '@para/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

class BufferedSocket {
	readonly ws: WebSocket;
	private readonly queue: (string | ArrayBuffer)[] = [];
	private waiter: ((v: string | ArrayBuffer) => void) | null = null;

	constructor(ws: WebSocket) {
		this.ws = ws;
		ws.addEventListener('message', event => {
			const data = event.data as string | ArrayBuffer;
			if (this.waiter) {
				const w = this.waiter;
				this.waiter = null;
				w(data);
			} else {
				this.queue.push(data);
			}
		});
	}

	next(timeoutMs = 2000): Promise<string | ArrayBuffer> {
		const queued = this.queue.shift();
		if (queued !== undefined) {
			return Promise.resolve(queued);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.waiter = null; reject(new Error('ws message timeout')); }, timeoutMs);
			this.waiter = v => { clearTimeout(timer); resolve(v); };
		});
	}

	/** 指定typeの制御メッセージが来るまで読み飛ばす。 */
	async nextControlOfType(type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const data = await this.next(Math.max(1, deadline - Date.now()));
			if (typeof data === 'string') {
				const msg = decodeRelayControl(data) as unknown as Record<string, unknown>;
				if (msg.type === type) {
					return msg;
				}
			}
		}
	}

	send(data: string): void {
		this.ws.send(data);
	}

	close(): void {
		try { this.ws.close(); } catch { /* ignore */ }
	}
}

const openSockets: BufferedSocket[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const s of openSockets.splice(0)) {
		s.close();
	}
});

async function openWs(url: string): Promise<BufferedSocket> {
	const res = await SELF.fetch(url, { headers: { Upgrade: 'websocket' } });
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	const buffered = new BufferedSocket(ws);
	openSockets.push(buffered);
	return buffered;
}

async function provisionDevice(): Promise<{ deviceId: string; pcToken: string }> {
	const pc = generateIdentity();
	const pcToken = 'pc-token-' + Math.random().toString(36).slice(2);
	const res = await SELF.fetch('https://relay/device/new/provision', {
		method: 'POST',
		body: JSON.stringify({ pcPublicKey: toBase64Url(pc.publicKey), pcToken }),
	});
	expect(res.ok).toBe(true);
	const body = await res.json<{ deviceId: string }>();
	return { deviceId: body.deviceId, pcToken };
}

/** provision → pcソケット → ペアリング承認まで通し、モバイル資格情報を得る。 */
async function pairMobile(): Promise<{ deviceId: string; pcToken: string; pcWs: BufferedSocket; mobileId: string; mobileToken: string }> {
	const { deviceId, pcToken } = await provisionDevice();
	const pcWs = await openWs(`https://relay/device/${deviceId}/ws?role=pc&token=${pcToken}`);
	const pair = await (await SELF.fetch(`https://relay/device/${deviceId}/pair/begin`, { method: 'POST', headers: { authorization: `Bearer ${pcToken}` } })).json<{ pairId: string; pairingToken: string }>();
	const pairWs = await openWs(`https://relay/device/${deviceId}/ws?role=pair&pairId=${pair.pairId}&token=${pair.pairingToken}`);

	pairWs.send(encodeRelayControl({ type: 'pairing-msg', data: 'aGVsbG8' }));
	await pcWs.nextControlOfType('pairing-msg');
	pcWs.send(encodeRelayControl({ type: 'pairing-approve', pairId: pair.pairId, name: 'iPhone' }));
	const paired = await pairWs.nextControlOfType('paired');
	pairWs.close();
	return { deviceId, pcToken, pcWs, mobileId: paired.mobileId as string, mobileToken: paired.mobileToken as string };
}

/** モバイルを接続し、presence交換を消費して返す。 */
async function connectMobile(deviceId: string, mobileId: string, mobileToken: string, pcWs: BufferedSocket): Promise<BufferedSocket> {
	const mobileWs = await openWs(`https://relay/device/${deviceId}/ws?role=mobile&mobileId=${mobileId}&token=${mobileToken}`);
	await pcWs.nextControlOfType('presence'); // PC: mobile online
	await mobileWs.nextControlOfType('presence'); // mobile: pc presence
	return mobileWs;
}

const VALID_APNS_TOKEN = 'a'.repeat(64);

function stubFetch(status = 200): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status }));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor timeout');
		}
		await new Promise(r => setTimeout(r, 5));
	}
}

describe('relay APNs push', () => {
	it('sends an APNs request when the target mobile is offline (headers + body shape)', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN, env: 'dev' }));

		// オフライン化: モバイルを閉じ、PCがpresence(offline)を受けるまで待つ（server側close処理の完了）。
		mobileWs.close();
		await pcWs.nextControlOfType('presence');

		const fetchMock = stubFetch(200);
		const payload = toBase64Url(new TextEncoder().encode('ciphertext-blob'));
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload }));
		await waitFor(() => fetchMock.mock.calls.length >= 1);

		const [urlArg, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(urlArg).toBe(`https://api.sandbox.push.apple.com/3/device/${VALID_APNS_TOKEN}`);
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toMatch(/^bearer eyJ/);
		expect(headers['apns-topic']).toBe('ltd.paradis.paracode.mobile');
		expect(headers['apns-push-type']).toBe('alert');
		expect(headers['apns-priority']).toBe('10');
		expect(Number(headers['apns-expiration'])).toBeGreaterThan(Math.floor(Date.now() / 1000));
		const body = JSON.parse(init.body as string) as { aps: Record<string, unknown>; e: string };
		expect(body.e).toBe(payload);
		expect(body.aps['mutable-content']).toBe(1);
	});

	it('does not send when the mobile is online', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN }));
		// register-pushが処理されるまで少し待つ（順序保証のため小休止）。
		await new Promise(r => setTimeout(r, 50));

		const fetchMock = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await new Promise(r => setTimeout(r, 150));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects an invalid apns token (no push is sent)', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: 'not-a-valid-hex-token' }));
		mobileWs.close();
		await pcWs.nextControlOfType('presence');

		const fetchMock = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await new Promise(r => setTimeout(r, 150));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reuses the cached JWT across pushes', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN }));
		mobileWs.close();
		await pcWs.nextControlOfType('presence');

		const fetchMock = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => fetchMock.mock.calls.length >= 1);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'BBBB' }));
		await waitFor(() => fetchMock.mock.calls.length >= 2);

		const auth1 = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
		const auth2 = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
		expect(auth1.authorization).toBe(auth2.authorization);
	});

	it('drops the apns token on 410 Unregistered', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN }));
		mobileWs.close();
		await pcWs.nextControlOfType('presence');

		const gone = stubFetch(410);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => gone.mock.calls.length >= 1);
		vi.restoreAllMocks();

		// トークンは削除されたはず: 次の push-notify では fetch されない。
		const after = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'BBBB' }));
		await new Promise(r => setTimeout(r, 150));
		expect(after).not.toHaveBeenCalled();
	});
});
