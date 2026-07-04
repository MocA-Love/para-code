// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { SELF } from 'cloudflare:test';
import { decodeRelayControl, encodeRelayControl, generateIdentity, mobileIdFromString, packPcData, toBase64Url, unpackPcData } from '@para/protocol';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * WebSocketを開通と同時に全受信メッセージをバッファするラッパ。
 * 「送信→受信待ち」のレース（リスナー登録前に到着）を避けるため、
 * open直後からキューに溜め、next()で取り出す。
 */
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

	send(data: string | ArrayBufferView): void {
		this.ws.send(data as string);
	}

	close(): void {
		try { this.ws.close(); } catch { /* ignore */ }
	}
}

const openSockets: BufferedSocket[] = [];

afterEach(() => {
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

describe('relay pairing + routing', () => {
	it('provisions a device and issues a pairing token (authenticated)', async () => {
		const { deviceId, pcToken } = await provisionDevice();
		const res = await SELF.fetch(`https://relay/device/${deviceId}/pair/begin`, { method: 'POST', headers: { authorization: `Bearer ${pcToken}` } });
		const body = await res.json<{ pairId: string; pairingToken: string }>();
		expect(body.pairId).toBeTruthy();
		expect(body.pairingToken).toBeTruthy();
	});

	it('rejects pair/begin without the pc token (C-1)', async () => {
		const { deviceId } = await provisionDevice();
		const res = await SELF.fetch(`https://relay/device/${deviceId}/pair/begin`, { method: 'POST' });
		expect(res.status).toBe(401);
		const res2 = await SELF.fetch(`https://relay/device/${deviceId}/pair/begin`, { method: 'POST', headers: { authorization: 'Bearer wrong' } });
		expect(res2.status).toBe(401);
	});

	it('routes pairing approval to mint mobile credentials', async () => {
		const { deviceId, pcToken } = await provisionDevice();
		const pcWs = await openWs(`https://relay/device/${deviceId}/ws?role=pc&token=${pcToken}`);

		const pair = await (await SELF.fetch(`https://relay/device/${deviceId}/pair/begin`, { method: 'POST', headers: { authorization: `Bearer ${pcToken}` } })).json<{ pairId: string; pairingToken: string }>();
		const pairWs = await openWs(`https://relay/device/${deviceId}/ws?role=pair&pairId=${pair.pairId}&token=${pair.pairingToken}`);

		// pairing socket → PC へ pairing-msg が中継される（pairId付き）
		pairWs.send(encodeRelayControl({ type: 'pairing-msg', data: 'aGVsbG8' }));
		const atPc = decodeRelayControl(await pcWs.next() as string);
		expect(atPc.type).toBe('pairing-msg');
		if (atPc.type !== 'pairing-msg') { throw new Error('unreachable'); }
		expect(atPc.pairId).toBe(pair.pairId);

		// PC が承認（pairId指定）→ pairing socket に paired が返る
		pcWs.send(encodeRelayControl({ type: 'pairing-approve', pairId: pair.pairId, name: 'iPhone' }));
		const paired = decodeRelayControl(await pairWs.next() as string);
		expect(paired.type).toBe('paired');
		if (paired.type !== 'paired') { throw new Error('unreachable'); }
		// PC にも mobileId 付きの paired が届く（相手鍵の紐付け用。mobileTokenは空）。
		const pcPaired = decodeRelayControl(await pcWs.next() as string);
		expect(pcPaired.type).toBe('paired');

		// 発行された資格情報でモバイルが接続でき、PC⇔モバイルでバイナリが双方向中継される
		const mobileWs = await openWs(`https://relay/device/${deviceId}/ws?role=mobile&mobileId=${paired.mobileId}&token=${paired.mobileToken}`);
		// 接続直後、PCにモバイルのpresenceが届く
		const presence = decodeRelayControl(await pcWs.next() as string);
		expect(presence.type).toBe('presence');
		// モバイル側も接続直後にPCのpresence(テキスト)を受け取る
		const pcPresence = decodeRelayControl(await mobileWs.next() as string);
		expect(pcPresence.type).toBe('presence');

		// モバイル→PC
		mobileWs.send(new Uint8Array([9, 8, 7]));
		const framed = new Uint8Array(await pcWs.next() as ArrayBuffer);
		const { payload } = unpackPcData(framed);
		expect(Array.from(payload)).toEqual([9, 8, 7]);

		// PC→モバイル（受け取ったmobileId宛に返す）
		pcWs.send(packPcData(mobileIdFromString(paired.mobileId), new Uint8Array([1, 2, 3])));
		const back = new Uint8Array(await mobileWs.next() as ArrayBuffer);
		expect(Array.from(back)).toEqual([1, 2, 3]);
	});

	it('rejects mobile connection with a bad token', async () => {
		const { deviceId } = await provisionDevice();
		const res = await SELF.fetch(`https://relay/device/${deviceId}/ws?role=mobile&mobileId=AAAAAAAAAAAAAAAAAAAAAA&token=wrong`, {
			headers: { Upgrade: 'websocket' },
		});
		expect(res.status).toBe(401);
	});

	it('rejects pc connection with a bad token', async () => {
		const { deviceId } = await provisionDevice();
		const res = await SELF.fetch(`https://relay/device/${deviceId}/ws?role=pc&token=nope`, {
			headers: { Upgrade: 'websocket' },
		});
		expect(res.status).toBe(401);
	});
});
