// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { generateIdentity, respondHandshake, FrameMux, Channels, encodeNotify, type Identity } from '@para/protocol';
import { describe, expect, it } from 'vitest';
import { clearCredentials, loadCredentials, loadOrCreateIdentity, MobileController, revokeSelfOnRelay, saveCredentials, type KeyStore } from './store.js';
import type { PairedCredentials, SocketLike } from './relayClient.js';

class MemoryKeyStore implements KeyStore {
	private readonly map = new Map<string, string>();
	async getItem(k: string) { return this.map.get(k) ?? null; }
	async setItem(k: string, v: string) { this.map.set(k, v); }
	async deleteItem(k: string) { this.map.delete(k); }
}

describe('key persistence', () => {
	it('generates identity once and reloads the same', async () => {
		const ks = new MemoryKeyStore();
		const a = await loadOrCreateIdentity(ks);
		expect(a.created).toBe(true);
		const b = await loadOrCreateIdentity(ks);
		expect(b.created).toBe(false);
		expect(Array.from(b.identity.publicKey)).toEqual(Array.from(a.identity.publicKey));
		expect(Array.from(b.identity.secretKey)).toEqual(Array.from(a.identity.secretKey));
	});

	it('roundtrips credentials', async () => {
		const ks = new MemoryKeyStore();
		const creds: PairedCredentials = {
			relayUrl: 'wss://r', deviceId: 'd', mobileId: 'm', mobileToken: 't',
			pcPublicKey: generateIdentity().publicKey,
		};
		await saveCredentials(ks, creds);
		const loaded = await loadCredentials(ks);
		expect(loaded?.deviceId).toBe('d');
		expect(Array.from(loaded!.pcPublicKey)).toEqual(Array.from(creds.pcPublicKey));
	});

	it('clears credentials on unpair', async () => {
		const ks = new MemoryKeyStore();
		await saveCredentials(ks, { relayUrl: 'wss://r', deviceId: 'd', mobileId: 'm', mobileToken: 't', pcPublicKey: generateIdentity().publicKey });
		await clearCredentials(ks);
		expect(await loadCredentials(ks)).toBeUndefined();
	});
});

describe('revokeSelfOnRelay', () => {
	const creds: PairedCredentials = {
		relayUrl: 'wss://relay.example/', deviceId: 'dev1', mobileId: 'mob1', mobileToken: 'tok1',
		pcPublicKey: generateIdentity().publicKey,
	};

	it('POSTs to the self-revoke endpoint with bearer auth (ws -> http)', async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const fakeFetch = (async (url: unknown, init?: RequestInit) => {
			captured = { url: String(url), init: init! };
			return { ok: true } as Response;
		}) as typeof fetch;
		expect(await revokeSelfOnRelay(creds, fakeFetch)).toBe(true);
		expect(captured!.url).toBe('https://relay.example/device/dev1/mobile/self-revoke');
		expect((captured!.init.headers as Record<string, string>).authorization).toBe('Bearer tok1');
		expect(JSON.parse(captured!.init.body as string)).toEqual({ mobileId: 'mob1' });
	});

	it('returns false on network failure without throwing', async () => {
		const fakeFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
		expect(await revokeSelfOnRelay(creds, fakeFetch)).toBe(false);
	});

	it('aborts after the timeout instead of hanging', async () => {
		// 応答が永遠に返らないfetch: AbortSignalのabortでのみrejectする（ハーフオープン接続相当）。
		const fakeFetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
		})) as typeof fetch;
		expect(await revokeSelfOnRelay(creds, fakeFetch, 50)).toBe(false);
	});
});

// --- MobileController: 接続と state/term 反映（fakeソケット + PCレスポンダで） ---

class FakePair {
	readonly client: SocketLike;
	private h: Partial<SocketLike> = {};
	private peer: ((d: string | ArrayBuffer) => void) | null = null;
	constructor() {
		const self = this;
		this.client = {
			binaryType: 'arraybuffer',
			send(d) { const b = typeof d === 'string' ? d : ab(d); queueMicrotask(() => self.peer?.(b)); },
			close() { queueMicrotask(() => self.h.onclose?.()); },
			get onopen() { return self.h.onopen ?? null; }, set onopen(v) { self.h.onopen = v ?? undefined; },
			get onclose() { return self.h.onclose ?? null; }, set onclose(v) { self.h.onclose = v ?? undefined; },
			get onerror() { return self.h.onerror ?? null; }, set onerror(v) { self.h.onerror = v ?? undefined; },
			get onmessage() { return self.h.onmessage ?? null; }, set onmessage(v) { self.h.onmessage = v ?? undefined; },
		} as SocketLike;
	}
	fireOpen() { this.h.onopen?.(); }
	onPeer(f: (d: string | ArrayBuffer) => void) { this.peer = f; }
	toClient(d: string | Uint8Array) { const p = typeof d === 'string' ? d : ab(d); queueMicrotask(() => this.h.onmessage?.({ data: p })); }
}
function ab(d: string | ArrayBufferView | ArrayBuffer): ArrayBuffer {
	if (d instanceof ArrayBuffer) { return d; }
	const v = d as ArrayBufferView;
	return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function drivePc(pair: FakePair, pc: Identity, mobilePub: Uint8Array): Promise<FrameMux> {
	return new Promise((resolve, reject) => {
		let responder: ReturnType<typeof respondHandshake> | null = null;
		let mux: FrameMux | null = null;
		pair.onPeer(d => {
			try {
				if (typeof d === 'string') { return; }
				const bytes = new Uint8Array(d);
				if (!responder) { responder = respondHandshake(pc, mobilePub, bytes); pair.toClient(new Uint8Array(responder.response)); }
				else if (!mux) { responder.verifyConfirm(bytes); mux = new FrameMux(responder.channel, { sendSealed: s => pair.toClient(new Uint8Array(s)) }); resolve(mux); }
				else { mux.receive(bytes); }
			} catch (e) { reject(e); }
		});
	});
}

describe('MobileController', () => {
	it('reflects state snapshot and terminal output from PC', async () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pair = new FakePair();
		const creds: PairedCredentials = { relayUrl: 'wss://r', deviceId: 'd', mobileId: 'AAAAAAAAAAAAAAAAAAAAAA', mobileToken: 't', pcPublicKey: pc.publicKey };

		let latest: import('./store.js').StoreState | undefined;
		const notified: import('@para/protocol').NotifyPayload[] = [];
		const controller = new MobileController(mobile, () => pair.client, s => { latest = s; }, p => notified.push(p));
		const pcMuxP = drivePc(pair, pc, mobile.publicKey);
		controller.connect(creds);
		pair.fireOpen();
		const pcMux = await pcMuxP;
		await flush();

		expect(latest?.connection).toBe('online');

		// PC → state
		pcMux.send(Channels.State, new TextEncoder().encode(JSON.stringify({ activeWs: 'w1', workspaces: [{ id: 'w1', name: 'para-code' }], terminals: [{ id: 1, title: 'zsh' }] })));
		await flush();
		expect(latest?.workspace?.workspaces[0]!.name).toBe('para-code');

		// PC → term data
		pcMux.send(Channels.Terminal, new TextEncoder().encode(JSON.stringify({ t: 'data', id: 1, data: 'hello\n' })));
		await flush();
		expect(latest?.terminalOutput.get(1)).toBe('hello\n');

		// mobile → term input（PC側で受信を確認）
		const pcGot: string[] = [];
		pcMux.on(Channels.Terminal, f => pcGot.push(new TextDecoder().decode(f.payload)));
		controller.sendInput(1, 'ls');
		await flush();
		expect(JSON.parse(pcGot[0]!)).toEqual({ t: 'input', id: 1, data: 'ls' });

		// PC → notify: 質問通知が state に反映され onNotify が呼ばれる
		pcMux.send(Channels.Notify, encodeNotify({ kind: 'agent-question', id: 'q1', title: 'claude — para-code', body: '確認を求めています', at: 1 }));
		await flush();
		expect(latest?.notifications.length).toBe(1);
		expect(latest?.notifications[0]!.kind).toBe('agent-question');
		expect(notified.map(n => n.id)).toEqual(['q1']);

		// 同一IDの重複通知は無視
		pcMux.send(Channels.Notify, encodeNotify({ kind: 'agent-question', id: 'q1', title: 'x', body: 'y', at: 2 }));
		await flush();
		expect(latest?.notifications.length).toBe(1);
	});

	it('scm/fs request-response resolves and rejects by id', async () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pair = new FakePair();
		const creds: PairedCredentials = { relayUrl: 'wss://r', deviceId: 'd', mobileId: 'AAAAAAAAAAAAAAAAAAAAAA', mobileToken: 't', pcPublicKey: pc.publicKey };

		const controller = new MobileController(mobile, () => pair.client, () => { });
		const pcMuxP = drivePc(pair, pc, mobile.publicKey);
		controller.connect(creds);
		pair.fireOpen();
		const pcMux = await pcMuxP;
		await flush();

		// PC側: scm/fs リクエストに id 付きで応答するエコーサーバ
		pcMux.on(Channels.Scm, f => {
			const req = JSON.parse(new TextDecoder().decode(f.payload)) as { id: string; t: string; ws: string };
			if (req.t === 'status') {
				pcMux.send(Channels.Scm, new TextEncoder().encode(JSON.stringify({ id: req.id, t: 'status', branch: 'main', files: [{ x: 'M', y: ' ', path: 'a.ts' }] })));
			} else {
				pcMux.send(Channels.Scm, new TextEncoder().encode(JSON.stringify({ id: req.id, error: 'boom' })));
			}
		});
		pcMux.on(Channels.Fs, f => {
			const req = JSON.parse(new TextDecoder().decode(f.payload)) as { id: string; t: string; path: string };
			pcMux.send(Channels.Fs, new TextEncoder().encode(JSON.stringify({ id: req.id, t: 'list', entries: [{ name: 'src', dir: true }] })));
		});

		const status = await controller.scmStatus('w1');
		expect(status.branch).toBe('main');
		expect(status.files[0]!.path).toBe('a.ts');

		await expect(controller.scmDiff('w1', 'a.ts')).rejects.toThrow('boom');

		const listing = await controller.fsList('w1', '');
		expect(listing.entries[0]!.name).toBe('src');
	});
});
