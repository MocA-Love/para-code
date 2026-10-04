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
import { MobileController, type AgentQuestionAnswer, type PcPushMessage, type StoreState } from './store.js';
import type { PairedCredentials, SocketLike } from './relayClient.js';
import { PcCapability, stateRequestFields } from './pcCompat.js';
import { parseApprovalOptionsReply } from './approvalOptions.js';

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
	const sent: Record<string, Record<string, unknown>[]> = { state: [], term: [], agent: [], scm: [], browser: [], fs: [] };
	const pcMuxPromise = drivePc(pair, pc, mobile.publicKey, mux => {
		mux.on(Channels.State, frame => sent.state!.push(decode(frame.payload)));
		mux.on(Channels.Terminal, frame => sent.term!.push(decode(frame.payload)));
		mux.on(Channels.Agent, frame => sent.agent!.push(decode(frame.payload)));
		mux.on(Channels.Scm, frame => sent.scm!.push(decode(frame.payload)));
		mux.on(Channels.Browser, frame => sent.browser!.push(decode(frame.payload)));
		mux.on(Channels.Fs, frame => sent.fs!.push(decode(frame.payload)));
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
const agentGolden = readGolden<{ toPc: Golden[]; toMobile: Golden[]; approval: { delta: Golden } }>('agent.json');
const agentApprovalGolden = agentGolden.approval;
const browserGolden = readGolden<{ toPc: Golden[]; toMobile: Golden[]; bookmarks: { toPc: Golden; toMobile: Golden; push: Golden } }>('browser.json');

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

	it('term: PC の viewport-revoked で寸法の申告を止め、［再び合わせる］はゴールデンと同じ形で送る（W2-19）', async () => {
		const { controller, pcMux, sent } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		const changes: Array<[string, boolean]> = [];
		controller.onTerminalViewportRevoked((terminalKey, revoked) => changes.push([terminalKey, revoked]));
		controller.setTerminalViewport({ cols: 54, rows: 28 });
		controller.subscribeTerminal('terminal-key-1', () => { });
		controller.attachTerminal('terminal-key-1');
		await flush();
		pcMux.send(Channels.Terminal, encode(termGolden.toMobile.find(message => message.t === 'viewport-revoked')));
		await flush();
		const before = sent.term!.length;
		// 戻された後は、寸法が変わっても再 attach（取りこぼしからの復旧）でも申告しない。
		controller.setTerminalViewport({ cols: 50, rows: 20 });
		controller.attachTerminal('terminal-key-1');
		await flush();
		const whileRevoked = sent.term!.slice(before).map(message => ({ t: message.t, declared: message.viewCols !== undefined }));
		const revokedFlag = controller.isTerminalViewportRevoked('terminal-key-1');
		controller.reclaimTerminalViewport('terminal-key-1');
		await flush();
		const reclaim = sent.term!.at(-1);
		expect({
			changes,
			whileRevoked,
			revokedFlag,
			reclaim: shapeOf(reclaim),
			reclaimed: { viewCols: reclaim?.viewCols, reclaim: reclaim?.reclaim },
			afterReclaim: controller.isTerminalViewportRevoked('terminal-key-1'),
		}).toEqual({
			changes: [['terminal-key-1', true], ['terminal-key-1', false]],
			whileRevoked: [{ t: 'attach', declared: false }],
			revokedFlag: true,
			reclaim: shapeOf(termGolden.toPc.find(message => message.t === 'viewport' && message.reclaim === true)),
			reclaimed: { viewCols: 50, reclaim: true },
			afterReclaim: false,
		});
		// 申告していない（「スマホの幅に合わせる」をオフにした）ときも、［再び合わせる］は reclaim を送る。
		pcMux.send(Channels.Terminal, encode(termGolden.toMobile.find(message => message.t === 'viewport-revoked')));
		await flush();
		controller.setTerminalViewport(undefined);
		controller.reclaimTerminalViewport('terminal-key-1');
		await flush();
		const bare = sent.term!.at(-1);
		expect({ t: bare?.t, viewCols: bare?.viewCols, reclaim: bare?.reclaim }).toEqual({ t: 'viewport', viewCols: undefined, reclaim: true });
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
		const goldenDelta = agentGolden.toMobile.find(message => message.t === 'delta');
		const goldenMonitor = (goldenDelta?.['monitors'] as Golden[] | undefined)?.[0];
		expect({
			attach: shapeOf(sent.agent![0]),
			messages: chat?.messages.map(message => `${message.rev}:${message.kind}`),
			// 質問の選択肢の preview と、mod で答えられるか（agent.question.notes.v1）
			previews: chat?.messages.find(message => message.kind === 'question')?.options?.map(option => option.preview),
			interaction: chat?.interaction,
			capabilities: chat?.capabilities,
			// 任意項目の Monitor の一覧（agent.monitors.v1）を全項目のまま読み、時刻は monitorsAt との差で手元の時計へ直す
			// （直した量を引けばゴールデンと同じになる）
			monitors: chat?.monitors?.map(monitor => {
				const shift = monitor.startedAt - (goldenMonitor?.['startedAt'] as number);
				return { ...monitor, startedAt: monitor.startedAt - shift, ...(monitor.endedAt !== undefined ? { endedAt: monitor.endedAt - shift } : {}), output: monitor.output.map(line => ({ ...line, at: line.at - shift })) };
			}),
			shifted: chat?.monitors?.[0] !== undefined && chat.monitors[0].startedAt !== goldenMonitor?.['startedAt'],
			// 任意項目: Para Code からの知らせ・Advisor の印・一覧の Advisor への相談
			notice: chat?.messages.filter(message => message.notice === true).map(message => [message.rev, message.noticeSource]),
			advisor: chat?.messages.filter(message => message.advisor !== undefined).map(message => [message.rev, message.advisor]),
			advisors: chat?.activity?.advisors,
		}).toEqual({
			attach: shapeOf(agentGolden.toPc[0]),
			messages: ['0:text', '1:tool_use', '2:tool_result', '3:tool_use', '4:tool_result', '5:text', '6:question', '7:text'],
			previews: ['# Toast\n\n+----------------------+\n| Connection failed    |\n+----------------------+', '# Inline'],
			interaction: { kind: 'question', id: 'question-1', answerVia: 'mod' },
			// noticeSource: 'command' はスラッシュコマンドの出力（読み上げの文言を分ける）
			notice: [[5, undefined], [7, 'command']],
			advisor: [[3, { model: 'claude-opus-5-5' }], [4, { model: 'claude-opus-5-5', outcome: 'redacted' }]],
			advisors: (goldenDelta?.['activity'] as Golden | undefined)?.['advisors'],
			capabilities: { agentActions: true, claudeSettings: true },
			monitors: goldenDelta?.['monitors'],
			shifted: true,
		});
		controller.disconnect();
	});

	it('agent: 「質問に答えずに話す」の要求はゴールデンと同じ形で、取り下げるだけで途中の回答も無ければ項目を省く', async () => {
		const { controller, pcMux, sent } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		controller.attachAgent('terminal-key-1');
		await flush();
		for (const message of agentGolden.toMobile.filter(candidate => candidate.t === 'snapshot' || candidate.t === 'delta')) {
			pcMux.send(Channels.Agent, encode(message));
			await flush();
		}
		const clarifies = agentGolden.toPc.filter(message => message.t === 'action/clarifyQuestion');
		const sentClarify = () => sent.agent!.filter(message => message.t === 'action/clarifyQuestion').at(-1);
		void controller.clarifyAgentQuestion('terminal-key-1', 'question-1', clarifies[0]?.['response'] as string, []);
		await flush();
		const withMessage = sentClarify();
		void controller.clarifyAgentQuestion('terminal-key-1', 'question-1', undefined, clarifies[1]?.['answers'] as AgentQuestionAnswer[]);
		await flush();
		const withAnswers = sentClarify();
		void controller.clarifyAgentQuestion('terminal-key-1', 'question-1', undefined, []);
		await flush();
		const bare = sentClarify();
		expect({
			withMessage: shapeOf(withMessage),
			withAnswers: shapeOf(withAnswers),
			values: [withMessage?.['response'], withAnswers?.['answers']],
			bareKeys: Object.keys(bare ?? {}).filter(key => key === 'response' || key === 'answers'),
		}).toEqual({
			withMessage: shapeOf(clarifies[0]),
			withAnswers: shapeOf(clarifies[1]),
			values: [clarifies[0]?.['response'], clarifies[1]?.['answers']],
			bareKeys: [],
		});
		controller.disconnect();
	});

	it('agent: バックグラウンドのシェル（agent.shells.v1）を読み、出力と停止の要求はゴールデンと同じ形で送る', async () => {
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
		const goldenDelta = agentGolden.toMobile.find(message => message.t === 'delta');
		const goldenShells = goldenDelta?.['shells'] as Golden[] | undefined;
		const outputRequest = agentGolden.toPc.find(message => message.t === 'shell-output');
		const outputReply = agentGolden.toMobile.find(message => message.t === 'shell-output');
		const reading = controller.requestAgentShellOutput('terminal-key-1', outputRequest?.['shellIds'] as string[], outputRequest?.['lines'] as number);
		await flush();
		const sentOutput = sent.agent!.filter(message => message.t === 'shell-output').at(-1);
		pcMux.send(Channels.Agent, encode({ ...outputReply, requestId: sentOutput?.['requestId'] }));
		const read = await reading;
		const stopping = controller.stopAgentShell('terminal-key-1', 'bgolden03');
		await flush();
		const sentStop = sent.agent!.filter(message => message.t === 'action/stopShell').at(-1);
		pcMux.send(Channels.Agent, encode({ t: 'action-result', id: 7, token: 'agent-token-1', requestId: sentStop?.['requestId'], status: 'accepted' }));
		const shift = (chat?.shells?.[0]?.startedAt ?? 0) - (goldenShells?.[0]?.['startedAt'] as number);
		expect({
			// 全項目のまま読み、時刻は shellsAt との差で手元の時計へ直す（直した量を引けばゴールデンと同じ）
			shells: chat?.shells?.map(shell => ({ ...shell, startedAt: shell.startedAt - shift, ...(shell.endedAt !== undefined ? { endedAt: shell.endedAt - shift } : {}) })),
			access: chat?.shellsAccess,
			outputRequest: shapeOf(sentOutput),
			outputValues: [sentOutput?.['shellIds'], sentOutput?.['lines']],
			outputs: [...read.outputs.entries()],
			stopRequest: shapeOf(sentStop),
			stopped: await stopping,
		}).toEqual({
			shells: goldenShells,
			access: goldenDelta?.['shellsAccess'],
			outputRequest: shapeOf(outputRequest),
			outputValues: [outputRequest?.['shellIds'], outputRequest?.['lines']],
			outputs: [['bgolden02', { lines: ['VITE v6.2.0 ready in 412 ms', '[killed]'], truncated: true }], ['bgolden03', { lines: [], truncated: false, error: 'not-found' }]],
			stopRequest: shapeOf(agentGolden.toPc.find(message => message.t === 'action/stopShell')),
			stopped: { status: 'accepted' },
		});
		controller.disconnect();
	});

	it('agent: コマンドの一覧（agent.commands.v2）はゴールデンと同じ形で求め、重なりと出どころを読み、断りの理由を返す', async () => {
		const { controller, pcMux, sent, latest } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		controller.attachAgent('terminal-key-1');
		await flush();
		pcMux.send(Channels.Agent, encode(agentGolden.toMobile.find(message => message.t === 'snapshot')));
		await flush();
		controller.requestAgentCommandCatalog('terminal-key-1');
		await flush();
		const sentCatalog = sent.agent!.filter(message => message.t === 'command-catalog').at(-1);
		const goldenCatalog = agentGolden.toMobile.find(message => message.t === 'command-catalog');
		pcMux.send(Channels.Agent, encode({ ...goldenCatalog, requestId: sentCatalog?.['requestId'] }));
		await flush();
		const sending = controller.sendAgentMessage('terminal-key-1', '/nonexistent');
		await flush();
		const sentMessage = sent.agent!.filter(message => message.t === 'action/sendMessage').at(-1);
		const goldenRejected = agentGolden.toMobile.find(message => message.t === 'action-result' && message['code'] === 'unknown-command' && message['late'] !== true);
		pcMux.send(Channels.Agent, encode({ ...goldenRejected, requestId: sentMessage?.['requestId'] }));
		expect({
			request: shapeOf(sentCatalog),
			format: sentCatalog?.['format'],
			catalog: latest()?.agentChats.get('terminal-key-1')?.commandCatalog,
			rejected: await sending,
		}).toEqual({
			request: shapeOf(agentGolden.toPc.find(message => message.t === 'command-catalog')),
			format: 2,
			catalog: { status: 'ready', commands: goldenCatalog?.['commands'] },
			rejected: { status: 'rejected', code: 'unknown-command', message: goldenRejected?.['message'] },
		});
		controller.disconnect();
	});

	it('agent: 受け付けた後で届いた断り（late: true）を、送ったスラッシュコマンドの文と一緒に会話の状態へ載せる', async () => {
		const { controller, pcMux, sent, latest } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		controller.attachAgent('terminal-key-1');
		await flush();
		pcMux.send(Channels.Agent, encode(agentGolden.toMobile.find(message => message.t === 'snapshot')));
		await flush();
		const sending = controller.sendAgentMessage('terminal-key-1', '/nonexistent');
		const plain = controller.sendAgentMessage('terminal-key-1', '続けて');
		await flush();
		const [slashSent, plainSent] = sent.agent!.filter(message => message.t === 'action/sendMessage');
		pcMux.send(Channels.Agent, encode({ t: 'action-result', id: 7, token: 'agent-token-1', requestId: slashSent?.['requestId'], status: 'accepted' }));
		pcMux.send(Channels.Agent, encode({ t: 'action-result', id: 7, token: 'agent-token-1', requestId: plainSent?.['requestId'], status: 'accepted' }));
		const accepted = [await sending, await plain];
		const late = agentGolden.toMobile.find(message => message.t === 'action-result' && message['late'] === true);
		// 発言（スラッシュコマンドでない）への遅い断りは捨てる
		pcMux.send(Channels.Agent, encode({ ...late, requestId: plainSent?.['requestId'] }));
		pcMux.send(Channels.Agent, encode({ ...late, requestId: slashSent?.['requestId'] }));
		await flush();
		const rejection = latest()?.agentChats.get('terminal-key-1')?.slashRejection;
		controller.clearAgentSlashRejection('terminal-key-1', String(slashSent?.['requestId']));
		await flush();
		expect({ accepted, rejection, cleared: latest()?.agentChats.get('terminal-key-1')?.slashRejection }).toEqual({
			accepted: [{ status: 'accepted' }, { status: 'accepted' }],
			rejection: { requestId: slashSent?.['requestId'], text: '/nonexistent', message: late?.['message'] },
			cleared: undefined,
		});
		controller.disconnect();
	});

	it('agent: 受け付けより先に届いた遅い断り（late: true）で、待っている送信を断りとして終える', async () => {
		const { controller, pcMux, sent } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		controller.attachAgent('terminal-key-1');
		await flush();
		pcMux.send(Channels.Agent, encode(agentGolden.toMobile.find(message => message.t === 'snapshot')));
		await flush();
		const sending = controller.sendAgentMessage('terminal-key-1', '/nonexistent');
		await flush();
		const slashSent = sent.agent!.filter(message => message.t === 'action/sendMessage').at(-1);
		const late = agentGolden.toMobile.find(message => message.t === 'action-result' && message['late'] === true);
		pcMux.send(Channels.Agent, encode({ ...late, requestId: slashSent?.['requestId'] }));
		pcMux.send(Channels.Agent, encode({ t: 'action-result', id: 7, token: 'agent-token-1', requestId: slashSent?.['requestId'], status: 'accepted' }));
		expect(await sending).toEqual({ status: 'rejected', code: 'unknown-command', message: late?.['message'] });
		controller.disconnect();
	});

	it('agent: 承認の中身（agent.approval.detail.v1）を全項目のまま読み、指示を添えた拒否はゴールデンと同じ形で送る', async () => {
		const { controller, pcMux, sent, latest } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		controller.attachAgent('terminal-key-1');
		await flush();
		for (const message of [...agentGolden.toMobile.filter(candidate => candidate.t === 'snapshot' || candidate.t === 'delta'), agentApprovalGolden.delta]) {
			pcMux.send(Channels.Agent, encode(message));
			await flush();
		}
		const interaction = latest()?.agentChats.get('terminal-key-1')?.interaction;
		const goldenDeny = agentGolden.toPc.find(message => message.t === 'action/answerApproval' && message['message'] !== undefined);
		void controller.answerAgentApproval('terminal-key-1', 'approval-2', 'no', undefined, goldenDeny?.['message'] as string);
		await flush();
		const sentDeny = sent.agent!.filter(message => message.t === 'action/answerApproval').at(-1);
		// 許可に指示は添えられない（送らずに断る）
		const allowWithMessage = await controller.answerAgentApproval('terminal-key-1', 'approval-2', 'yes', undefined, 'これも');
		// 長すぎる指示は、長さが原因だと分かる文言で断る（送らない）
		const tooLong = await controller.answerAgentApproval('terminal-key-1', 'approval-2', 'no', undefined, 'x'.repeat(4_001));
		expect({
			interaction,
			deny: shapeOf(sentDeny),
			denyValues: [sentDeny?.['choice'], sentDeny?.['message']],
			allowWithMessage: allowWithMessage.status,
			tooLong: [tooLong.status, tooLong.status === 'rejected' && tooLong.message?.startsWith('指示が長すぎます')],
			warning: parseApprovalOptionsReply(agentGolden.toMobile.find(message => message.t === 'approval-options') ?? {})?.warning,
		}).toEqual({
			interaction: agentApprovalGolden.delta['interaction'],
			deny: shapeOf(goldenDeny),
			denyValues: ['no', goldenDeny?.['message']],
			allowWithMessage: 'rejected',
			tooLong: ['rejected', true],
			warning: agentGolden.toMobile.find(message => message.t === 'approval-options')?.['warning'],
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
	it('browser: スペースで絞る targets・新しい入力はゴールデンと同じ形で、PC の page / focus / bookmarks を受け付ける', async () => {
		const { controller, pcMux, sent, latest } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.current));
		await flush();
		const workspace = (stateGolden.current['workspaces'] as Golden[])[0]!;
		// targets: browser.space.v1 の PC にはスペースを付けて頼み、応答の scoped を読む。
		const targets = controller.browserTargets({ windowId: workspace['windowId'] as number, ws: workspace['sourceId'] as string });
		await flush();
		const targetsRequest = sent.browser!.find(message => message.t === 'targets');
		const goldenTargets = browserGolden.toMobile.find(message => message.t === 'targets')!;
		pcMux.send(Channels.Browser, encode({ ...goldenTargets, id: targetsRequest?.id }));
		const targetsResult = await targets;
		// 入力: open / stop / replace / navigate。
		for (const message of browserGolden.toPc.filter(candidate => candidate.t === 'input')) {
			const { t: _t, ...input } = message;
			controller.browserInput(input as unknown as Parameters<MobileController['browserInput']>[0]);
		}
		await flush();
		// 通知: page と focus（新しい番号のものだけ受ける）。
		for (const message of browserGolden.toMobile.filter(candidate => candidate.t === 'page' || candidate.t === 'focus')) {
			pcMux.send(Channels.Browser, encode(message));
			await flush();
		}
		pcMux.send(Channels.Browser, encode({ ...browserGolden.toMobile.find(message => message.t === 'focus'), seq: 1 }));
		await flush();
		pcMux.send(Channels.Browser, encode(browserGolden.toMobile.find(message => message.t === 'inputRejected')));
		await flush();
		// ブックマーク: 要求はゴールデンと同じ形、変わったら fs の id なしの知らせが届く。
		const pushed: string[] = [];
		controller.onPcMessage('fs', message => pushed.push(message.t));
		const bookmarks = controller.browserBookmarks();
		await flush();
		const bookmarksRequest = sent.fs!.find(message => message.t === 'bookmarks');
		pcMux.send(Channels.Fs, encode({ ...browserGolden.bookmarks.toMobile, id: bookmarksRequest?.id }));
		const bookmarksResult = await bookmarks;
		pcMux.send(Channels.Fs, encode(browserGolden.bookmarks.push));
		await flush();
		const { id: _goldenBookmarksId, ...goldenBookmarks } = browserGolden.bookmarks.toMobile;
		expect({
			targetsRequest: shapeOf(targetsRequest),
			targetsScope: { windowId: targetsRequest?.windowId, ws: targetsRequest?.ws },
			targetsResult,
			inputs: sent.browser!.filter(message => message.t === 'input'),
			page: latest()?.browserPage,
			focus: latest()?.browserFocus,
			rejected: latest()?.browserInputRejected,
			bookmarksRequest: shapeOf(bookmarksRequest),
			bookmarksResult,
			pushed,
		}).toEqual({
			targetsRequest: shapeOf(browserGolden.toPc.find(message => message.t === 'targets')),
			targetsScope: { windowId: browserGolden.toPc[0]!['windowId'], ws: browserGolden.toPc[0]!['ws'] },
			targetsResult: { targets: goldenTargets['targets'], scoped: true },
			inputs: browserGolden.toPc.filter(message => message.t === 'input'),
			page: browserGolden.toMobile.find(message => message.t === 'page'),
			focus: browserGolden.toMobile.filter(message => message.t === 'focus').at(-1),
			rejected: { ...browserGolden.toMobile.find(message => message.t === 'inputRejected'), n: 1 },
			bookmarksRequest: shapeOf({ ...browserGolden.bookmarks.toPc, protocolVersion: 3, desktopEpoch: 'e', windowId: 1, rendererGeneration: 2 }),
			bookmarksResult: goldenBookmarks,
			pushed: ['bookmarksChanged'],
		});
		controller.disconnect();
	});

	it('browser: browser.space.v1 の無い PC には targets にスペースを付けない', async () => {
		const { controller, pcMux, sent } = await connect();
		pcMux.send(Channels.State, encode(stateGolden.preW217));
		await flush();
		void controller.browserTargets({ windowId: 1, ws: 'repo' }).catch(() => undefined);
		await flush();
		const request = sent.browser!.find(message => message.t === 'targets');
		expect({ windowId: request?.windowId, ws: request?.ws }).toEqual({ windowId: undefined, ws: undefined });
		controller.disconnect();
	});
});
