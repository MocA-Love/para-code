// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 再接続の間隔（W2-06）と、リレーが資格を拒んだときの振る舞い（W2-04）。
 * 間隔そのものの計算は relayRetryDelays.ts の純関数で固定し、ここでは RelayClient が
 * それをどう使うか（いつ回数を戻すか、拒否の間に何をしないか）を確かめる。
 */

import { PARADIS_RELAY_CLOSE_CODE, generateIdentity, respondHandshake, type Identity } from '@para/protocol';
import { describe, expect, it } from 'vitest';
import { RelayClient, type PairedCredentials, type SocketLike, type Timers } from './relayClient.js';
import { RELAY_STABLE_CONNECTION_MS, isRelayAuthRejection, relayAuthGateDelayMs, relayReconnectDelayMs } from './relayRetryDelays.js';

class FakeSocket implements SocketLike {
	onopen: (() => void) | null = null;
	onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;
	onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
	binaryType = 'arraybuffer';
	readonly sent: (string | ArrayBufferView | ArrayBuffer)[] = [];

	send(data: string | ArrayBufferView | ArrayBuffer): void {
		this.sent.push(data);
	}

	close(): void {
		this.onclose?.({ code: 0 });
	}

	/** リレー（サーバ）側から閉じられた。 */
	closeFromRelay(code: number): void {
		this.onclose?.({ code });
	}
}

/** 予約を溜め、待ち時間つきで見せる時計。 */
class RecordingTimers implements Timers {
	private next = 1;
	readonly pending = new Map<number, { handler: () => void; ms: number }>();

	setTimeout(handler: () => void, ms: number): unknown {
		const id = this.next++;
		this.pending.set(id, { handler, ms });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.pending.delete(handle as number);
	}

	/** 接続タイムアウト（12秒）以外の予約＝再接続の待ち時間。 */
	reconnectDelays(): number[] {
		return [...this.pending.values()].map(entry => entry.ms).filter(ms => ms !== 12_000);
	}

	runReconnect(): void {
		const entry = [...this.pending.entries()].find(([, value]) => value.ms !== 12_000);
		if (entry === undefined) {
			throw new Error('no reconnect scheduled');
		}
		this.pending.delete(entry[0]);
		entry[1].handler();
	}
}

function toArrayBuffer(data: string | ArrayBufferView | ArrayBuffer): ArrayBuffer {
	if (data instanceof ArrayBuffer) {
		return data;
	}
	const view = data as ArrayBufferView;
	return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

interface Harness {
	readonly client: RelayClient;
	readonly sockets: FakeSocket[];
	readonly timers: RecordingTimers;
	readonly authEvents: boolean[];
	readonly clock: { now: number };
	/** 最後に作られたソケットでE2Eを確立させる（PC役を演じる）。 */
	establish(): void;
}

async function harness(random = 0.5): Promise<Harness> {
	const mobile: Identity = generateIdentity();
	const pc: Identity = generateIdentity();
	const sockets: FakeSocket[] = [];
	const timers = new RecordingTimers();
	const authEvents: boolean[] = [];
	const clock = { now: 1_000_000 };
	const credentials: PairedCredentials = { relayUrl: 'wss://relay.test', deviceId: 'device', mobileId: 'mobile', mobileToken: 'token', pcPublicKey: pc.publicKey };
	const client = new RelayClient(mobile, credentials, () => {
		const socket = new FakeSocket();
		sockets.push(socket);
		return socket;
	}, { onAuthRejected: rejected => authEvents.push(rejected) }, timers, () => random, () => clock.now);
	const establish = () => {
		const socket = sockets[sockets.length - 1]!;
		socket.onopen?.();
		const hello = new Uint8Array(toArrayBuffer(socket.sent[socket.sent.length - 1]!));
		const responder = respondHandshake(pc, mobile.publicKey, hello);
		socket.onmessage?.({ data: toArrayBuffer(responder.response) });
	};
	return { client, sockets, timers, authEvents, clock, establish };
}

describe('relay retry delays', () => {
	it('uses full jitter between 0.25s and a cap that doubles from 0.5s up to 30s', () => {
		expect([
			relayReconnectDelayMs(0, 0),
			relayReconnectDelayMs(0, 0.999),
			relayReconnectDelayMs(3, 0.5),
			relayReconnectDelayMs(6, 0.999),
			relayReconnectDelayMs(50, 0.999),
		]).toEqual([250, 499, 2_000, 29_970, 29_970]);
	});

	it('re-probes a refused credential between 1 and 15 minutes, escalating', () => {
		expect([
			relayAuthGateDelayMs(0, 0),
			relayAuthGateDelayMs(0, 0.999),
			relayAuthGateDelayMs(1, 0.5),
			relayAuthGateDelayMs(3, 0.5),
			relayAuthGateDelayMs(20, 0.999),
		]).toEqual([60_000, 74_970, 120_000, 480_000, 900_000]);
	});

	it('treats only the relay close codes 4401 / 4404 / 4410 as a refusal', () => {
		expect([4401, 4404, 4410, 1006, 1000, 0, undefined].map(isRelayAuthRejection)).toEqual([true, true, true, false, false, false, false]);
		expect([PARADIS_RELAY_CLOSE_CODE.CREDENTIAL_REFUSED, PARADIS_RELAY_CLOSE_CODE.UNKNOWN_MOBILE, PARADIS_RELAY_CLOSE_CODE.REVOKED]).toEqual([4401, 4404, 4410]);
	});
});

describe('RelayClient reconnect pacing', () => {
	it('keeps growing the backoff across connections that die before 30s, and resets after a stable one', async () => {
		const h = await harness(0.999);
		h.client.connect();

		h.sockets[0]!.onclose?.({ code: 1006 });
		expect(h.timers.reconnectDelays()).toEqual([499]);
		h.timers.runReconnect();

		// 繋がってすぐ切れた: 回数は戻さない
		h.establish();
		expect(h.client.connectionState).toBe('online');
		h.clock.now += 5_000;
		h.sockets[1]!.onclose?.({ code: 1006 });
		expect(h.timers.reconnectDelays()).toEqual([999]);
		h.timers.runReconnect();

		// 30秒以上続いた接続が切れた: 最短から
		h.establish();
		h.clock.now += RELAY_STABLE_CONNECTION_MS;
		h.sockets[2]!.onclose?.({ code: 1006 });
		expect(h.timers.reconnectDelays()).toEqual([499]);
		h.client.close();
	});
});

describe('RelayClient credential refusal', () => {
	it('reports the refusal once, waits minutes, and ignores foreground nudges meanwhile', async () => {
		const h = await harness(0);
		h.client.connect();
		h.sockets[0]!.onopen?.();
		h.sockets[0]!.closeFromRelay(PARADIS_RELAY_CLOSE_CODE.UNKNOWN_MOBILE);

		expect(h.authEvents).toEqual([true]);
		expect(h.client.authRejected).toBe(true);
		expect(h.client.connectionState).toBe('offline');
		expect(h.timers.reconnectDelays()).toEqual([60_000]);

		// 心拍・前面復帰は待ちを打ち切らない
		h.client.ensureConnected();
		h.client.probeLiveness();
		expect(h.sockets.length).toBe(1);
		h.client.suspend();
		h.clock.now += 10_000;
		h.client.resume();
		expect(h.sockets.length).toBe(1);
		expect(h.timers.reconnectDelays()).toEqual([50_000]);

		// 待ちが明けたら確かめ直す。また拒まれたら間隔を延ばし、通知は重ねない
		h.clock.now += 50_000;
		h.timers.runReconnect();
		expect(h.sockets.length).toBe(2);
		h.sockets[1]!.closeFromRelay(PARADIS_RELAY_CLOSE_CODE.CREDENTIAL_REFUSED);
		expect(h.authEvents).toEqual([true]);
		expect(h.timers.reconnectDelays()).toEqual([90_000]);
		h.client.close();
	});

	it('clears the refusal when a later connection succeeds', async () => {
		const h = await harness(0);
		h.client.connect();
		h.sockets[0]!.closeFromRelay(PARADIS_RELAY_CLOSE_CODE.CREDENTIAL_REFUSED);
		h.clock.now += 60_000;
		h.timers.runReconnect();
		h.establish();

		expect(h.authEvents).toEqual([true, false]);
		expect(h.client.authRejected).toBe(false);
		// 心拍が再び即時に効く
		h.sockets[1]!.onclose?.({ code: 1006 });
		h.client.ensureConnected();
		expect(h.sockets.length).toBe(3);
		h.client.close();
	});

	it('keeps the old behaviour for a relay that still answers with HTTP 401 (seen as 1006)', async () => {
		const h = await harness(0);
		h.client.connect();
		h.sockets[0]!.onerror?.(new Error('401'));
		h.sockets[0]!.onclose?.({ code: 1006 });

		expect(h.authEvents).toEqual([]);
		expect(h.timers.reconnectDelays()).toEqual([250]);
		h.client.close();
	});
});

describe('RelayClient heartbeat nudges', () => {
	it('redials on a heartbeat without resetting the backoff, while a foreground nudge resets it', async () => {
		const h = await harness(0.999);
		h.client.connect();
		h.sockets[0]!.onclose?.({ code: 1006 });
		h.timers.runReconnect();
		h.sockets[1]!.onclose?.({ code: 1006 });
		expect(h.timers.reconnectDelays()).toEqual([999]);

		// 心拍: すぐ張り直すが、回数は戻さない（次の待ちは伸びたまま）
		h.client.ensureConnected({ keepBackoff: true });
		h.sockets[2]!.onclose?.({ code: 1006 });
		expect(h.timers.reconnectDelays()).toEqual([1_998]);

		// 前面復帰などの人が待っている張り直し: 最短から
		h.client.ensureConnected();
		h.sockets[3]!.onclose?.({ code: 1006 });
		expect(h.timers.reconnectDelays()).toEqual([499]);
		h.client.close();
	});
});
