// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { generateIdentity, respondHandshake, FrameMux, Channels, encodeNotify, encodeNotifyDismissed, decodeNotifyControl, type Identity } from '@para/protocol';
import { describe, expect, it } from 'vitest';
import { clearCredentials, loadCredentials, loadOrCreateIdentity, MobileController, revokeSelfOnRelay, saveCredentials, toAgentMessageSendResult, type KeyStore } from './store.js';
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
		pcMux.send(Channels.State, new TextEncoder().encode(JSON.stringify({ activeWs: 'w1', workspaces: [{ id: 'w1', name: 'para-code' }], terminals: [{ id: 1, title: 'zsh', agentToken: 'agent-1' }] })));
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

		// mobile → dismiss: ローカルの一覧から消え、PCへdismissメッセージが送られる
		const pcNotifyGot: import('@para/protocol').NotifyControlMessage[] = [];
		pcMux.on(Channels.Notify, f => { const c = decodeNotifyControl(f.payload); if (c) { pcNotifyGot.push(c); } });
		controller.dismissNotification('q1');
		await flush();
		expect(latest?.notifications.length).toBe(0);
		expect(pcNotifyGot).toEqual([{ t: 'dismiss', id: 'q1' }]);

		// PC → dismissed（他端末が処理済みにした）: 一覧にあれば消える。無ければ何もしない
		pcMux.send(Channels.Notify, encodeNotify({ kind: 'agent-question', id: 'q2', title: 'x', body: 'y', at: 3 }));
		await flush();
		expect(latest?.notifications.length).toBe(1);
		pcMux.send(Channels.Notify, encodeNotifyDismissed('q2'));
		await flush();
		expect(latest?.notifications.length).toBe(0);
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
		pcMux.send(Channels.State, enc({ activeWs: 'w1', workspaces: [{ id: 'w1', name: 'para-code' }], terminals: [{ id: 1, title: 'claude', agentToken: 'agent-1' }] }));
		await flush();

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
		pcMux.send(Channels.Agent, enc({ t: 'snapshot', id: 1, token: 'agent-1', agent: 'claude', epoch: 'e1', rev: 0, messages: [] }));
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

describe('MobileController Codex model control', () => {
	async function setup() {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pair = new FakePair();
		const creds: PairedCredentials = { relayUrl: 'wss://r', deviceId: 'd', mobileId: 'AAAAAAAAAAAAAAAAAAAAAA', mobileToken: 't', pcPublicKey: pc.publicKey };
		let latest: import('./store.js').StoreState | undefined;
		const controller = new MobileController(mobile, () => pair.client, state => { latest = state; });
		const pcMuxPromise = drivePc(pair, pc, mobile.publicKey);
		controller.connect(creds);
		pair.fireOpen();
		const pcMux = await pcMuxPromise;
		await flush();
		const encode = (value: object) => new TextEncoder().encode(JSON.stringify(value));
		const requests: Record<string, unknown>[] = [];
		pcMux.on(Channels.Agent, frame => requests.push(JSON.parse(new TextDecoder().decode(frame.payload))));
		pcMux.send(Channels.State, encode({ activeWs: 'w1', workspaces: [{ id: 'w1', name: 'para-code' }], terminals: [{ id: 7, title: 'codex', agentToken: 'agent-7' }] }));
		pcMux.send(Channels.Agent, encode({ t: 'snapshot', id: 7, token: 'agent-7', agent: 'codex', epoch: 'codex-e1', rev: 0, messages: [], info: { model: 'gpt-5.6-sol', effort: 'low' } }));
		await flush();
		return { controller, pcMux, encode, requests, latestState: () => latest };
	}

	it('roundtrips the dynamic catalog and atomically confirms model plus effort', async () => {
		const { controller, pcMux, encode, requests, latestState } = await setup();
		controller.requestAgentModelCatalog(7);
		await flush();
		const catalogRequest = requests[0] as { t: string; id: number; requestId: string };
		expect({ t: catalogRequest.t, id: catalogRequest.id }).toEqual({ t: 'model-catalog', id: 7 });

		pcMux.send(Channels.Agent, encode({
			t: 'model-catalog', id: 7, token: 'agent-7', requestId: catalogRequest.requestId,
			models: [{
				id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'strong',
				efforts: [{ value: 'low', description: 'fast' }, { value: 'max', description: 'deep' }, { value: 'ultra', description: 'agents' }],
				defaultEffort: 'low', isDefault: true,
			}],
		}));
		await flush();
		expect(latestState()?.agentChats.get(7)?.modelControl).toEqual({
			status: 'ready',
			models: [{
				id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'strong',
				efforts: [{ value: 'low', description: 'fast' }, { value: 'max', description: 'deep' }, { value: 'ultra', description: 'agents' }],
				defaultEffort: 'low', isDefault: true,
			}],
		});

		controller.updateAgentSettings(7, 'gpt-5.6-terra', 'ultra');
		await flush();
		const updateRequest = requests[1] as { t: string; id: number; requestId: string; model: string; effort: string };
		expect(updateRequest).toEqual({
			t: 'settings-update', id: 7, token: 'agent-7', requestId: updateRequest.requestId, model: 'gpt-5.6-terra', effort: 'ultra',
		});
		pcMux.send(Channels.Agent, encode({ t: 'settings-update', id: 7, token: 'agent-7', requestId: updateRequest.requestId, status: 'pending' }));
		pcMux.send(Channels.Agent, encode({
			t: 'settings-update', id: 7, token: 'agent-7', requestId: updateRequest.requestId, status: 'confirmed',
			info: { model: 'gpt-5.6-terra', effort: 'ultra' },
		}));
		await flush();
		expect({ info: latestState()?.agentChats.get(7)?.info, control: latestState()?.agentChats.get(7)?.modelControl }).toEqual({
			info: { model: 'gpt-5.6-terra', effort: 'ultra' },
			control: { status: 'ready', models: latestState()?.agentChats.get(7)?.modelControl?.models },
		});
	});

	it('does not fall back to an unsafe combined PTY send before agent actions are ready', async () => {
		const { controller, requests } = await setup();
		await expect(controller.sendAgentMessage(7, '送信しない')).resolves.toEqual({
			status: 'rejected', message: 'エージェントセッションを準備中です。少し待ってから再送してください。',
		});
		expect(requests).toEqual([]);
	});

	it('ignores stale responses and rejects a malformed catalog at the relay boundary', async () => {
		const { controller, pcMux, encode, requests, latestState } = await setup();
		controller.requestAgentModelCatalog(7);
		await flush();
		const request = requests[0] as { requestId: string };
		pcMux.send(Channels.Agent, encode({
			t: 'model-catalog', id: 7, token: 'agent-7', requestId: `${request.requestId}-stale`,
			models: [{ id: 'stale', model: 'stale', displayName: 'Stale', efforts: [{ value: 'high', description: '' }], defaultEffort: 'high', isDefault: true }],
		}));
		await flush();
		expect(latestState()?.agentChats.get(7)?.modelControl?.status).toBe('loading');

		pcMux.send(Channels.Agent, encode({
			t: 'model-catalog', id: 7, token: 'agent-7', requestId: request.requestId,
			models: [{ id: 'broken', model: 'broken', displayName: 'Broken', efforts: [{ value: 42 }], defaultEffort: 'high', isDefault: true }],
		}));
		await flush();
		expect(latestState()?.agentChats.get(7)?.modelControl).toEqual({
			status: 'error', models: [], errorCode: 'invalid-response', errorMessage: 'Codexのモデル一覧レスポンスが不正です',
		});
	});

});

describe('agent message action result', () => {
	it('keeps pasted-but-not-executed distinct from accepted', () => {
		expect(toAgentMessageSendResult('rejected', true, '本文は貼り付け済みです')).toEqual({ status: 'consumed', message: '本文は貼り付け済みです' });
		expect(toAgentMessageSendResult('accepted', false)).toEqual({ status: 'accepted' });
	});
});

describe('MobileController agent approval', () => {
	it('keeps Codex approval choices and sends the selected choice id', async () => {
		const mobile = generateIdentity();
		const pc = generateIdentity();
		const pair = new FakePair();
		const creds: PairedCredentials = { relayUrl: 'wss://r', deviceId: 'd', mobileId: 'AAAAAAAAAAAAAAAAAAAAAA', mobileToken: 't', pcPublicKey: pc.publicKey };
		let latest: import('./store.js').StoreState | undefined;
		const controller = new MobileController(mobile, () => pair.client, state => { latest = state; });
		const pcMuxPromise = drivePc(pair, pc, mobile.publicKey);
		controller.connect(creds);
		pair.fireOpen();
		const pcMux = await pcMuxPromise;
		await flush();
		const encode = (value: object) => new TextEncoder().encode(JSON.stringify(value));
		const requests: Record<string, unknown>[] = [];
		pcMux.on(Channels.Agent, frame => requests.push(JSON.parse(new TextDecoder().decode(frame.payload))));
		pcMux.send(Channels.State, encode({ activeWs: 'w1', workspaces: [{ id: 'w1', name: 'para-code' }], terminals: [{ id: 7, title: 'codex', agentToken: 'agent-7' }] }));
		pcMux.send(Channels.Agent, encode({
			t: 'snapshot', id: 7, token: 'agent-7', agent: 'codex', epoch: 'codex-e1', rev: 0, messages: [],
			capabilities: { agentActions: true },
			interaction: {
				kind: 'approval', id: 'codex:s:approval-1', title: 'コマンドの実行許可', detail: 'git add src/file.ts',
				choices: [
					{ id: '0', label: '今回だけ許可', tone: 'approve' },
					{ id: '1', label: '同じ種類のコマンドを今後許可', tone: 'neutral' },
					{ id: '2', label: '拒否', tone: 'deny' },
				],
			},
		}));
		await flush();

		expect(latest?.agentChats.get(7)?.interaction).toEqual({
			kind: 'approval', id: 'codex:s:approval-1', title: 'コマンドの実行許可', detail: 'git add src/file.ts',
			choices: [
				{ id: '0', label: '今回だけ許可', tone: 'approve' },
				{ id: '1', label: '同じ種類のコマンドを今後許可', tone: 'neutral' },
				{ id: '2', label: '拒否', tone: 'deny' },
			],
		});
		const answer = controller.answerAgentApproval(7, 'codex:s:approval-1', '1');
		await flush();
		expect(requests[0]).toEqual({
			t: 'action/answerApproval', id: 7, token: 'agent-7', requestId: requests[0]?.requestId,
			epoch: 'codex-e1', interactionId: 'codex:s:approval-1', choice: '1',
		});
		pcMux.send(Channels.Agent, encode({ t: 'action-result', id: 7, token: 'agent-7', requestId: requests[0]?.requestId, status: 'accepted' }));
		await expect(answer).resolves.toBe(true);
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
