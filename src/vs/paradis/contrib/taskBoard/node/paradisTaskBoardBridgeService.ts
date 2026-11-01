/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードの接続口の中身（shared process）。HTTP の受け口（paradisTaskBoardBridgeServer.ts）から
// 解析済みの要求を受け取り、ウィンドウへ振り分けて答えを作る。HTTP やファイルには触らない（テストで
// ウィンドウの代わりを渡して確かめられるように）。
//
// 受け持つこと:
//  - ボードが起動したターミナルの台帳（ターミナル ID → 起動 ID・リポジトリ・受け持ちのウィンドウ・状態）。
//    操作はこの台帳に載ったターミナルにだけ通す（トークンを持つボードでも、利用者の他のペインは触らせない）
//  - 起動先のウィンドウ選び（そのリポジトリを開いているウィンドウ → フォーカス中 → 最初のウィンドウ）
//  - SSE で流すイベント（状態・ツール・報告）と、報告への返事の待ち合わせ
//  - para-browser MCP の `board_complete_step` / `board_ask_human`
//
// ペイントークンはボードへ出さない（ID はトークンのハッシュ）。

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import type { IParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import {
	IParadisTaskBoardLaunchRequest,
	IParadisTaskBoardQuestionPayload,
	IParadisTaskBoardScreen,
	IParadisTaskBoardWindowDescription,
	PARADIS_TASK_BOARD_BRIDGE_VERSION,
	PARADIS_TASK_BOARD_REPLY_TIMEOUT_MS,
	PARADIS_TASK_BOARD_SERVER_INSTRUCTIONS,
	PARADIS_TASK_BOARD_SSE_PING,
	PARADIS_TASK_BOARD_TOOL_ASK_HUMAN,
	PARADIS_TASK_BOARD_TOOL_COMPLETE_STEP,
	PARADIS_TASK_BOARD_TOOL_NAMES,
	PARADIS_TASK_BOARD_TOOLS,
	ParadisTaskBoardAgent,
	ParadisTaskBoardErrorCode,
	ParadisTaskBoardEvent,
	ParadisTaskBoardResult,
	ParadisTaskBoardTerminalStatus,
	ParadisTaskBoardWindowMethod,
	paradisParseTaskBoardAnswer,
	paradisParseTaskBoardAskHumanArgs,
	paradisParseTaskBoardCompleteStepArgs,
	paradisParseTaskBoardKey,
	paradisParseTaskBoardLaunch,
	paradisParseTaskBoardReply,
	paradisParseTaskBoardSend,
	paradisParseTaskBoardStatusReport,
	paradisParseTaskBoardTerminalOnly,
	paradisIsTaskBoardTerminalId,
	paradisTaskBoardHttpStatus,
	paradisTaskBoardSamePath,
	paradisTaskBoardSseData,
	paradisTaskBoardTerminalId,
	paradisTaskBoardToolDetail,
} from '../common/paradisTaskBoardBridge.js';

/** ウィンドウへの振り分け（shared process の IPCServer を包む。テストでは差し替える）。 */
export interface IParadisTaskBoardWindowRouter {
	/** いまつながっているウィンドウの ctx（`window:N`）。 */
	windows(): readonly string[];
	/** そのウィンドウのチャネルを 1 回呼ぶ。`timeoutMs` を過ぎたら失敗する。 */
	call<T>(ctx: string, method: ParadisTaskBoardWindowMethod, arg: unknown, timeoutMs: number): Promise<T>;
}

export interface IParadisTaskBoardBridgeOptions {
	/** そのパスがフォルダとしてあるか。 */
	directoryExists(path: string): Promise<boolean>;
	/** パスの大文字小文字を区別しない OS か。 */
	readonly ignorePathCase: boolean;
	/** 報告の返事の ID を作る。 */
	newId(): string;
	/** SSH の中継のセッションを作った窓（ctx）。セッションが無いか、鍵の違うボードなら undefined。 */
	relaySessionWindow?(sessionId: string, keyHash: string): string | undefined;
	/** SSH の中継の起動を監査ログに残す（設計書 3 節: スペースとエージェントの種類）。 */
	onRelayLaunch?(request: IParadisTaskBoardLaunchRequest, outcome: 'allowed' | 'denied' | 'failed', reason: string | undefined): void;
	/** 報告の返事を待つ上限（テストで短くする）。 */
	readonly replyTimeoutMs?: number;
	/** ウィンドウとの接続が切れてから、そのウィンドウのターミナルを終わったとみなすまで（再読み込みを待つ）。 */
	readonly disconnectGraceMs?: number;
}

export interface IParadisTaskBoardHttpResponse {
	readonly status: number;
	readonly body: object;
}

interface ITerminalEntry {
	readonly terminal: string;
	readonly launchId: string;
	readonly repoPath: string;
	readonly agent: ParadisTaskBoardAgent;
	readonly ctx: string;
	/** SSH の中継で起動したターミナルなら、そのセッション。SSH のボードが触れるのはこれだけ。 */
	readonly relaySessionId?: string;
	/** ボードが最後の送信に付けた印（無ければ launchId）。 */
	tag?: string;
	status: ParadisTaskBoardTerminalStatus;
	question?: IParadisTaskBoardQuestionPayload;
}

interface IPendingReply {
	readonly terminal: string;
	resolve(reply: { readonly ok: boolean; readonly message: string } | undefined): void;
}

/** 台帳に載せるターミナルの上限。 */
const MAX_TERMINALS = 200;
/** 届け先の無い報告を溜めておく上限（次に SSE がつながったときに流す）。 */
const MAX_QUEUED_REPORTS = 100;
/** 同時につなげる SSE の数。 */
const MAX_EVENT_CLIENTS = 8;
const DESCRIBE_TIMEOUT_MS = 3_000;
/** 起動（リポジトリの追加・シェルの立ち上がりを含む）を待つ上限。 */
const LAUNCH_TIMEOUT_MS = 150_000;
/** 回答（画面に選択肢が出るのを待って打鍵する）を待つ上限。 */
const ANSWER_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 15_000;
const DEFAULT_DISCONNECT_GRACE_MS = 60_000;

const NOT_BOARD_TERMINAL_MESSAGE = 'このペインはタスクボードのタスクではありません';
const DELIVERED_MESSAGE = 'ボードに届けました';
const ASKED_MESSAGE = '質問をボードに出しました。回答はユーザーから次のメッセージで届きます。ここでターンを終えて待ってください';
const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside your own terminal pane, so it does not report to the task board.';

function ok(body: object = { ok: true }): IParadisTaskBoardHttpResponse {
	return { status: 200, body };
}

function error(code: ParadisTaskBoardErrorCode, message?: string): IParadisTaskBoardHttpResponse {
	return { status: paradisTaskBoardHttpStatus(code), body: message !== undefined ? { error: code, message } : { error: code } };
}

function toolText(text: string): unknown {
	return { content: [{ type: 'text', text }] };
}

function toolError(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: true };
}

export class ParadisTaskBoardBridgeService extends Disposable implements IParadisMcpToolProvider {

	private readonly terminals = new Map<string, ITerminalEntry>();
	/** 起動中の要求（同じ launchId が重ねて来ても 1 回だけ起動する）。 */
	private readonly launching = new Map<string, Promise<IParadisTaskBoardHttpResponse>>();
	private readonly clients = new Set<(chunk: string) => void>();
	private readonly queuedReports: ParadisTaskBoardEvent[] = [];
	private readonly replies = new Map<string, IPendingReply>();
	private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** ペイントークン → ターミナル ID（hook のたびにハッシュを取り直さない）。 */
	private readonly idCache = new Map<string, string>();

	constructor(
		private readonly router: IParadisTaskBoardWindowRouter,
		private readonly options: IParadisTaskBoardBridgeOptions,
		private readonly logService: ILogService | undefined,
	) {
		super();
		this._register(toDisposable(() => {
			for (const timer of this.disconnectTimers.values()) {
				clearTimeout(timer);
			}
			this.disconnectTimers.clear();
			for (const reply of this.replies.values()) {
				reply.resolve(undefined);
			}
			this.replies.clear();
			this.clients.clear();
		}));
	}

	// --- HTTP ----------------------------------------------------------------------------------

	/** 解析済みの要求に答える（`/v1/events` は {@link addEventClient}）。 */
	/**
	 * `keyHash` は接続口が確かめたボードの鍵（SSH の中継の起動で、セッションの持ち主か確かめる）。`remoteBoard` は、そのボードが
	 * SSH の窓のボードか（main が登録の印を付ける）。SSH のボードには、手元で担当を起こす口・手元のフォルダを見る口・
	 * 手元のターミナルに触る口を使わせない（接続先から手元へ届く道にしない。設計書 T2）。
	 */
	async handle(method: string, pathname: string, query: URLSearchParams, body: unknown, keyHash?: string, remoteBoard = false): Promise<IParadisTaskBoardHttpResponse> {
		const route = `${method} ${pathname}`;
		if (remoteBoard) {
			const refused = this.refuseForRemoteBoard(route, query, body);
			if (refused) {
				return refused;
			}
		}
		switch (route) {
			case 'GET /v1/health': return this.health(remoteBoard);
			case 'GET /v1/terminals': return ok({ terminals: this.liveTerminals(remoteBoard) });
			case 'GET /v1/screen': return this.screen(query.get('terminal'));
			case 'POST /v1/launch': return this.launch(body, keyHash);
			case 'POST /v1/send': {
				const parsed = paradisParseTaskBoardSend(body);
				if (!parsed.ok) {
					return error('invalid', parsed.message);
				}
				const { tag, ...request } = parsed.value;
				const response = await this.forward(request.terminal, 'send', request, OPERATION_TIMEOUT_MS);
				const entry = this.terminals.get(request.terminal);
				if (response.status === 200 && tag !== undefined && entry) {
					entry.tag = tag;
				}
				return response;
			}
			case 'POST /v1/key': {
				const parsed = paradisParseTaskBoardKey(body);
				return parsed.ok ? this.forward(parsed.value.terminal, 'key', parsed.value, OPERATION_TIMEOUT_MS) : error('invalid', parsed.message);
			}
			case 'POST /v1/answer': {
				const parsed = paradisParseTaskBoardAnswer(body);
				return parsed.ok ? this.forward(parsed.value.terminal, 'answer', parsed.value, ANSWER_TIMEOUT_MS) : error('invalid', parsed.message);
			}
			case 'POST /v1/close': return this.close(body);
			case 'POST /v1/reply': return this.reply(body);
		}
		const known = ['/v1/health', '/v1/terminals', '/v1/screen', '/v1/events', '/v1/launch', '/v1/send', '/v1/key', '/v1/answer', '/v1/close', '/v1/reply'];
		return known.includes(pathname) ? { status: 405, body: { error: 'method-not-allowed' } } : error('not-found');
	}

	private async describeWindows(): Promise<{ readonly ctx: string; readonly description: IParadisTaskBoardWindowDescription }[]> {
		const results = await Promise.all(this.router.windows().map(async ctx => {
			try {
				const description = await this.router.call<IParadisTaskBoardWindowDescription>(ctx, 'describe', undefined, DESCRIBE_TIMEOUT_MS);
				return { ctx, description };
			} catch (err) {
				this.logService?.trace('[ParadisTaskBoardBridge] describe failed', String(err));
				return undefined;
			}
		}));
		return results.filter((value): value is { ctx: string; description: IParadisTaskBoardWindowDescription } => value !== undefined);
	}

	/** SSH のボードに使わせない要求なら 403。手元への起動と、中継で起動していないターミナルへの操作。 */
	private refuseForRemoteBoard(route: string, query: URLSearchParams, body: unknown): IParadisTaskBoardHttpResponse | undefined {
		const forbidden = (message: string): IParadisTaskBoardHttpResponse => ({ status: 403, body: { error: 'forbidden', message } });
		const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
		if (route === 'POST /v1/launch') {
			return record.relaySessionId === undefined ? forbidden('A task board for an SSH window can start agents only on the SSH host.') : undefined;
		}
		let terminal: unknown;
		if (route === 'GET /v1/screen') {
			terminal = query.get('terminal');
		} else if (route === 'POST /v1/reply') {
			terminal = typeof record.replyId === 'string' ? this.replies.get(record.replyId)?.terminal : undefined;
		} else if (['POST /v1/send', 'POST /v1/key', 'POST /v1/answer', 'POST /v1/close'].includes(route)) {
			terminal = record.terminal;
		} else {
			return undefined;
		}
		const entry = typeof terminal === 'string' ? this.terminals.get(terminal) : undefined;
		return entry && entry.relaySessionId === undefined ? forbidden('A task board for an SSH window can use only the terminals it started on the SSH host.') : undefined;
	}

	private async health(remoteBoard = false): Promise<IParadisTaskBoardHttpResponse> {
		// SSH のボードには、手元の窓のリポジトリ（手元のパス）を見せない
		const windows = remoteBoard ? [] : await this.describeWindows();
		return ok({
			ok: true,
			version: PARADIS_TASK_BOARD_BRIDGE_VERSION,
			windows: windows.map(({ ctx, description }) => ({ id: ctx, focused: description.focused, ...(description.remote ? { remote: true } : {}), repositories: description.repositories })),
		});
	}

	private liveTerminals(remoteBoard = false): object[] {
		return [...this.terminals.values()].filter(entry => !remoteBoard || entry.relaySessionId !== undefined).map(entry => ({ terminal: entry.terminal, launchId: entry.launchId, tag: entry.tag ?? entry.launchId, repoPath: entry.repoPath, agent: entry.agent, status: entry.status }));
	}

	private launch(body: unknown, keyHash: string | undefined): Promise<IParadisTaskBoardHttpResponse> {
		const parsed = paradisParseTaskBoardLaunch(body);
		if (!parsed.ok) {
			return Promise.resolve(error('invalid', parsed.message));
		}
		const request = parsed.value;
		// 同じ launchId のターミナルが生きていれば、それを返す（ボードの再送で二重に起動しない）
		const existing = [...this.terminals.values()].find(entry => entry.launchId === request.launchId);
		if (existing) {
			return Promise.resolve(ok({ terminal: existing.terminal }));
		}
		const running = this.launching.get(request.launchId);
		if (running) {
			return running;
		}
		const launching = this.doLaunch(request, keyHash).finally(() => this.launching.delete(request.launchId));
		this.launching.set(request.launchId, launching);
		return launching;
	}

	private async doLaunch(request: IParadisTaskBoardLaunchRequest, keyHash: string | undefined): Promise<IParadisTaskBoardHttpResponse> {
		if (this.terminals.size >= MAX_TERMINALS) {
			return error('rejected', 'Too many terminals started by the task board are still open. Close some first.');
		}
		if (request.relaySessionId !== undefined) {
			// SSH の中継: 宛先はセッションを作った窓だけ（依頼に書かれた authority やパスでは選ばない）。パスは窓が確かめる
			const ctx = keyHash !== undefined ? this.options.relaySessionWindow?.(request.relaySessionId, keyHash) : undefined;
			if (ctx === undefined) {
				this.options.onRelayLaunch?.(request, 'denied', 'unknown-session');
				return error('not-found', 'The relay session is not open.');
			}
			const response = await this.launchIn(ctx, request);
			const failure = response.status === 200 ? undefined : String((response.body as { error?: unknown }).error ?? response.status);
			this.options.onRelayLaunch?.(request, failure === undefined ? 'allowed' : failure === 'unavailable' || failure === 'failed' ? 'failed' : 'denied', failure);
			return response;
		}
		if (!(await this.options.directoryExists(request.repoPath))) {
			return error('invalid', 'repoPath is not an existing folder.');
		}
		const described = await this.describeWindows();
		// SSH のウィンドウは選ばない（IParadisTaskBoardWindowDescription.remote）
		const windows = described.filter(({ description }) => description.remote !== true);
		if (described.length > 0 && windows.length === 0) {
			return error('unavailable', 'Only remote (SSH) Para Code windows are open. Open a local window to start agents from the task board.');
		}
		// そのリポジトリ（worktree を含む）を持つウィンドウ → 登録できるウィンドウのうちフォーカス中のもの → 登録できる最初のもの。
		// 空のウィンドウや単一フォルダのウィンドウには登録できないので、最後の手段にする
		const capable = windows.filter(({ description }) => description.canAddRepository !== false);
		const target = windows.find(({ description }) => description.spaces.some(space => paradisTaskBoardSamePath(space.path, request.repoPath, this.options.ignorePathCase)))
			?? capable.find(({ description }) => description.focused)
			?? capable[0]
			?? windows.find(({ description }) => description.focused)
			?? windows[0];
		if (!target) {
			return error('unavailable', 'No Para Code window is open.');
		}
		return this.launchIn(target.ctx, request);
	}

	private async launchIn(ctx: string, request: IParadisTaskBoardLaunchRequest): Promise<IParadisTaskBoardHttpResponse> {
		const target = { ctx };
		let result: ParadisTaskBoardResult<{ readonly terminal: string }>;
		try {
			result = await this.router.call<ParadisTaskBoardResult<{ readonly terminal: string }>>(target.ctx, 'launch', request, LAUNCH_TIMEOUT_MS);
		} catch (err) {
			this.logService?.warn('[ParadisTaskBoardBridge] launch failed', String(err));
			return error('unavailable', 'The Para Code window did not answer.');
		}
		if (!result.ok) {
			return error(result.code, result.message);
		}
		const terminal = result.value.terminal;
		if (!paradisIsTaskBoardTerminalId(terminal)) {
			return error('failed', 'The Para Code window returned an invalid terminal id.');
		}
		const entry: ITerminalEntry = {
			terminal,
			launchId: request.launchId,
			repoPath: request.repoPath,
			agent: request.agent,
			ctx: target.ctx,
			...(request.relaySessionId !== undefined ? { relaySessionId: request.relaySessionId } : {}),
			// 指示を渡して起動したので、最初の報告までは作業中とみなす
			status: request.prompt.trim().length > 0 ? 'working' : 'idle',
		};
		this.terminals.set(terminal, entry);
		this.emit({ type: 'status', terminal, launchId: entry.launchId, status: entry.status });
		return ok({ terminal });
	}

	private async forward(terminal: string, method: ParadisTaskBoardWindowMethod, arg: unknown, timeoutMs: number): Promise<IParadisTaskBoardHttpResponse> {
		const result = await this.callTerminalWindow<unknown>(terminal, method, arg, timeoutMs);
		return result.ok ? ok() : error(result.code, result.message);
	}

	private async callTerminalWindow<T>(terminal: string, method: ParadisTaskBoardWindowMethod, arg: unknown, timeoutMs: number): Promise<ParadisTaskBoardResult<T>> {
		const entry = this.terminals.get(terminal);
		if (!entry) {
			return { ok: false, code: 'not-found', message: 'There is no terminal with that id started by the task board.' };
		}
		if (!this.router.windows().includes(entry.ctx)) {
			return { ok: false, code: 'unavailable', message: 'The Para Code window of that terminal is not connected (it may be reloading).' };
		}
		try {
			return await this.router.call<ParadisTaskBoardResult<T>>(entry.ctx, method, arg, timeoutMs);
		} catch (err) {
			this.logService?.warn(`[ParadisTaskBoardBridge] ${method} failed`, String(err));
			return { ok: false, code: 'unavailable', message: 'The Para Code window did not answer.' };
		}
	}

	private async screen(terminal: string | null): Promise<IParadisTaskBoardHttpResponse> {
		if (!paradisIsTaskBoardTerminalId(terminal)) {
			return error('invalid', 'terminal must be a terminal id.');
		}
		const result = await this.callTerminalWindow<IParadisTaskBoardScreen>(terminal, 'screen', { terminal }, OPERATION_TIMEOUT_MS);
		if (!result.ok) {
			return error(result.code, result.message);
		}
		const { text, status, readable } = result.value;
		return ok(readable ? { text, status } : { text: '', status, readable: false });
	}

	private async close(body: unknown): Promise<IParadisTaskBoardHttpResponse> {
		const parsed = paradisParseTaskBoardTerminalOnly(body);
		if (!parsed.ok) {
			return error('invalid', parsed.message);
		}
		const result = await this.callTerminalWindow<unknown>(parsed.value.terminal, 'close', parsed.value, OPERATION_TIMEOUT_MS);
		if (!result.ok) {
			return error(result.code, result.message);
		}
		this.markExited(parsed.value.terminal);
		return ok();
	}

	private reply(body: unknown): IParadisTaskBoardHttpResponse {
		const parsed = paradisParseTaskBoardReply(body);
		if (!parsed.ok) {
			return error('invalid', parsed.message);
		}
		const pending = this.replies.get(parsed.value.replyId);
		if (!pending) {
			return error('not-found', 'No report is waiting for that replyId (it may have timed out).');
		}
		this.replies.delete(parsed.value.replyId);
		pending.resolve({ ok: parsed.value.ok, message: parsed.value.message });
		return ok();
	}

	// --- SSE -----------------------------------------------------------------------------------

	/**
	 * SSE の受け手を足す。つないだ直後に、生きているターミナルの今の状態と、届け先の無かった報告を流す。
	 * 上限を超えたら undefined。
	 */
	addEventClient(write: (chunk: string) => void): IDisposable | undefined {
		if (this.clients.size >= MAX_EVENT_CLIENTS) {
			return undefined;
		}
		for (const entry of this.terminals.values()) {
			write(paradisTaskBoardSseData({ type: 'status', terminal: entry.terminal, launchId: entry.launchId, status: entry.status, ...(entry.question ? { question: entry.question } : {}) }));
		}
		for (const report of this.queuedReports.splice(0)) {
			write(paradisTaskBoardSseData(report));
		}
		this.clients.add(write);
		return toDisposable(() => this.clients.delete(write));
	}

	/** 15 秒ごとに呼ぶ（つながりが生きているかを保つ）。 */
	ping(): void {
		for (const write of [...this.clients]) {
			this.write(write, PARADIS_TASK_BOARD_SSE_PING);
		}
	}

	private write(write: (chunk: string) => void, chunk: string): void {
		try {
			write(chunk);
		} catch (err) {
			this.logService?.trace('[ParadisTaskBoardBridge] dropping an event client', String(err));
			this.clients.delete(write);
		}
	}

	private emit(event: ParadisTaskBoardEvent): void {
		if (event.type === 'report' && this.clients.size === 0) {
			// 報告は落とさない。次につながったときに流す
			this.queuedReports.push(event);
			if (this.queuedReports.length > MAX_QUEUED_REPORTS) {
				this.queuedReports.shift();
			}
			return;
		}
		const chunk = paradisTaskBoardSseData(event);
		for (const write of [...this.clients]) {
			this.write(write, chunk);
		}
	}

	// --- ウィンドウから -------------------------------------------------------------------------

	/** そのウィンドウが受け持つボードのターミナル（再読み込みの後に見張りを戻す）。 */
	listWindowTerminals(ctx: string): string[] {
		return [...this.terminals.values()].filter(entry => entry.ctx === ctx).map(entry => entry.terminal);
	}

	/** ウィンドウからの状態の報告。受け持っていないウィンドウからのものは捨てる。 */
	reportStatus(ctx: string, value: unknown): boolean {
		const report = paradisParseTaskBoardStatusReport(value);
		const entry = report && this.terminals.get(report.terminal);
		if (!report || !entry || entry.ctx !== ctx) {
			return false;
		}
		const question = report.status === 'question' || report.status === 'permission' ? report.question : undefined;
		if (entry.status === report.status && JSON.stringify(entry.question) === JSON.stringify(question)) {
			return true;
		}
		entry.status = report.status;
		entry.question = question;
		this.emit({ type: 'status', terminal: entry.terminal, launchId: entry.launchId, status: entry.status, ...(question ? { question } : {}) });
		if (report.status === 'exited') {
			this.forget(entry.terminal);
		}
		return true;
	}

	onWindowConnected(ctx: string): void {
		const timer = this.disconnectTimers.get(ctx);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.disconnectTimers.delete(ctx);
		}
	}

	/** ウィンドウが閉じた・再読み込みした。戻ってこなければ、そのウィンドウのターミナルは終わったとみなす。 */
	onWindowDisconnected(ctx: string): void {
		if (this.disconnectTimers.has(ctx) || !this.listWindowTerminals(ctx).length) {
			return;
		}
		this.disconnectTimers.set(ctx, setTimeout(() => {
			this.disconnectTimers.delete(ctx);
			if (this.router.windows().includes(ctx)) {
				return;
			}
			for (const terminal of this.listWindowTerminals(ctx)) {
				this.markExited(terminal);
			}
		}, this.options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS));
	}

	private markExited(terminal: string): void {
		const entry = this.terminals.get(terminal);
		if (!entry) {
			return;
		}
		entry.status = 'exited';
		entry.question = undefined;
		this.emit({ type: 'status', terminal, launchId: entry.launchId, status: 'exited' });
		this.forget(terminal);
	}

	private forget(terminal: string): void {
		this.terminals.delete(terminal);
		for (const [replyId, pending] of [...this.replies]) {
			if (pending.terminal === terminal) {
				this.replies.delete(replyId);
				pending.resolve(undefined);
			}
		}
	}

	private idOf(paneToken: string): string {
		let id = this.idCache.get(paneToken);
		if (id === undefined) {
			id = paradisTaskBoardTerminalId(paneToken);
			if (this.idCache.size > 1000) {
				this.idCache.clear();
			}
			this.idCache.set(paneToken, id);
		}
		return id;
	}

	// --- hook ----------------------------------------------------------------------------------

	/** hook のイベント（shared process のバス）。ボードのターミナルのツールの開始を流す。 */
	onHookEvent(event: IParadisAgentHookEvent): void {
		if (event.event !== 'PreToolUse' || typeof event.toolName !== 'string' || event.toolName.length === 0 || this.terminals.size === 0) {
			return;
		}
		const terminal = this.idOf(event.token);
		if (!this.terminals.has(terminal)) {
			return;
		}
		const detail = paradisTaskBoardToolDetail(event.toolInput);
		this.emit({ type: 'tool', terminal, name: event.toolName.slice(0, 200), ...(detail !== undefined ? { detail } : {}) });
	}

	// --- MCP -----------------------------------------------------------------------------------

	listTools(): readonly IParadisMcpToolDefinition[] {
		return PARADIS_TASK_BOARD_TOOLS;
	}

	instructions(): string {
		return PARADIS_TASK_BOARD_SERVER_INSTRUCTIONS;
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (!PARADIS_TASK_BOARD_TOOL_NAMES.has(name)) {
			return undefined;
		}
		const terminal = this.idOf(paneToken);
		if (!this.terminals.has(terminal)) {
			return toolError(NOT_BOARD_TERMINAL_MESSAGE);
		}
		// トークンは同じユーザーの別プロセスからも読めるので、そのペインの中から来たと確かめる
		if (context !== undefined && (await context.classifyCaller()) === 'unverified') {
			return toolError(CALLER_UNVERIFIED_MESSAGE);
		}
		if (name === PARADIS_TASK_BOARD_TOOL_COMPLETE_STEP) {
			const parsed = paradisParseTaskBoardCompleteStepArgs(args);
			if (!parsed.ok) {
				return toolError(parsed.message);
			}
			const reply = await this.report(terminal, 'complete_step', parsed.value, signal);
			if (reply === undefined) {
				return toolText(DELIVERED_MESSAGE);
			}
			const message = reply.message.trim().length > 0 ? reply.message : DELIVERED_MESSAGE;
			return reply.ok ? toolText(message) : toolError(message);
		}
		if (name === PARADIS_TASK_BOARD_TOOL_ASK_HUMAN) {
			const parsed = paradisParseTaskBoardAskHumanArgs(args);
			if (!parsed.ok) {
				return toolError(parsed.message);
			}
			const reply = await this.report(terminal, 'ask_human', parsed.value, signal);
			// 断られたときだけボードの言葉を返す。受け付けたら、回答を待つよう伝える
			return reply !== undefined && !reply.ok && reply.message.trim().length > 0 ? toolError(reply.message) : toolText(ASKED_MESSAGE);
		}
		return undefined;
	}

	/** 報告を流し、ボードの返事を待つ（上限まで。来なければ undefined）。 */
	private report(terminal: string, tool: 'complete_step' | 'ask_human', args: object, signal: AbortSignal | undefined): Promise<{ readonly ok: boolean; readonly message: string } | undefined> {
		const replyId = this.options.newId();
		return new Promise(resolve => {
			let settled = false;
			const finish = (value: { readonly ok: boolean; readonly message: string } | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				this.replies.delete(replyId);
				resolve(value);
			};
			const onAbort = () => finish(undefined);
			const timer = setTimeout(() => finish(undefined), this.options.replyTimeoutMs ?? PARADIS_TASK_BOARD_REPLY_TIMEOUT_MS);
			signal?.addEventListener('abort', onAbort, { once: true });
			this.replies.set(replyId, { terminal, resolve: finish });
			this.emit({ type: 'report', terminal, replyId, tool, args });
			if (signal?.aborted) {
				onAbort();
			}
		});
	}
}
