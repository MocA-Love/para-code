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

	it('emit only swaps references for the collection that actually changed', async () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pair = new FakePair();
		const creds: PairedCredentials = { relayUrl: 'wss://r', deviceId: 'd', mobileId: 'AAAAAAAAAAAAAAAAAAAAAA', mobileToken: 't', pcPublicKey: pc.publicKey };

		// 毎回の emit スナップショットを（スプレッドせず）そのまま貯め、コレクションの参照同一性を検証する。
		const emits: import('./store.js').StoreState[] = [];
		const controller = new MobileController(mobile, () => pair.client, s => { emits.push(s); });
		const pcMuxP = drivePc(pair, pc, mobile.publicKey);
		controller.connect(creds);
		pair.fireOpen();
		const pcMux = await pcMuxP;
		await flush();

		const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

		// term 出力更新: terminalOutput だけ新参照になり、agentChats/notifications は据え置き。
		const beforeTerm = emits[emits.length - 1]!;
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'hello' }));
		await flush();
		const afterTerm = emits[emits.length - 1]!;
		expect(afterTerm.terminalOutput).not.toBe(beforeTerm.terminalOutput);
		expect(afterTerm.agentChats).toBe(beforeTerm.agentChats);
		expect(afterTerm.notifications).toBe(beforeTerm.notifications);

		// agentChat 更新: agentChats だけ新参照になり、terminalOutput/notifications は据え置き。
		const beforeAgent = emits[emits.length - 1]!;
		pcMux.send(Channels.Agent, enc({ t: 'snapshot', id: 1, agent: 'claude', epoch: 'e1', rev: 0, messages: [] }));
		await flush();
		const afterAgent = emits[emits.length - 1]!;
		expect(afterAgent.agentChats).not.toBe(beforeAgent.agentChats);
		expect(afterAgent.terminalOutput).toBe(beforeAgent.terminalOutput);
		expect(afterAgent.notifications).toBe(beforeAgent.notifications);

		// browserFrame 更新: どの Map/配列の参照も変わらない（browserFrame のみ差し替わる）。
		const beforeFrame = emits[emits.length - 1]!;
		pcMux.send(Channels.Browser, enc({ t: 'frame', data: 'AAAA', w: 10, h: 10 }));
		await flush();
		const afterFrame = emits[emits.length - 1]!;
		expect(afterFrame.browserFrame?.data).toBe('AAAA');
		expect(afterFrame.terminalOutput).toBe(beforeFrame.terminalOutput);
		expect(afterFrame.agentChats).toBe(beforeFrame.agentChats);
		expect(afterFrame.notifications).toBe(beforeFrame.notifications);
	});
});

// --- ターミナル同期プロトコル（epoch/seq/ACK） ---

describe('MobileController terminal sync protocol', () => {
	async function setup() {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pair = new FakePair();
		const creds: PairedCredentials = { relayUrl: 'wss://r', deviceId: 'd', mobileId: 'AAAAAAAAAAAAAAAAAAAAAA', mobileToken: 't', pcPublicKey: pc.publicKey };
		let latest: import('./store.js').StoreState | undefined;
		const controller = new MobileController(mobile, () => pair.client, s => { latest = s; });
		const pcMuxP = drivePc(pair, pc, mobile.publicKey);
		controller.connect(creds);
		pair.fireOpen();
		const pcMux = await pcMuxP;
		await flush();
		const enc = (o: object) => new TextEncoder().encode(JSON.stringify(o));
		const pcGot: { t: string; id: number; epoch?: number; seq?: number }[] = [];
		pcMux.on(Channels.Terminal, f => pcGot.push(JSON.parse(new TextDecoder().decode(f.payload))));
		return { controller, pcMux, enc, pcGot, latestState: () => latest };
	}

	it('attaches with epoch, applies snapshot/data in order and acks the snapshot', async () => {
		const { controller, pcMux, enc, pcGot } = await setup();
		const events: import('./store.js').TermStreamEvent[] = [];
		controller.subscribeTerminal(1, ev => events.push(ev));
		controller.attachTerminal(1);
		await flush();
		expect(pcGot[0]!.t).toBe('attach');
		const epoch = pcGot[0]!.epoch!;
		expect(typeof epoch).toBe('number');

		// snapshot（cols/rows/unicode同梱） → 購読者へ届き、即ACKが返る
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'SNAP', snapshot: true, epoch, seq: 1, cols: 120, rows: 40, unicode: '11' }));
		await flush();
		expect(events).toEqual([{ kind: 'snapshot', data: 'SNAP', cols: 120, rows: 40, unicode: '11' }]);
		const ack = pcGot.find(m => m.t === 'ack');
		expect(ack).toEqual({ t: 'ack', id: 1, epoch, seq: 1 });

		// 連続seqのdataは追記イベントになる
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'abc', epoch, seq: 2 }));
		await flush();
		expect(events[1]).toEqual({ kind: 'data', data: 'abc' });

	});

	it('discards frames from a stale epoch and pre-snapshot data', async () => {
		const { controller, pcMux, enc, pcGot } = await setup();
		const events: import('./store.js').TermStreamEvent[] = [];
		controller.subscribeTerminal(1, ev => events.push(ev));
		controller.attachTerminal(1);
		await flush();
		const epoch1 = pcGot[0]!.epoch!;
		// snapshot前に届いたライブdataは捨てられる（snapshotに反映済みのため）
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'early', epoch: epoch1, seq: 1 }));
		await flush();
		expect(events).toEqual([]);
		// 再attach（新epoch）後、旧epochのsnapshotは捨てられる
		controller.attachTerminal(1);
		await flush();
		const epoch2 = pcGot.filter(m => m.t === 'attach')[1]!.epoch!;
		expect(epoch2).toBeGreaterThan(epoch1);
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'stale', snapshot: true, epoch: epoch1, seq: 2 }));
		await flush();
		expect(events).toEqual([]);
		// 新epochのsnapshotは適用される
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'fresh', snapshot: true, epoch: epoch2, seq: 1 }));
		await flush();
		expect(events).toEqual([{ kind: 'snapshot', data: 'fresh' }]);
	});

	it('re-attaches with a new epoch when a seq gap is detected', async () => {
		const { controller, pcMux, enc, pcGot } = await setup();
		controller.subscribeTerminal(1, () => { });
		controller.attachTerminal(1);
		await flush();
		const epoch = pcGot[0]!.epoch!;
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'SNAP', snapshot: true, epoch, seq: 1 }));
		await flush();
		// seq=3（=2を取りこぼした）→ 新epochで自動再attach
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'x', epoch, seq: 3 }));
		await flush();
		const attaches = pcGot.filter(m => m.t === 'attach');
		expect(attaches.length).toBe(2);
		expect(attaches[1]!.epoch!).toBeGreaterThan(epoch);
	});

	it('acks after receiving the ack-threshold worth of data', async () => {
		const { controller, pcMux, enc, pcGot } = await setup();
		controller.subscribeTerminal(1, () => { });
		controller.attachTerminal(1);
		await flush();
		const epoch = pcGot[0]!.epoch!;
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'S', snapshot: true, epoch, seq: 1 }));
		await flush();
		const acksAfterSnapshot = pcGot.filter(m => m.t === 'ack').length;
		// 5000文字未満ではACKしない
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'a'.repeat(4000), epoch, seq: 2 }));
		await flush();
		expect(pcGot.filter(m => m.t === 'ack').length).toBe(acksAfterSnapshot);
		// 閾値を超えたらACK（受信済み最終seqを載せる）
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'b'.repeat(2000), epoch, seq: 3 }));
		await flush();
		const acks = pcGot.filter(m => m.t === 'ack');
		expect(acks.length).toBe(acksAfterSnapshot + 1);
		expect(acks[acks.length - 1]!.seq).toBe(3);
	});

	it('replays the snapshot cache to late subscribers', async () => {
		const { controller, pcMux, enc, pcGot } = await setup();
		controller.subscribeTerminal(1, () => { });
		controller.attachTerminal(1);
		await flush();
		const epoch = pcGot[0]!.epoch!;
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'SNAP', snapshot: true, epoch, seq: 1, cols: 80, rows: 24 }));
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'tail', epoch, seq: 2 }));
		await flush();
		// 後から購読したリスナーにも snapshot→data の順でキャッシュが再生される
		const late: import('./store.js').TermStreamEvent[] = [];
		controller.subscribeTerminal(1, ev => late.push(ev));
		expect(late).toEqual([
			{ kind: 'snapshot', data: 'SNAP', cols: 80, rows: 24 },
			{ kind: 'data', data: 'tail' },
		]);
	});

	it('keeps the legacy string-buffer path for PCs that do not echo epoch', async () => {
		const { controller, pcMux, enc, latestState } = await setup();
		controller.subscribeTerminal(1, () => { });
		controller.attachTerminal(1);
		await flush();
		// epoch/seq無しの応答（旧PC） → terminalOutput に従来どおり蓄積される
		pcMux.send(Channels.Terminal, enc({ t: 'data', id: 1, data: 'legacy', snapshot: true }));
		await flush();
		expect(latestState()?.terminalOutput.get(1)).toBe('legacy');
	});
});
