// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Channels, generateIdentity, respondHandshake, type Frame, type Identity, FrameMux } from '@para/protocol';
import { describe, expect, it } from 'vitest';
import { RelayClient, type PairedCredentials, type SocketLike } from './relayClient.js';

/**
 * テスト用の双方向fakeソケット。RelayClientが生成する側(client)と、
 * テストが「リレー越しのPC」を演じる側(peer)をメモリ上で繋ぐ。
 */
class FakeSocketPair {
	readonly client: SocketLike;
	private clientHandlers: Partial<SocketLike> = {};
	private peerOnMessage: ((data: string | ArrayBuffer) => void) | null = null;

	constructor() {
		const self = this;
		this.client = {
			binaryType: 'blob',
			send(data) {
				const bytes = typeof data === 'string' ? data : toArrayBuffer(data);
				queueMicrotask(() => self.peerOnMessage?.(bytes));
			},
			close() { queueMicrotask(() => self.clientHandlers.onclose?.()); },
			get onopen() { return self.clientHandlers.onopen ?? null; },
			set onopen(h) { self.clientHandlers.onopen = h ?? undefined; },
			get onclose() { return self.clientHandlers.onclose ?? null; },
			set onclose(h) { self.clientHandlers.onclose = h ?? undefined; },
			get onerror() { return self.clientHandlers.onerror ?? null; },
			set onerror(h) { self.clientHandlers.onerror = h ?? undefined; },
			get onmessage() { return self.clientHandlers.onmessage ?? null; },
			set onmessage(h) { self.clientHandlers.onmessage = h ?? undefined; },
		} as SocketLike;
	}

	/** RelayClientのonopenを発火（接続確立をシミュレート）。 */
	fireOpen(): void { this.clientHandlers.onopen?.(); }

	/** peer(PC)側の受信ハンドラを登録。 */
	onPeerMessage(handler: (data: string | ArrayBuffer) => void): void { this.peerOnMessage = handler; }

	/** peer(PC)→client へ送る。 */
	sendToClient(data: string | Uint8Array): void {
		const payload = typeof data === 'string' ? data : toArrayBuffer(data);
		queueMicrotask(() => this.clientHandlers.onmessage?.({ data: payload }));
	}

	fireClose(): void { this.clientHandlers.onclose?.(); }
}

function toArrayBuffer(data: string | ArrayBufferView | ArrayBuffer): ArrayBuffer {
	if (data instanceof ArrayBuffer) { return data; }
	const view = data as ArrayBufferView;
	return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

function credsFor(pcPublicKey: Uint8Array): PairedCredentials {
	return {
		relayUrl: 'wss://relay.test',
		deviceId: 'dev1',
		mobileId: 'AAAAAAAAAAAAAAAAAAAAAA',
		mobileToken: 'tok',
		pcPublicKey,
	};
}

/** PC(レスポンダ)を演じ、ハンドシェイクを完了してSecureChannelを返す。 */
function drivePcSide(pair: FakeSocketPair, pcStatic: Identity, mobileStaticPub: Uint8Array): Promise<FrameMux> {
	return new Promise((resolve, reject) => {
		let responder: ReturnType<typeof respondHandshake> | null = null;
		let mux: FrameMux | null = null;
		pair.onPeerMessage(data => {
			try {
				if (typeof data === 'string') { return; }
				const bytes = new Uint8Array(data);
				if (!responder) {
					responder = respondHandshake(pcStatic, mobileStaticPub, bytes);
					pair.sendToClient(new Uint8Array(responder.response));
				} else if (!mux) {
					// 次に来るのは confirm
					responder.verifyConfirm(bytes);
					mux = new FrameMux(responder.channel, { sendSealed: s => pair.sendToClient(new Uint8Array(s)) });
					resolve(mux);
				} else {
					mux.receive(bytes);
				}
			} catch (e) { reject(e); }
		});
	});
}

describe('RelayClient', () => {
	it('establishes E2E channel and exchanges frames both ways', async () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pair = new FakeSocketPair();

		const states: string[] = [];
		const received: Frame[] = [];
		const client = new RelayClient(mobile, credsFor(pc.publicKey), () => pair.client, {
			onStateChange: s => states.push(s),
			onFrame: f => received.push(f),
		});

		const pcMuxPromise = drivePcSide(pair, pc, mobile.publicKey);
		client.connect();
		pair.fireOpen();
		const pcMux = await pcMuxPromise;
		await flush();

		expect(client.connectionState).toBe('online');
		expect(states).toContain('handshaking');
		expect(states).toContain('online');

		// PC→モバイル: stateフレーム
		pcMux.send(Channels.State, new TextEncoder().encode('{"workspaces":[]}'));
		await flush();
		expect(received.length).toBe(1);
		expect(received[0]!.ch).toBe('state');
		expect(new TextDecoder().decode(received[0]!.payload)).toBe('{"workspaces":[]}');

		// モバイル→PC: termフレーム（PC側muxで受ける）
		const pcGot: Frame[] = [];
		pcMux.on(Channels.Terminal, f => pcGot.push(f));
		client.send(Channels.Terminal, new TextEncoder().encode('ls\n'), 'para-code');
		await flush();
		expect(pcGot.length).toBe(1);
		expect(pcGot[0]!.ws).toBe('para-code');
		expect(new TextDecoder().decode(pcGot[0]!.payload)).toBe('ls\n');
	});

	it('reflects PC presence control messages', async () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pair = new FakeSocketPair();
		const presence: boolean[] = [];
		const client = new RelayClient(mobile, credsFor(pc.publicKey), () => pair.client, {
			onPcPresence: online => presence.push(online),
		});
		void drivePcSide(pair, pc, mobile.publicKey);
		client.connect();
		pair.fireOpen();
		await flush();

		pair.sendToClient(JSON.stringify({ type: 'presence', peer: 'pc', online: false }));
		await flush();
		expect(presence).toEqual([false]);
	});

	it('schedules reconnect on unexpected close and stops on user close', async () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		let created = 0;
		const pairs: FakeSocketPair[] = [];
		let scheduled: (() => void) | null = null;
		const timers = {
			setTimeout: (h: () => void) => { scheduled = h; return 1; },
			clearTimeout: () => { scheduled = null; },
		};
		const factory = () => { created++; const p = new FakeSocketPair(); pairs.push(p); return p.client; };
		const client = new RelayClient(mobile, credsFor(pc.publicKey), factory, {}, timers);

		client.connect();
		expect(created).toBe(1);
		pairs[0]!.fireClose();
		await flush();
		// 再接続がスケジュールされている
		expect(scheduled).not.toBeNull();
		scheduled!();
		expect(created).toBe(2);

		// ユーザーが閉じたら再接続しない
		client.close();
		pairs[1]!.fireClose();
		await flush();
		expect(created).toBe(2);
	});

	it('re-handshakes with a fresh socket when the PC comes back online', async () => {
		// PC再起動時、モバイル側ソケットはリレーDOに保持されたまま生き続ける。旧セッション鍵の
		// まま送受信を続けると新PCは最初のsealed frameをhelloと誤解して受信不能になるため、
		// presenceのoffline→online遷移で必ずソケットを張り直して新しいhandshakeを行う。
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pairs: FakeSocketPair[] = [];
		let scheduled: (() => void) | null = null;
		const timers = {
			setTimeout: (h: () => void) => { scheduled = h; return 1; },
			clearTimeout: () => { scheduled = null; },
		};
		const client = new RelayClient(mobile, credsFor(pc.publicKey), () => {
			const pair = new FakeSocketPair();
			pairs.push(pair);
			return pair.client;
		}, {}, timers);

		client.connect();
		const firstPcMuxPromise = drivePcSide(pairs[0]!, pc, mobile.publicKey);
		pairs[0]!.fireOpen();
		await firstPcMuxPromise;
		await flush();
		expect(client.connectionState).toBe('online');

		// PC再起動: presence offline → online
		pairs[0]!.sendToClient(JSON.stringify({ type: 'presence', peer: 'pc', online: false }));
		await flush();
		pairs[0]!.sendToClient(JSON.stringify({ type: 'presence', peer: 'pc', online: true }));
		await flush();
		// 旧ソケットが閉じられ、再接続がスケジュールされる
		expect(scheduled).not.toBeNull();
		scheduled!();
		expect(pairs).toHaveLength(2);
		const secondPcMuxPromise = drivePcSide(pairs[1]!, pc, mobile.publicKey);
		pairs[1]!.fireOpen();
		await secondPcMuxPromise;
		await flush();
		expect(client.connectionState).toBe('online');

		// online→online（変化なし）では張り直さない
		pairs[1]!.sendToClient(JSON.stringify({ type: 'presence', peer: 'pc', online: true }));
		await flush();
		expect(pairs).toHaveLength(2);
	});

	it('suspends the foreground socket and reconnects with a fresh socket on resume', async () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pairs: FakeSocketPair[] = [];
		const received: Frame[] = [];
		const client = new RelayClient(mobile, credsFor(pc.publicKey), () => {
			const pair = new FakeSocketPair();
			pairs.push(pair);
			return pair.client;
		}, { onFrame: frame => received.push(frame) });

		client.connect();
		const firstPcMuxPromise = drivePcSide(pairs[0]!, pc, mobile.publicKey);
		pairs[0]!.fireOpen();
		const firstPcMux = await firstPcMuxPromise;
		await flush();
		client.suspend();
		expect(client.connectionState).toBe('offline');

		firstPcMux.send(Channels.State, new TextEncoder().encode('{"stale":true}'));
		await flush();
		expect(received).toEqual([]);

		client.resume();
		expect(pairs).toHaveLength(2);
		const secondPcMuxPromise = drivePcSide(pairs[1]!, pc, mobile.publicKey);
		pairs[1]!.fireOpen();
		await secondPcMuxPromise;
		await flush();
		expect(client.connectionState).toBe('online');
	});
});
