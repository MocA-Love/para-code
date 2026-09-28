// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC ⇔ モバイルの公開ワイヤの固定形（ゴールデン、`app/protocol/test/golden/`）をアプリ側から確かめる。
 *
 * - アプリが送る形（State の要求・term の attach・agent の attach）が、ゴールデンと同じ形であること
 * - PC が送る形（今の PC と W2-17 より前の PC の State・term・agent）を、アプリが受け付けること
 * - 版が合わないとき、どちらを更新すべきかを言い分けること
 *
 * PC 側は `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileWireGolden.test.ts` が同じファイルを読み、
 * 逆向きを確かめる。形を変えたらゴールデンと両方のテストを同じ変更で直す。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Channels, FrameMux, generateIdentity, respondHandshake, type Identity } from '@para/protocol';
import { describe, expect, it } from 'vitest';
import { MobileController, type PcPushMessage, type StoreState } from './store.js';
import type { PairedCredentials, SocketLike } from './relayClient.js';
import { PcCapability, stateRequestFields } from './pcCompat.js';

type Golden = Record<string, unknown>;

function readGolden<T = Golden>(name: string): T {
	return JSON.parse(readFileSync(fileURLToPath(new URL(`../../protocol/test/golden/${name}`, import.meta.url)), 'utf8')) as T;
}

type Shape = string | Shape[] | { [key: string]: Shape };

/** 値を「項目名と値の型」だけの形にする（PC 側のテストと同じ規則）。 */
function shapeOf(value: unknown): Shape {
	if (Array.isArray(value)) {
		return value.length === 0 ? [] : [shapeOf(value[0])];
	}
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => [key, shapeOf(record[key])]));
	}
	return typeof value;
}

// --- store.test.ts と同じ、偽ソケット + PC 側のハンドシェイク ------------------------------------

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
	toClient(d: Uint8Array) { const p = ab(d); queueMicrotask(() => this.h.onmessage?.({ data: p })); }
}
function ab(d: string | ArrayBufferView | ArrayBuffer): ArrayBuffer {
	if (d instanceof ArrayBuffer) { return d; }
	const v = d as ArrayBufferView;
	return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (payload: Uint8Array) => JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;

function drivePc(pair: FakePair, pc: Identity, mobilePub: Uint8Array, onMux: (mux: FrameMux) => void): Promise<FrameMux> {
	return new Promise((resolve, reject) => {
		let responder: ReturnType<typeof respondHandshake> | null = null;
		let mux: FrameMux | null = null;
		pair.onPeer(d => {
			try {
				if (typeof d === 'string') { return; }
				const bytes = new Uint8Array(d);
				if (!responder) { responder = respondHandshake(pc, mobilePub, bytes); pair.toClient(new Uint8Array(responder.response)); }
				else if (!mux) { responder.verifyConfirm(bytes); mux = new FrameMux(responder.channel, { sendSealed: s => pair.toClient(new Uint8Array(s)) }); onMux(mux); resolve(mux); }
				else { mux.receive(bytes); }
			} catch (e) { reject(e); }
		});
	});
}

async function connect() {
	const mobile = generateIdentity();
	const pc = generateIdentity();
	const pair = new FakePair();
	const creds: PairedCredentials = { relayUrl: 'wss://r', deviceId: 'd', mobileId: 'AAAAAAAAAAAAAAAAAAAAAA', mobileToken: 't', pcPublicKey: pc.publicKey };
	let latest: StoreState | undefined;
	const controller = new MobileController(mobile, () => pair.client, state => { latest = state; });
	const sent: Record<string, Record<string, unknown>[]> = { state: [], term: [], agent: [], scm: [] };
	const pcMuxPromise = drivePc(pair, pc, mobile.publicKey, mux => {
		mux.on(Channels.State, frame => sent.state!.push(decode(frame.payload)));
		mux.on(Channels.Terminal, frame => sent.term!.push(decode(frame.payload)));
		mux.on(Channels.Agent, frame => sent.agent!.push(decode(frame.payload)));
		mux.on(Channels.Scm, frame => sent.scm!.push(decode(frame.payload)));
	});
	controller.connect(creds);
	pair.fireOpen();
	const pcMux = await pcMuxPromise;
	await flush();
	return { controller, pcMux, sent, latest: () => latest };
}

const stateGolden = readGolden<{ current: Golden; preW217: Golden }>('state.json');
const stateRequestGolden = readGolden<{ current: Golden; preW217: Golden }>('state-request.json');
const termGolden = readGolden<{ toPc: Golden[]; toMobile: Golden[] }>('term.json');
const agentGolden = readGolden<{ toPc: Golden[]; toMobile: Golden[] }>('agent.json');

describe('wire golden (app side)', () => {
	it('State の要求はゴールデンの current と値まで同じで、今の PC の State を受け付けて機能を覚える', async () => {
		const { controller, pcMux, sent, latest } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		// 版・受け入れる PC の最低版・機能の広告を変えたら、ゴールデンも同じ変更で直す（値まで比べる）。
		const { stateEncoding: _stateEncoding, ...goldenFields } = stateRequestGolden.current;
		expect({
			request: sent.state![0],
			fields: stateRequestFields(),
			ready: latest()?.sessionProtocolReady,
			updateRequired: latest()?.updateRequired,
			termSync: controller.hasPcCapability(PcCapability.TermSync),
			unknown: controller.hasPcCapability('scm.push.v1'),
		}).toEqual({
			request: stateRequestGolden.current,
			fields: goldenFields,
			ready: true,
			updateRequired: undefined,
			termSync: true,
			unknown: false,
		});
		controller.disconnect();
	});

	it('W2-17 より前の PC の State も受け付け、機能は何も持っていない扱いにする', async () => {
		const { controller, pcMux, latest } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.preW217));
		await flush();
		expect({
			ready: latest()?.sessionProtocolReady,
			terminals: latest()?.workspace?.terminals.length,
			capabilities: latest()?.workspace?.capabilities,
			termSync: controller.hasPcCapability(PcCapability.TermSync),
		}).toEqual({ ready: true, terminals: 1, capabilities: undefined, termSync: false });
		controller.disconnect();
	});

	it('版が合わないとき、アプリと PC のどちらを更新すべきかを言い分ける', async () => {
		const verdicts: Array<[string, unknown]> = [];
		for (const [name, state] of [
			['PC が新しくアプリを切った', { ...stateGolden.current, protocolVersion: 4, minCompatibleMobile: 4 }],
			['W2-17 より前の新しい PC', { ...stateGolden.preW217, protocolVersion: 4 }],
			['古い PC', { ...stateGolden.preW217, protocolVersion: 2 }],
			['PC が新しいが窓の中', { ...stateGolden.current, protocolVersion: 4, minCompatibleMobile: 3 }],
		] as const) {
			const { controller, pcMux, latest } = await connect();
			pcMux.send(Channels.State, encode(state));
			await flush();
			verdicts.push([name, latest()?.updateRequired ?? (latest()?.sessionProtocolReady === true ? 'ok' : 'not-ready')]);
			controller.disconnect();
		}
		expect(verdicts).toEqual([
			['PC が新しくアプリを切った', 'app'],
			['W2-17 より前の新しい PC', 'app'],
			['古い PC', 'pc'],
			['PC が新しいが窓の中', 'ok'],
		]);
	});

	it('term: attach はゴールデンと同じ形で、PC が送る data / exit / operation-result を受け付ける', async () => {
		const { controller, pcMux, sent, latest } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		controller.setTerminalViewport({ cols: 54, rows: 28 });
		controller.subscribeTerminal('terminal-key-1', () => { });
		controller.attachTerminal('terminal-key-1');
		await flush();
		const attach = sent.term!.find(message => message.t === 'attach');
		const goldenAttach = termGolden.toPc.find(message => message.t === 'attach');
		for (const message of termGolden.toMobile) {
			pcMux.send(Channels.Terminal, encode(message.epoch !== undefined ? { ...message, epoch: attach?.epoch } : message));
			await flush();
			if (message.t === 'data') {
				expect(latest()?.terminalOutput.get('terminal-key-1')).toContain(String(message.data));
			}
		}
		expect({ attach: shapeOf(attach), exited: latest()?.terminalOutput.has('terminal-key-1') }).toEqual({ attach: shapeOf(goldenAttach), exited: false });
		controller.disconnect();
	});

	it('agent: attach はゴールデンと同じ形で、PC が送る snapshot / delta を会話へ積む', async () => {
		const { controller, pcMux, sent, latest } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		controller.attachAgent('terminal-key-1');
		await flush();
		for (const message of agentGolden.toMobile.filter(candidate => candidate.t === 'snapshot' || candidate.t === 'delta')) {
			pcMux.send(Channels.Agent, encode(message));
			await flush();
		}
		const chat = latest()?.agentChats.get('terminal-key-1');
		expect({
			attach: shapeOf(sent.agent![0]),
			messages: chat?.messages.map(message => `${message.rev}:${message.kind}`),
			capabilities: chat?.capabilities,
		}).toEqual({
			attach: shapeOf(agentGolden.toPc[0]),
			messages: ['0:text', '1:tool_use', '2:tool_result'],
			capabilities: { agentActions: true, claudeSettings: true },
		});
		controller.disconnect();
	});

	it('公開の送信口: requestPc は PC の応答で resolve / reject し、id の無い知らせは onPcMessage へ届く', async () => {
		const { controller, pcMux, sent } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		const pushed: PcPushMessage[] = [];
		const subscription = controller.onPcMessage('scm', message => pushed.push(message));
		const ok = controller.requestPc<{ t: string; ok: boolean }>('scm', { t: 'goldenPush', ws: '1:repo', remote: 'origin', id: 'spoofed' });
		const failed = controller.requestPc('scm', { t: 'goldenWsLess' }).then(() => 'resolved', (error: Error) => error.message);
		await flush();
		const [first, second] = sent.scm!;
		pcMux.send(Channels.Scm, encode({ t: 'goldenProgress', step: 1 }));
		pcMux.send(Channels.Scm, encode({ id: first?.id, t: 'goldenPush', ok: true }));
		pcMux.send(Channels.Scm, encode({ id: second?.id, error: 'rejected by PC' }));
		await flush();
		subscription.dispose();
		pcMux.send(Channels.Scm, encode({ t: 'goldenProgress', step: 2 }));
		await flush();
		expect({
			request: first !== undefined ? { ...first, id: typeof first.id === 'string' && first.id !== 'spoofed' } : undefined,
			// ws を付けない要求はスペースを選ばず、ウィンドウ宛て（rendererGeneration）で送る
			wsLess: second,
			ok: await ok,
			failed: await failed,
			pushed,
		}).toEqual({
			request: { id: true, t: 'goldenPush', ws: 'repo', remote: 'origin', protocolVersion: 3, desktopEpoch: 'golden-desktop-epoch', windowId: 1 },
			wsLess: { id: second?.id, t: 'goldenWsLess', protocolVersion: 3, desktopEpoch: 'golden-desktop-epoch', windowId: 1, rendererGeneration: 2 },
			ok: { id: first?.id, t: 'goldenPush', ok: true },
			failed: 'rejected by PC',
			pushed: [{ t: 'goldenProgress', step: 1 }],
		});
		controller.disconnect();
	});
});
