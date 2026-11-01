// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ITaskBoardQuestion, ITaskBoardStep, ITaskBoardTask, TaskBoardAgentKind } from '@engine/paradisTaskBoard.js';
import type { ITaskBoardAgentPort, ITaskBoardArtifactInput, TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';
import type { TaskBoardArtifactKind } from '@engine/paradisTaskBoard.js';

/*
 * 本物の Claude Code / Codex を、Para Code 本体のボード用の口（bridge）を通して動かす。
 *
 * Para Code の shared process が 127.0.0.1 に HTTP を立て、`<userData>/paradis-taskboard-bridge.json` に
 * ポートとトークンを書く。ここではそれを読んで、起動・入力・回答を送り、状態の変化を SSE で受け取る。
 *
 * エージェントからの報告（complete_step / ask_human）は para-browser の MCP ツールとして Para Code が受け、
 * `report` イベントで届く。返事は /v1/reply で返す。
 *
 * 同じタスクのエージェント工程は、同じ種類のエージェントなら同じターミナルで続ける（調べた内容を次の工程に持ち越すため）。
 * 前の工程のターンがまだ終わっていなければ、次の指示はターンの終わり（idle / review）まで預かってから送る。
 */

export type ParaCodeTerminalStatus = 'working' | 'question' | 'permission' | 'review' | 'idle' | 'exited';

interface IBridgeInfo {
	readonly port: number;
	readonly token: string;
	readonly pid?: number;
	readonly file: string;
}

interface IBridgeQuestion {
	readonly text: string;
	readonly options: readonly { readonly label: string; readonly detail?: string }[];
	readonly allowText: boolean;
}

/** SSH の中継の工程のコマンドの出力と終わり（そのボードにだけ届く）。 */
export type ParaCodeRelayEvent =
	| { type: 'relay-output'; runId: string; lines: readonly string[] }
	| { type: 'relay-exit'; runId: string; code: number | null; signal: string | null; cancelled: boolean; timedOut: boolean; reason?: string };

export type ParaCodeBridgeEvent =
	| { type: 'status'; terminal: string; launchId?: string; status: ParaCodeTerminalStatus; question?: IBridgeQuestion }
	| { type: 'tool'; terminal: string; name: string; detail?: string }
	| { type: 'output'; terminal: string; lines: readonly string[] }
	| { type: 'report'; terminal: string; replyId: string; tool: 'complete_step' | 'ask_human'; args: Record<string, unknown> };

export class ParaCodeBridgeError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
		this.name = 'ParaCodeBridgeError';
	}
}

/** Para Code のユーザーデータの場所の候補（配布版、開発版の順）。 */
export function paraCodeDataDirectories(): string[] {
	const home = os.homedir();
	const base = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
		: process.platform === 'win32' ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
			: (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
	const roots = process.env.VSCODE_APPDATA ? [process.env.VSCODE_APPDATA, base] : [base];
	return roots.flatMap(root => ['Para Code', 'code-oss-dev'].map(name => path.join(root, name)));
}

/** bridge の情報ファイルの候補（新しい順に試す）。`--bridge` で場所を指定できる。 */
export function bridgeFileCandidates(explicit?: string): string[] {
	if (explicit) {
		return [path.resolve(explicit)];
	}
	return paraCodeDataDirectories().map(dir => path.join(dir, 'paradis-taskboard-bridge.json'));
}

function processAlive(pid: number | undefined): boolean {
	if (!pid) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** 生きている Para Code の bridge を探す。複数あれば、いちばん新しく書かれたもの。 */
export function findBridge(explicit?: string): IBridgeInfo | undefined {
	const found: (IBridgeInfo & { mtime: number })[] = [];
	for (const file of bridgeFileCandidates(explicit)) {
		if (!existsSync(file)) {
			continue;
		}
		try {
			const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; port?: number; token?: string; pid?: number };
			if (raw.version !== 1 || typeof raw.port !== 'number' || typeof raw.token !== 'string' || !processAlive(raw.pid)) {
				continue;
			}
			found.push({ port: raw.port, token: raw.token, pid: raw.pid, file, mtime: statSync(file).mtimeMs });
		} catch {
			// 書きかけ・壊れたファイルは飛ばす
		}
	}
	return found.sort((a, b) => b.mtime - a.mtime)[0];
}

const SSE_CONNECT_TIMEOUT_MS = 10_000;
const SSE_IDLE_TIMEOUT_MS = 45_000;

/** bridge への HTTP と SSE。Para Code が再起動してポートやトークンが変わっても、ファイルを読み直してつなぎ直す。 */
export class ParaCodeBridgeClient {
	private info: IBridgeInfo | undefined;
	private abort: AbortController | undefined;
	private disposed = false;
	private retryTimer: NodeJS.Timeout | undefined;
	private connected = false;

	constructor(
		private readonly options: {
			readonly bridgeFile?: string;
			/** 接続口へ `x-para-board-key` で送る鍵（Para Code が起動したボードだけが持つ）。 */
			readonly boardKey?: string;
			readonly onEvent: (event: ParaCodeBridgeEvent) => void;
			readonly onConnection: (connected: boolean, detail?: string) => void;
			readonly fetchImpl?: typeof fetch;
			/** テスト用に見張りの時間を縮める。 */
			readonly timeouts?: { readonly connect?: number; readonly idle?: number; readonly retry?: number };
		},
	) { }

	isConnected(): boolean {
		return this.connected;
	}

	private get fetch(): typeof fetch {
		return this.options.fetchImpl ?? fetch;
	}

	private resolve(): IBridgeInfo {
		this.info ??= findBridge(this.options.bridgeFile);
		if (!this.info) {
			throw new ParaCodeBridgeError(0, 'no-bridge', 'Para Code が起動していないか、タスクボードの接続が無効です（paradis.taskBoard.bridge.enabled）');
		}
		return this.info;
	}

	/** 発見ファイルの Bearer と、起動ごとの鍵（あれば）。接続口は両方を確かめる。 */
	private authHeaders(info: IBridgeInfo): Record<string, string> {
		return { authorization: `Bearer ${info.token}`, ...(this.options.boardKey !== undefined ? { 'x-para-board-key': this.options.boardKey } : {}) };
	}

	async request<T>(method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs = 30000): Promise<T> {
		if (this.disposed) {
			throw new ParaCodeBridgeError(0, 'disposed', 'タスクボードは止まっています');
		}
		const info = this.resolve();
		let res: Response;
		try {
			res = await this.fetch(`http://127.0.0.1:${info.port}${route}`, {
				method,
				headers: { ...this.authHeaders(info), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			if ((err as Error).name === 'TimeoutError') {
				throw new ParaCodeBridgeError(0, 'timeout', `Para Code の応答が ${Math.round(timeoutMs / 1000)} 秒以内にありませんでした`);
			}
			this.info = undefined;
			throw new ParaCodeBridgeError(0, 'network', `Para Code につながりません: ${(err as Error).message}`);
		}
		const text = await res.text();
		let data: Record<string, unknown> = {};
		try {
			data = text ? JSON.parse(text) as Record<string, unknown> : {};
		} catch {
			throw new ParaCodeBridgeError(res.status, 'bad-response', `Para Code の応答を読めません（HTTP ${res.status}）`);
		}
		if (!res.ok) {
			if (res.status === 401 || res.status === 403) {
				this.info = undefined;
			}
			throw new ParaCodeBridgeError(res.status, String(data.error ?? res.status), String(data.message ?? data.error ?? res.statusText));
		}
		return data as T;
	}

	/** SSE をつなぎ、切れたらつなぎ直す。 */
	start(): void {
		void this.listen();
	}

	private setConnected(value: boolean, detail?: string): void {
		if (this.connected !== value || detail) {
			this.connected = value;
			this.options.onConnection(value, detail);
		}
	}

	private scheduleRetry(ms: number): void {
		if (this.disposed) {
			return;
		}
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => void this.listen(), ms);
		this.retryTimer.unref?.();
	}

	private async listen(): Promise<void> {
		if (this.disposed) {
			return;
		}
		let info: IBridgeInfo;
		try {
			info = this.resolve();
		} catch (err) {
			this.setConnected(false, (err as Error).message);
			this.scheduleRetry(5000);
			return;
		}
		const abort = this.abort = new AbortController();
		// 応答の頭が来ない（起動の途中など）・ping が途切れた（相手が固まった、半開きの接続）ときは切ってつなぎ直す。
		// Para Code は 15 秒ごとに ping を送る
		let watchdog: NodeJS.Timeout | undefined;
		const arm = (ms: number) => {
			clearTimeout(watchdog);
			watchdog = setTimeout(() => abort.abort(new Error(`${Math.round(ms / 1000)} 秒応答がありません`)), ms);
			watchdog.unref?.();
		};
		arm(this.options.timeouts?.connect ?? SSE_CONNECT_TIMEOUT_MS);
		try {
			const res = await this.fetch(`http://127.0.0.1:${info.port}/v1/events`, {
				headers: { ...this.authHeaders(info), accept: 'text/event-stream' },
				signal: abort.signal,
			});
			if (!res.ok || !res.body) {
				if (res.status === 401 || res.status === 403) {
					this.info = undefined;
				}
				throw new Error(`HTTP ${res.status}`);
			}
			this.setConnected(true);
			arm(this.options.timeouts?.idle ?? SSE_IDLE_TIMEOUT_MS);
			const decoder = new TextDecoder();
			let buffer = '';
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				arm(this.options.timeouts?.idle ?? SSE_IDLE_TIMEOUT_MS);
				buffer += decoder.decode(chunk, { stream: true });
				let end: number;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
					if (!data) {
						continue; // `: ping` などの注釈
					}
					try {
						this.options.onEvent(JSON.parse(data) as ParaCodeBridgeEvent);
					} catch (err) {
						console.error('[taskboard] bridge event:', (err as Error).message);
					}
				}
			}
			throw new Error('closed');
		} catch (err) {
			clearTimeout(watchdog);
			if (this.disposed) {
				return;
			}
			this.info = undefined;
			this.setConnected(false, `Para Code との接続が切れました（${(err as Error).message}）`);
			this.scheduleRetry(this.options.timeouts?.retry ?? 3000);
		}
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retryTimer);
		this.abort?.abort();
	}
}

/* ---------------- エージェントの口 ---------------- */

/** ターミナルへ送る文。工程の指示は試行番号を持ち、回答や人の入力は持たない。 */
interface IOutgoing {
	readonly text: string;
	/** 工程の指示なら、その試行。送れたら sentAttempt になる。 */
	readonly attempt?: number;
	/** 人が送った入力（今の試行の続き）。送れたら sentAttempt を今の試行にする。 */
	readonly human?: boolean;
}

interface ITerminalLink {
	readonly terminal: string;
	readonly agent: TaskBoardAgentKind;
	readonly taskId: string;
	/** 起動したときの作業場所（中止して別の作業場所で着手し直したかを見分ける）。 */
	readonly place: string | undefined;
	/** このターミナルが今受け持つ試行。 */
	attempt: number;
	/**
	 * 指示を実際に送った試行。やり直しの直後は、前の試行のターンが終わるまで新しい指示を預かるので、
	 * その間に届いた complete_step は前の試行のものとして断る。
	 */
	sentAttempt: number;
	status: ParaCodeTerminalStatus;
	/** ターンの終わり（idle / review）まで預かっている文。工程の指示は 1 つだけ（新しいもので置き換える）。 */
	outbox: IOutgoing[];
	/** 送信の要求を出して返事を待っている。 */
	sending: boolean;
	/** 最後に文を送った時刻（送った直後は Para Code の状態がまだ前のままなので、突き合わせを控える）。 */
	sentAt?: number;
	/** 起動を頼んだがまだターミナルの id が返っていない。 */
	launching?: boolean;
	/** 起動を待つ間に手放された（起動し直し・中止）。起動が返ってきたら、そのターミナルは閉じて結び付けない。 */
	released?: boolean;
	/** 今の許可待ちは選択肢を持たない（許可する／拒否するをボードが補った）。回答は allow で送る。 */
	allowOnly?: boolean;
}

/** 選択肢の無い許可待ち（フォルダの信頼の確認など）にボードが補う選択肢。先頭が許可。 */
const ALLOW_OPTIONS = [{ label: '許可する' }, { label: '拒否する' }];

const KEY_MAP: Record<string, string> = {
	'Esc': 'escape', 'Enter': 'enter', '↑': 'up', '↓': 'down', 'Ctrl+C': 'ctrl_c', 'Tab': 'tab',
	'1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
};

const ARTIFACT_KINDS = new Set<TaskBoardArtifactKind>(['plan', 'mock', 'screenshot', 'report']);
/** 成果物 1 つの上限（エンジンの上限と同じ。画像は base64 にした後の大きさで比べる）。 */
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
/** 起動の待ち時間。Para Code 側の上限（150 秒）より長くする。 */
const LAUNCH_TIMEOUT_MS = 180_000;
const MAX_EARLY_TERMINALS = 20;

/** ターンが終わって、次の文を受け付けられる状態か。 */
function acceptsInput(status: ParaCodeTerminalStatus): boolean {
	return status === 'idle' || status === 'review';
}

function parseLaunchId(launchId: string): { taskId: string; attempt: number } | undefined {
	const at = launchId.lastIndexOf(':');
	const attempt = Number(launchId.slice(at + 1));
	return at > 0 && Number.isInteger(attempt) ? { taskId: launchId.slice(0, at), attempt } : undefined;
}

export interface IParaCodeAgentsOptions {
	readonly engine: () => TaskBoardEngine;
	/** 作業場所のディレクトリ（エンジンが貸した作業場所のパス）。 */
	readonly placePath: (task: ITaskBoardTask) => string | undefined;
	readonly bridgeFile?: string;
	/** 接続口へ送る、起動ごとの鍵。 */
	readonly boardKey?: string;
	/** SSH の窓のボードの中継のセッション（窓の再読み込みで変わる）。起動の依頼に添え、その窓で接続先の作業場所に担当を起こす。 */
	readonly relaySessionId?: () => string | undefined;
	/** SSH の窓のボードで、成果物のファイルを中継で読む（`.para/` の中だけ）。無ければ手元の fs で読む。 */
	readonly readArtifact?: (place: string, relativePath: string, maxBytes: number) => Promise<Buffer | undefined>;
	/** SSH の中継の工程のコマンドの出力と終わり（relay.ts の RemoteCommandRunner へ渡す）。 */
	readonly onRelayEvent?: (event: ParaCodeRelayEvent) => void;
	readonly onConnection?: (connected: boolean, detail?: string) => void;
	readonly fetchImpl?: typeof fetch;
	readonly timeouts?: { readonly connect?: number; readonly idle?: number; readonly retry?: number; readonly reconcile?: number; readonly stall?: number };
}

/**
 * ターンの終わり（入力待ち）を見てから「報告なしで止まった」とするまで待つ時間。hook の取りこぼしなどで
 * 一瞬だけ入力待ちに見えることがあるので、続いたときだけ止まったとする。
 */
const STALL_CONFIRM_MS = 6_000;

/** 状態の取りこぼしを直すために、Para Code のターミナルの一覧と突き合わせる間隔。 */
const RECONCILE_MS = 15_000;
/** 送ってからこの間は突き合わせない（hook が届いて Para Code の状態が作業中に変わるまでの猶予）。 */
const RECONCILE_SETTLE_MS = 10_000;

export class ParaCodeAgents implements ITaskBoardAgentPort {
	readonly client: ParaCodeBridgeClient;
	/** ターミナルの id → 結び付いたタスク。起動中は `pending:<launchId>` で持つ。 */
	private readonly links = new Map<string, ITerminalLink>();
	/** 起動の返事より先に届いた、まだ結び付いていないターミナルのイベント（返事が来たら流し直す）。 */
	private readonly early = new Map<string, ParaCodeBridgeEvent[]>();
	/** 結び付いていないターミナルの最新の状態（つなぎ直しで結び直したときに反映する）。 */
	private readonly unknownStatus = new Map<string, Extract<ParaCodeBridgeEvent, { type: 'status' }>>();
	/** つなぎ直した直後、一覧を取って結び直している間（届いた報告を捨てずに預かる）。 */
	private relinking = false;
	private disposed = false;

	constructor(private readonly options: IParaCodeAgentsOptions) {
		this.client = new ParaCodeBridgeClient({
			bridgeFile: options.bridgeFile,
			boardKey: options.boardKey,
			fetchImpl: options.fetchImpl,
			timeouts: options.timeouts,
			onEvent: event => {
				const relayEvent = event as unknown as ParaCodeRelayEvent;
				if (relayEvent.type === 'relay-output' || relayEvent.type === 'relay-exit') {
					options.onRelayEvent?.(relayEvent);
					return;
				}
				this.onEvent(event);
			},
			onConnection: (connected, detail) => {
				if (connected) {
					void this.relink();
				}
				options.onConnection?.(connected, detail);
			},
		});
	}

	private reconcileTimer: NodeJS.Timeout | undefined;

	start(): void {
		this.client.start();
		// 状態の変化は SSE で届くが、短いターン（すぐ終わる指示など）は Para Code の見張りの間に始まって終わり、
		// 変化として流れてこないことがある。送った後に「作業中」と見なしたままにならないよう、一覧の状態と突き合わせる
		this.reconcileTimer = setInterval(() => void this.reconcile(), this.options.timeouts?.reconcile ?? RECONCILE_MS);
		this.reconcileTimer.unref?.();
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.reconcileTimer);
		this.client.dispose();
	}

	private async reconcile(): Promise<void> {
		if (!this.client.isConnected() || ![...this.links.values()].some(l => !l.launching)) {
			return;
		}
		let list: { terminals: { terminal: string; status: ParaCodeTerminalStatus }[] };
		try {
			list = await this.client.request('GET', '/v1/terminals');
		} catch {
			return;
		}
		const statuses = new Map((list.terminals ?? []).map(t => [t.terminal, t.status]));
		for (const link of [...this.links.values()]) {
			if (link.launching || link.sending || (link.sentAt !== undefined && Date.now() - link.sentAt < RECONCILE_SETTLE_MS)) {
				continue;
			}
			const status = statuses.get(link.terminal) ?? 'exited';
			if (status !== link.status) {
				this.onStatus(link, status, undefined);
			}
		}
	}

	private get engine(): TaskBoardEngine {
		return this.options.engine();
	}

	private linkOf(task: ITaskBoardTask): ITerminalLink | undefined {
		for (const link of this.links.values()) {
			if (link.taskId === task.id) {
				return link;
			}
		}
		return undefined;
	}

	private launchingAny(): boolean {
		for (const link of this.links.values()) {
			if (link.launching) {
				return true;
			}
		}
		return false;
	}

	/** 画面に出す一言（ターミナルの出力欄）。 */
	private note(taskId: string, text: string): void {
		this.engine.reportOutput(taskId, [`● ${text}`]);
	}

	/* ---- エンジンから ---- */

	startStep(task: ITaskBoardTask, step: ITaskBoardStep, prompt: string): void {
		if (this.disposed) {
			return; // 止めた後（開き直した後）は、エージェントに触らない
		}
		const agent: TaskBoardAgentKind = task.agent ?? 'claude';
		const link = this.linkOf(task);
		if (link && link.agent === agent && link.status !== 'exited' && link.place === task.place) {
			// 同じエージェントで続ける。ターンの途中なら終わるまで預かる
			link.attempt = task.attempt;
			link.outbox = [...link.outbox.filter(o => o.attempt === undefined && !o.human), { text: prompt, attempt: task.attempt }];
			if (link.launching || link.sending || !acceptsInput(link.status)) {
				this.note(task.id, `${step.name}の指示は、今のターンが終わったら送ります`);
				return;
			}
			this.flush(link);
			return;
		}
		if (link) {
			void this.close(link);
		}
		void this.launch(task, step, agent, prompt);
	}

	private async launch(task: ITaskBoardTask, step: ITaskBoardStep, agent: TaskBoardAgentKind, prompt: string): Promise<void> {
		const launchAttempt = task.attempt;
		const place = task.place;
		const repoPath = this.options.placePath(task);
		if (!repoPath) {
			this.engine.reportAgentError(task.id, launchAttempt, '作業場所のディレクトリが分かりません');
			return;
		}
		const launchId = `${task.id}:${launchAttempt}`;
		const placeholder: ITerminalLink = { terminal: `pending:${launchId}`, agent, taskId: task.id, place, attempt: launchAttempt, sentAttempt: launchAttempt, status: 'working', outbox: [], sending: false, launching: true };
		this.links.set(placeholder.terminal, placeholder);
		this.engine.reportOutput(task.id, [`${repoPath} $ ${agent}`, `› ${prompt}`]);
		let terminal: string | undefined;
		let failure: Error | undefined;
		try {
			terminal = (await this.client.request<{ terminal: string }>('POST', '/v1/launch', { launchId, repoPath, agent, prompt, ...(this.options.relaySessionId?.() ? { relaySessionId: this.options.relaySessionId() } : {}) }, LAUNCH_TIMEOUT_MS)).terminal;
		} catch (err) {
			failure = err as Error;
			// 返事が途切れても、Para Code 側では起動していることがある。起動 id で探して、あれば結び付ける
			terminal = await this.client.request<{ terminals: { terminal: string; launchId?: string }[] }>('GET', '/v1/terminals')
				.then(r => r.terminals?.find(t => t.launchId === launchId)?.terminal, () => undefined);
		}
		this.links.delete(placeholder.terminal);
		const early = terminal ? this.early.get(terminal) ?? [] : [];
		if (terminal) {
			this.early.delete(terminal);
		}
		if (!this.launchingAny() && !this.relinking) {
			this.dropEarly();
		}
		if (!terminal) {
			// 起動を待つ間にやり直されていれば、placeholder は新しい試行を指している
			this.engine.reportAgentError(task.id, placeholder.attempt, launchErrorText(failure?.message));
			return;
		}
		const link: ITerminalLink = { ...placeholder, terminal, launching: false };
		if (placeholder.released) {
			// 起動を待つ間に「起動し直す」や中止で手放された。遅れて起きたターミナルは閉じ、結び付けない
			await this.close(link);
			return;
		}
		this.links.set(terminal, link);
		const current = this.engine.getTask(task.id);
		if (!current || current.step === 'todo' || current.step === 'done' || current.place !== place) {
			// 起動を待つ間に中止された（または別の作業場所で着手し直した）
			await this.close(link);
			return;
		}
		this.engine.reportMessage(task.id, link.attempt, `${step.name}を始めました（Para Code のターミナル）`);
		for (const event of early) {
			this.onEvent(event);
		}
		if (link.outbox.length && acceptsInput(link.status)) {
			this.flush(link);
		}
	}

	/** 預かっている文を 1 つ送る。受け付けられなければ、次のターンの終わりまで預かり直す。 */
	private flush(link: ITerminalLink): void {
		const next = link.outbox.shift();
		if (!next || link.sending) {
			if (next) {
				link.outbox.unshift(next);
			}
			return;
		}
		void this.sendNow(link, next);
	}

	private async sendNow(link: ITerminalLink, item: IOutgoing): Promise<void> {
		let askAfter: 'question' | 'permission' | undefined;
		try {
			await this.sendOnce(link, item, kind => askAfter = kind);
		} finally {
			if (askAfter) {
				this.onStatus(link, askAfter, undefined);
			}
		}
	}

	private async sendOnce(link: ITerminalLink, item: IOutgoing, ask: (kind: 'question' | 'permission') => void): Promise<void> {
		link.sending = true;
		// 送っている間に止められたら Escape を送れるよう、先に作業中とみなす
		const before = link.status;
		link.status = 'working';
		try {
			// 工程の指示と人の入力には、今の試行の印を付ける（ボードが再起動したとき、この印で結び直す）
			const tag = item.attempt !== undefined ? `${link.taskId}:${item.attempt}` : item.human ? `${link.taskId}:${link.attempt}` : undefined;
			await this.client.request('POST', '/v1/send', { terminal: link.terminal, text: item.text, submit: true, ...(tag ? { tag } : {}) });
			link.sentAt = Date.now();
			if (item.attempt !== undefined ? link.attempt === item.attempt : item.human) {
				link.sentAttempt = link.attempt;
			}
		} catch (err) {
			const e = err as ParaCodeBridgeError;
			const retryLater = (e.status === 409 && e.code !== 'exited') || e.code === 'unavailable' || e.code === 'network' || e.code === 'timeout';
			if (retryLater) {
				// まだ受け付けられない（作業中・質問や許可の答え待ち・ウィンドウの再読み込み中・接続の切れ目）。
				// 次のターンの終わり（または突き合わせ）で送り直す
				link.status = e.code === 'question' || e.code === 'permission' ? e.code : before === 'idle' || before === 'review' ? 'working' : before;
				if (item.attempt === undefined || item.attempt === link.attempt) {
					link.outbox.unshift(item);
				}
				if (e.code === 'question' || e.code === 'permission') {
					// 画面に確認が出ている。人に答えてもらえるよう、ボードにも質問として出す
					ask(e.code);
				}
				return;
			}
			if (e.code === 'exited' || e.code === 'not-found') {
				link.status = 'exited';
				this.links.delete(link.terminal);
			}
			if (item.attempt === undefined || item.attempt === link.attempt) {
				this.engine.reportAgentError(link.taskId, link.attempt, `送れませんでした: ${e.message}`);
			}
		} finally {
			link.sending = false;
		}
	}

	answer(task: ITaskBoardTask, question: ITaskBoardQuestion, answer: string): void {
		if (this.disposed) {
			return; // 止めた後（開き直した後）は、エージェントに触らない
		}
		const link = this.linkOf(task);
		if (!link) {
			this.note(task.id, 'エージェントのターミナルが見つからないため、回答を送れませんでした');
			this.engine.reportAnswerFailed(task.id, task.attempt, question, 'エージェントのターミナルが見つからないため、回答を送れませんでした');
			return;
		}
		if (question.origin === 'agent') {
			this.engine.reportOutput(task.id, [`› ${answer}`]);
			// ask_human の回答は次のメッセージとして送る。ターンがまだ終わっていなければ預かる
			link.outbox.push({ text: answer });
			if (!link.launching && acceptsInput(link.status)) {
				this.flush(link);
			}
			return;
		}
		// 画面の質問・許可への回答は発言ではないので、送った文と見分けられる印で残す
		this.engine.reportOutput(task.id, [`◆ ${question.kind === 'permission' ? '許可の確認' : '画面の質問'}に回答: ${answer}`]);
		const index = question.options.findIndex(o => o.label === answer);
		const allowOnly = question.kind === 'permission' && link.allowOnly;
		const body = question.kind === 'permission'
			? (allowOnly || index < 0
				? { terminal: link.terminal, kind: 'permission', allow: allowOnly && index >= 0 ? index === 0 : !/^(no|いいえ|拒否|deny)/i.test(answer) }
				: { terminal: link.terminal, kind: 'permission', optionIndex: index })
			: { terminal: link.terminal, kind: 'question', ...(index >= 0 ? { optionIndex: index } : { text: answer }) };
		const attempt = task.attempt;
		void this.client.request('POST', '/v1/answer', body).catch((err: Error) => {
			this.note(task.id, `回答を送れませんでした: ${err.message}`);
			// 失敗が届く前にエージェントが先へ進んでいた（ターミナルで答えられた等）なら、質問を出し直さない
			if (link.status !== question.kind) {
				return;
			}
			this.engine.reportAnswerFailed(task.id, attempt, question, `回答を送れませんでした: ${err.message}`);
		});
	}

	sendInput(task: ITaskBoardTask, text: string): void {
		if (this.disposed) {
			return; // 止めた後（開き直した後）は、エージェントに触らない
		}
		const link = this.linkOf(task);
		if (!link || link.launching) {
			this.note(task.id, 'エージェントのターミナルがありません');
			return;
		}
		if (link.sending || !acceptsInput(link.status)) {
			this.note(task.id, 'エージェントが作業中のため送れませんでした。ターンが終わってから送ってください');
			return;
		}
		void this.sendNow(link, { text, human: true });
	}

	sendKey(task: ITaskBoardTask, key: string): void {
		if (this.disposed) {
			return; // 止めた後（開き直した後）は、エージェントに触らない
		}
		const link = this.linkOf(task);
		const mapped = KEY_MAP[key];
		if (!link || link.launching || !mapped) {
			return;
		}
		void this.client.request('POST', '/v1/key', { terminal: link.terminal, key: mapped }).catch((err: Error) => this.note(task.id, `キーを送れませんでした: ${err.message}`));
	}

	/** やり直し・差し戻し・中止。作業中なら止める（ターミナルは残し、次の工程で使い回す）。 */
	stop(task: ITaskBoardTask): void {
		const link = this.linkOf(task);
		if (!link) {
			return;
		}
		link.outbox = [];
		if (!link.launching && (link.sending || !acceptsInput(link.status))) {
			void this.client.request('POST', '/v1/key', { terminal: link.terminal, key: 'escape' }).catch(() => undefined);
		}
	}

	/** タスクが未着手・完了に戻ったら、ボードが起動したターミナルを閉じる（エンジンの変化のたびに呼ぶ）。 */
	onEngineChange(): void {
		for (const link of [...this.links.values()]) {
			const task = this.engine.getTask(link.taskId);
			if (!link.launching && (!task || task.step === 'todo' || task.step === 'done' || task.place !== link.place)) {
				void this.close(link);
			}
		}
	}

	/** タスクのターミナルを閉じて、結び付きを外す（次の工程の開始で新しいターミナルを起こすように）。 */
	async release(task: ITaskBoardTask): Promise<void> {
		const link = this.linkOf(task);
		if (link) {
			await this.close(link);
		}
	}

	private async close(link: ITerminalLink): Promise<void> {
		this.links.delete(link.terminal);
		if (link.launching) {
			link.released = true;
		}
		if (link.status !== 'exited' && !link.launching) {
			await this.client.request('POST', '/v1/close', { terminal: link.terminal }).catch(() => undefined);
		}
	}

	/**
	 * つなぎ直したとき、生きているターミナルと手元の結び付きを突き合わせる。
	 * 一覧に無いもの（Para Code の再起動で消えた）は終了として片付け、手元に無いもの（ボードの再起動）は
	 * 起動 id（`<タスク>:<試行>`）からタスクに結び直す。結び直したターミナルの前のターンの報告は、今の試行として受け付けない。
	 */
	private async relink(): Promise<void> {
		// 一覧を取る前から結び付いていたものだけを突き合わせる（取る間に起動したものは一覧に無くて当然）
		const known = [...this.links.values()].filter(l => !l.launching);
		let list: { terminals: { terminal: string; launchId?: string; tag?: string; agent?: TaskBoardAgentKind; status: ParaCodeTerminalStatus }[] };
		this.relinking = true;
		try {
			list = await this.client.request('GET', '/v1/terminals');
		} catch {
			this.relinking = false;
			this.replayEarly();
			return;
		}
		try {
			this.applyRelink(list, known);
		} finally {
			this.relinking = false;
			this.replayEarly();
		}
	}

	private applyRelink(list: { terminals: { terminal: string; launchId?: string; tag?: string; agent?: TaskBoardAgentKind; status: ParaCodeTerminalStatus }[] }, known: readonly ITerminalLink[]): void {
		const alive = new Set((list.terminals ?? []).map(t => t.terminal));
		for (const link of known) {
			if (this.links.get(link.terminal) === link && !alive.has(link.terminal)) {
				this.onStatus(link, 'exited', undefined);
			}
		}
		const candidates = (list.terminals ?? [])
			.map(t => ({ ...t, parsed: t.tag ? parseLaunchId(t.tag) : t.launchId ? parseLaunchId(t.launchId) : undefined }))
			.filter(t => !this.links.has(t.terminal) && t.parsed && t.status !== 'exited')
			.sort((a, b) => b.parsed!.attempt - a.parsed!.attempt);
		for (const t of candidates) {
			const task = this.engine.getTask(t.parsed!.taskId);
			if (!task || this.linkOf(task) || task.step === 'todo' || task.step === 'done' || !task.place) {
				continue;
			}
			// ボードの再起動では、エンジンが作業中のタスクの試行を 1 つ進めて「止まった」にする。そのターミナルは同じ仕事を
			// 続けているので、直前の試行で起動したものなら今の試行として扱う（それより古いものの報告は断る）
			const continuing = t.parsed!.attempt === task.attempt || (task.error === 'restarted' && t.parsed!.attempt === task.attempt - 1);
			const link: ITerminalLink = { terminal: t.terminal, agent: t.agent ?? task.agent ?? 'claude', taskId: task.id, place: task.place, attempt: task.attempt, sentAttempt: continuing ? task.attempt : t.parsed!.attempt, status: 'working', outbox: [], sending: false };
			this.links.set(t.terminal, link);
			this.note(task.id, 'Para Code のターミナルに結び直しました');
			const last = this.unknownStatus.get(t.terminal);
			this.unknownStatus.delete(t.terminal);
			this.onStatus(link, last?.status ?? t.status, last?.question);
		}
	}

	/* ---- Para Code から ---- */

	/** 結び直しや起動を待つ間に預かったイベントを流し直す（まだ結び付かないものの報告は断る）。 */
	private replayEarly(): void {
		if (this.launchingAny() || this.relinking) {
			return;
		}
		const early = [...this.early.entries()];
		this.early.clear();
		for (const [terminal, events] of early) {
			if (this.links.has(terminal)) {
				for (const event of events) {
					this.onEvent(event);
				}
			} else {
				this.early.set(terminal, events);
			}
		}
		this.dropEarly();
	}

	private dropEarly(): void {
		for (const events of this.early.values()) {
			for (const event of events) {
				if (event.type === 'report') {
					void this.reply(event.replyId, false, 'このペインはタスクボードのタスクとして結び付いていません。');
				}
			}
		}
		this.early.clear();
	}

	private onEvent(event: ParaCodeBridgeEvent): void {
		const link = this.links.get(event.terminal);
		if (!link) {
			if (this.launchingAny() || this.relinking) {
				// 起動の返事より先にイベントが届いた。返事が来たら流し直す
				const list = this.early.get(event.terminal) ?? [];
				if (this.early.has(event.terminal) || this.early.size < MAX_EARLY_TERMINALS) {
					this.early.set(event.terminal, list);
					if (list.length < 50) {
						list.push(event);
					}
				}
			} else if (event.type === 'report') {
				void this.reply(event.replyId, false, 'このペインはタスクボードのタスクとして結び付いていません。');
			}
			if (event.type === 'status') {
				this.unknownStatus.delete(event.terminal);
				if (this.unknownStatus.size < 100 && event.status !== 'exited') {
					this.unknownStatus.set(event.terminal, event);
				}
			}
			return;
		}
		const engine = this.engine;
		switch (event.type) {
			case 'tool':
				if (link.sentAttempt === link.attempt) {
					engine.reportToolUse(link.taskId, link.attempt, event.name, event.detail);
				}
				return;
			case 'output':
				engine.reportOutput(link.taskId, event.lines.slice(-80));
				return;
			case 'status':
				this.onStatus(link, event.status, event.question);
				return;
			case 'report':
				void this.onReport(link, event.replyId, event.tool, event.args).catch(async err => {
					await this.reply(event.replyId, false, `ボードで処理できませんでした: ${(err as Error).message}`);
				});
				return;
		}
	}

	private onStatus(link: ITerminalLink, status: ParaCodeTerminalStatus, question: IBridgeQuestion | undefined): void {
		const engine = this.engine;
		const before = link.status;
		if (!link.sending) {
			link.status = status;
		}
		if (status === 'exited') {
			link.status = 'exited';
			this.links.delete(link.terminal);
		}
		// ターンが終わったら、預かっている文を送る（前の試行のターンの終わりでも送る）
		if (acceptsInput(status) && link.outbox.length && !link.sending) {
			this.flush(link);
			return;
		}
		const task = engine.getTask(link.taskId);
		// 前の試行のターン（やり直しの前の指示で動いている間）の状態は、今の試行に反映しない
		if (!task || task.attempt !== link.attempt || link.sentAttempt !== link.attempt) {
			return;
		}
		switch (status) {
			case 'working':
				if (task.status === 'stalled') {
					engine.reportToolUse(task.id, link.attempt, '再開', undefined);
				}
				// 画面の質問・許可に、ターミナルで（またはボードの回答が届かなかった後に別の手段で）答えられて
				// エージェントが動き出した。ボードに出したままにしない。ask_human の質問はターンの終わりを待つので閉じない。
				// 画面に確認が残ったまま一瞬 working になることがあるので、少し待って確かめてから閉じる
				if ((task.status === 'question' || task.status === 'permission') && task.question && task.question.origin !== 'agent') {
					const attempt = link.attempt;
					const questionId = task.question.id;
					const confirm = () => {
						if (this.links.get(link.terminal) === link && link.attempt === attempt && link.status === 'working') {
							engine.reportQuestionAnsweredElsewhere(task.id, attempt, questionId);
						}
					};
					const wait = this.options.timeouts?.stall ?? STALL_CONFIRM_MS;
					if (wait <= 0) {
						confirm();
					} else {
						setTimeout(confirm, wait).unref?.();
					}
				}
				return;
			case 'question':
			case 'permission': {
				const raw = (question?.options ?? []).map(o => ({ label: o.label, detail: o.detail }));
				link.allowOnly = status === 'permission' && raw.length === 0;
				const options = link.allowOnly ? ALLOW_OPTIONS : raw;
				const open = task.status === status ? task.question : undefined;
				// 同じ質問が続いて届いた（または中身の無い報告が来た）なら、出している質問をそのままにする
				if (open && (!question || ((open.text === readablePromptText(question.text) || open.text === question.text) && open.options.map(o => o.label).join('\n') === options.map(o => o.label).join('\n')))) {
					return;
				}
				engine.reportQuestion(task.id, link.attempt, {
					kind: status,
					origin: 'screen',
					text: (question?.text ? readablePromptText(question.text) : '') || (status === 'permission' ? '許可を求めています（内容は Para Code のターミナルで確認してください）' : '質問しています（内容は Para Code のターミナルで確認してください）'),
					options,
					// 選択肢の無い質問は、文で答えられるようにする（答える手段が無くならないように）
					allowText: status === 'question' && ((question?.allowText ?? true) || raw.length === 0),
				});
				return;
			}
			case 'idle':
			case 'review':
				if (before === 'working' || before === 'question' || before === 'permission') {
					const attempt = link.attempt;
					const confirm = () => {
						if (this.links.get(link.terminal) === link && link.attempt === attempt && (link.status === 'idle' || link.status === 'review')) {
							engine.reportIdle(task.id, attempt);
						}
					};
					const wait = this.options.timeouts?.stall ?? STALL_CONFIRM_MS;
					if (wait <= 0) {
						confirm();
					} else {
						setTimeout(confirm, wait).unref?.();
					}
				}
				return;
			case 'exited':
				if (task.status === 'working' || task.status === 'question' || task.status === 'permission' || task.status === 'stalled') {
					engine.reportAgentError(task.id, link.attempt, 'エージェントが終了しました');
				}
				return;
		}
	}

	private async reply(replyId: string, ok: boolean, message: string): Promise<void> {
		await this.client.request('POST', '/v1/reply', { replyId, ok, message }).catch(() => undefined);
	}

	private async onReport(link: ITerminalLink, replyId: string, tool: 'complete_step' | 'ask_human', args: Record<string, unknown>): Promise<void> {
		const engine = this.engine;
		// 照合に使う試行と工程は、ここで固定する（成果物を読む間にやり直されても、新しい試行を動かさない）
		const attempt = link.attempt;
		const task = engine.getTask(link.taskId);
		const isCurrent = () => link.attempt === attempt && link.sentAttempt === attempt && engine.getTask(link.taskId)?.attempt === attempt;
		if (!task || !isCurrent()) {
			await this.reply(replyId, false, 'この工程はもう終わっているか、やり直されました。ここで止まって次の指示を待ってください。');
			return;
		}
		const fromStep = task.step;
		if (tool === 'ask_human') {
			const text = typeof args.question === 'string' ? args.question.trim() : '';
			if (!text) {
				await this.reply(replyId, false, 'question is required');
				return;
			}
			const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).map(label => ({ label: label.trim() })) : [];
			engine.reportQuestion(task.id, attempt, { kind: 'question', text, options, allowText: args.allow_text !== false || !options.length, origin: 'agent' });
			await this.reply(replyId, true, '質問をボードに出しました。回答はユーザーから次のメッセージで届きます。ここでターンを終えて待ってください。');
			return;
		}
		const summary = typeof args.summary === 'string' ? args.summary : undefined;
		let artifacts: ITaskBoardArtifactInput[];
		try {
			artifacts = await this.readArtifacts(task, args.artifacts);
		} catch (err) {
			await this.reply(replyId, false, `成果物を読めませんでした: ${(err as Error).message}`);
			return;
		}
		if (!isCurrent() || !engine.reportStepComplete(task.id, attempt, { summary, artifacts })) {
			await this.reply(replyId, false, 'この工程はもう終わっているか、やり直されました。ここで止まって次の指示を待ってください。');
			return;
		}
		const after = engine.getTask(task.id);
		const next = after ? engine.flowOf(after).steps.find(s => s.id === after.step) : undefined;
		const message = !after || after.step === 'done' ? 'ボードに報告しました。このタスクは完了です。ここで止まってください。'
			: next?.kind === 'agent' && after.step !== fromStep ? `ボードに報告しました。次の工程「${next.name}」の指示を、このターンが終わったら送ります。ここでターンを終えてください。`
				: `ボードに報告しました。次は「${next?.name ?? after.step}」です（人の確認や自動の処理）。ここで止まって待ってください。`;
		await this.reply(replyId, true, message);
	}

	/**
	 * 成果物の path は作業場所の中のファイルだけ読む（外を指すもの・大きすぎるものは断る）。SSH の窓のボードは中継で読み、
	 * 読めるのは `.para/` の中だけ（窓と接続先が確かめる）。スクショは、先頭のバイトで画像の形式を確かめてから出す
	 * （担当が秘密のファイルを `.para/x.png` に写しても、画像として手元に運ばない）。中身の検査はしない。
	 */
	private async readArtifacts(task: ITaskBoardTask, raw: unknown): Promise<ITaskBoardArtifactInput[]> {
		if (!Array.isArray(raw)) {
			return [];
		}
		const root = this.options.placePath(task);
		const remote = this.options.readArtifact;
		const realRoot = root && !remote ? await realpath(root).catch(() => undefined) : root;
		const result: ITaskBoardArtifactInput[] = [];
		for (const item of raw.slice(0, 20)) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const a = item as Record<string, unknown>;
			const kind = ARTIFACT_KINDS.has(a.kind as TaskBoardArtifactKind) ? a.kind as TaskBoardArtifactKind : 'report';
			const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim() : '成果物';
			let content = typeof a.content === 'string' ? a.content : undefined;
			let relPath = typeof a.path === 'string' && a.path.trim() ? a.path.trim() : undefined;
			if (relPath && content === undefined && realRoot) {
				let bytes: Buffer;
				if (remote) {
					// 接続先のパスは POSIX。作業場所の中の相対パスに直してから頼む（外を指すものはここでも断る）
					const rel = path.posix.isAbsolute(relPath) ? path.posix.relative(realRoot, relPath) : path.posix.normalize(relPath);
					if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) {
						throw new Error(`${relPath} は作業場所の外です`);
					}
					const read = await remote(realRoot, rel, kind === 'screenshot' ? Math.floor(MAX_ARTIFACT_BYTES * 3 / 4) : MAX_ARTIFACT_BYTES).catch((err: Error) => {
						throw new Error(`${relPath} を読めませんでした（SSH の接続先では .para/ の中のファイルだけを読めます）: ${err.message}`);
					});
					if (!read) {
						throw new Error(`${relPath} は存在しません`);
					}
					bytes = read;
					relPath = rel;
				} else {
					const target = await realpath(path.resolve(realRoot, relPath)).catch(() => undefined);
					if (!target || (target !== realRoot && !target.startsWith(realRoot + path.sep))) {
						throw new Error(`${relPath} は作業場所の外か、存在しません`);
					}
					const info = await stat(target);
					const encoded = kind === 'screenshot' ? Math.ceil(info.size / 3) * 4 + 40 : info.size;
					if (!info.isFile() || encoded > MAX_ARTIFACT_BYTES) {
						throw new Error(`${relPath} はファイルでないか、大きすぎます（上限 4 MiB、画像は約 3 MiB）`);
					}
					bytes = await readFile(target);
					relPath = path.relative(realRoot, target);
				}
				if (kind === 'screenshot') {
					const mime = imageMimeOf(bytes);
					if (!mime) {
						throw new Error(`${relPath} は PNG・JPEG・GIF・WebP の画像ではありません`);
					}
					content = `data:${mime};base64,${bytes.toString('base64')}`;
				} else {
					content = bytes.toString('utf8');
				}
			}
			if (content !== undefined && content.length > MAX_ARTIFACT_BYTES) {
				throw new Error(`「${title}」の本文が 4 MiB を超えています`);
			}
			result.push({ kind, title, path: relPath, content });
		}
		return result;
	}
}

/**
 * 許可の確認の文を、人が読める形にする。MCP のツールの許可は `mcp__<サーバー>__<ツール>: {引数の JSON}` の形で
 * 届くので、「<サーバー> の <ツール>（キー: 値、…）」にする。引数は切らない。それ以外の行はそのまま。
 */
export function readablePromptText(text: string): string {
	return text.split('\n').map(line => {
		const m = /^mcp__(?<server>[A-Za-z0-9_-]+?)__(?<tool>[A-Za-z0-9_-]+):\s*(?<args>.*)$/.exec(line.trim());
		if (!m?.groups) {
			return line;
		}
		const server = m.groups.server;
		let args = '';
		try {
			const parsed: unknown = JSON.parse(m.groups.args || '{}');
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				args = Object.entries(parsed as Record<string, unknown>)
					// 切らない（読まないまま許可しないよう、全文をボードに残す。長さは表示側で畳む）
					.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
					.join('、');
			}
		} catch {
			args = m.groups.args;
		}
		return `${server} の ${m.groups.tool}${args ? `（${args}）` : ''}`;
	}).join('\n');
}

/** 起動の失敗を、利用者が次に何をすればよいか分かる文にする。 */
export function launchErrorText(message: string | undefined): string {
	if (!message) {
		return '起動できませんでした';
	}
	if (/multi-root workspace/i.test(message)) {
		return 'Para Code にリポジトリを登録できるウィンドウがありません。Para Code のコマンドパレットで「Para Code: マルチリポワークスペースを初期化」を実行してから、やり直してください';
	}
	if (/No Para Code window/i.test(message)) {
		return 'Para Code のウィンドウが開いていません';
	}
	if (/Only remote \(SSH\) Para Code windows/i.test(message)) {
		return 'Para Code のウィンドウが SSH の接続先のものしかありません。エージェントはこの PC で動くので、この PC のフォルダを開いた Para Code のウィンドウを開いてから、やり直してください';
	}
	if (/connected to a remote host/i.test(message)) {
		return '起動先に選ばれた Para Code のウィンドウが SSH の接続先のものでした。この PC のフォルダを開いた Para Code のウィンドウを前に出してから、やり直してください';
	}
	return message;
}

/** 先頭のバイトで見分けた画像の形式（PNG・JPEG・GIF・WebP）。どれでもなければ undefined。 */
export function imageMimeOf(bytes: Buffer): string | undefined {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return 'image/png';
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg';
	}
	if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) {
		return 'image/gif';
	}
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
		return 'image/webp';
	}
	return undefined;
}
