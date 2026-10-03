/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 側の、Claude Code の mod（resources/paradis/claude-mod）の受け口。
//
// mod は hook と同じループバックのポートへ、ペイントークン（Bearer）付きで `/claude-mod/v1/<op>` を POST する。
// 認証（トークンが今のペインのものか）は ParadisAgentBrowserService が済ませてから {@link ParadisClaudeModBridge.handle}
// を呼ぶ。ここでは次を受け持つ:
//  - 観測（`event`）: 会話の行（uuid 付き）・生成中の文章・ターンの始まりと終わり・サブエージェントの開始と再開を
//    バスへ流す。受けて画面へ反映するのは ParadisMobileAgentChat（今の hook・transcript と並べて使い、uuid で重複を除く）
//  - 質問（`question`）と承認（`permission`）: mod が登録し、`wait` の長いポーリングでモバイルの答えを待つ。
//    PC（TUI）が先に答えたら mod の `settle`、または Para Code が観測から決着を知って、待ちを即座に返す
//    （`$.http.fetch` には中断が無いので、打ち切るのは受け口の側）
//  - 送信（`commands` / `ack`）: エージェントが待機中のときだけ、モバイルの発言を mod の `$.prompt.submit` で送る
//
// mod が来ない・止まったペインでは何も起きない（今の hook・transcript・キーの経路だけで動く）。
// shared process 内のモジュールシングルトン（hook バスと同じ方式。sharedProcessMain.ts で独立に登録される
// ParadisAgentBrowserService と ParadisMobileRelayService を疎結合につなぐ）。

import { randomUUID } from 'crypto';
import { Emitter, Event } from '../../../../base/common/event.js';
import { paradisSanitizeAgentHookPayload } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisIsDisplayOnlyModRow } from '../common/paradisClaudeMod.js';

/** 1 回の長いポーリングを受け口が持つ時間。mod 側には時間切れの指定が無いので、こちらで返す。 */
const LONG_POLL_MS = 25_000;
/** mod から何も届かなくなったら死んだとみなすまで（コマンドの長いポーリングが 25 秒ごとに来る）。 */
const ALIVE_MS = 75_000;
/** 待ちの項目に長いポーリングが来なくなったら捨てるまで（mod の hook が外れた・Esc 等）。 */
const ORPHAN_MS = 60_000;
/** 質問の待ちの上限（PC の TUI と並んでいるので長くてよい）。 */
const QUESTION_TTL_MS = 60 * 60_000;
/** モバイルが繋がっていない状態が続いたら承認の待ちを打ち切るまで（一時的な切断は待つ）。 */
const APPROVAL_PRESENCE_GRACE_MS = 30_000;
/** 送った発言の受け取り（ack）を待つ上限。過ぎたら mod の中で待ち行列に入ったとみなす。 */
const SUBMIT_ACK_MS = 15_000;
/** 送る相手（コマンドの長いポーリング）が来るのを待つ上限。来なければキーの経路へ戻す。 */
const SUBMIT_PICKUP_MS = 1_500;
const MAX_LONG_POLLS = 256;
const MAX_LONG_POLLS_PER_TOKEN = 16;
const MAX_PENDING_PER_TOKEN = 32;
const MAX_EVENTS_PER_REQUEST = 512;
const MAX_ID_LENGTH = 200;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const SWEEP_MS = 5_000;
/**
 * 送り主を確かめた結果を覚えておく時間（会話ごと）。この記憶を使うのは表示にしか効かない便（生成中の文章と、応答の
 * 文章・思考だけの行）に限る。記憶は送り主を区別しない（同じトークンを持つ別のプロセスにも効く）ので、状態を動かしうる
 * 行（ツールの呼び出し・結果・添付・発言）を含む便は、その便ごとに確かめる。
 */
const CALLER_VERIFIED_TTL_MS = 60_000;
/**
 * 送り主がそのペインのプロセスだと確かめられなくても受ける出来事（会話の行と生成中の文章）。表示が変わるだけで、
 * ターンの区切り・承認・質問・送信のような状態は動かさない（hook の許可待ちと同じ考え方。トークンは同じユーザーの
 * 別プロセスからも読めるので、偽の終わりや偽の回答待ちで画面と操作を取り違えさせない）。
 */
function paradisIsObservationEvent(event: Record<string, unknown> | undefined): boolean {
	if (event?.type === 'step') {
		return true;
	}
	const message = event?.type === 'row' ? rec(event.message) : undefined;
	return message !== undefined && paradisIsDisplayOnlyModRow(event?.door, message.role, message.content);
}

/** モバイルとの繋がり。off: モバイル連携が無効、enabled: 有効だが今は繋がっていない、connected: 繋がっている。 */
export type ParadisClaudeModPresence = 'off' | 'enabled' | 'connected';

/** AskUserQuestion の 1 問（mod が tool.call の入力をそのまま送ってくる）。 */
export interface IParadisClaudeModQuestion {
	readonly question: string;
	readonly header?: string;
	readonly multiSelect: boolean;
	readonly options: readonly { readonly label: string }[];
}

/** 回答待ちの質問（ParadisMobileAgentChat がモバイルのカードと突き合わせる）。 */
export interface IParadisClaudeModPendingQuestion {
	readonly id: string;
	readonly toolUseId?: string;
	readonly agentId?: string;
	readonly questions: readonly IParadisClaudeModQuestion[];
}

/** 回答待ちの承認。 */
export interface IParadisClaudeModPendingPermission {
	readonly id: string;
	readonly toolUseId?: string;
	readonly agentId?: string;
	readonly toolName: string;
	readonly toolInput: unknown;
	/** 「以後は確認しない」で足せるルールがあるか（PermissionRequest の permission_suggestions）。 */
	readonly hasSuggestions: boolean;
	/** その permission_suggestions（切り詰め済み）。カードに足されるルールを出すのに使う。 */
	readonly suggestions: readonly unknown[];
}

export type ParadisClaudeModEvent = { readonly token: string; readonly sessionId: string; readonly at: number } & (
	| { readonly type: 'hello'; readonly version?: string }
	| { readonly type: 'bye'; readonly reason?: string }
	/** 会話に残る行（transcript と同じ uuid）。本会話の prompt / response だけ。 */
	/**
	 * `verified` は、この行を送ってきた送り主がそのペインのプロセスだと（その便か直前 60 秒の確かめで）分かっているか。
	 * 分かっていない行は表示にだけ使う（ParadisMobileAgentChat は応答の文章と思考だけを受け、ほかを含む行は捨てる）。
	 */
	| { readonly type: 'row'; readonly uuid: string; readonly door: 'prompt' | 'response'; readonly origin?: string; readonly verified: boolean; readonly message: { readonly type: string; readonly role?: string; readonly isMeta?: boolean; readonly name?: string; readonly content: unknown } }
	| { readonly type: 'tool-results'; readonly agentId?: string; readonly ids: readonly string[]; readonly errorIds: readonly string[] }
	| { readonly type: 'turn.start'; readonly turnId: string }
	| { readonly type: 'turn.complete'; readonly turnId: string; readonly agentId?: string; readonly reason?: string; readonly aborted: boolean }
	/** 生成中の文章（本会話のみ）。chunks は block の index ごとに連結済みの差分。 */
	| { readonly type: 'step'; readonly turnId: string; readonly step: number; readonly chunks: readonly { readonly index: number; readonly text: string }[]; readonly end: boolean }
	| { readonly type: 'subagent.start'; readonly agentId: string; readonly toolUseId?: string; readonly subagentType?: string; readonly description?: string; readonly name?: string }
	| { readonly type: 'subagent.resume'; readonly agentId: string; readonly agentType?: string }
	| { readonly type: 'tool.check'; readonly toolUseId: string; readonly tool: string }
	/** 質問・承認の待ちが増えた・終わった（ParadisMobileAgentChat がカードの選択肢を直す）。 */
	| { readonly type: 'pending-changed'; readonly kind: 'question' | 'permission' }
);

export interface IParadisClaudeModReply {
	readonly status: number;
	readonly body: Record<string, unknown>;
	/** 返事を相手へ書けなかったとき（長いポーリングの相手が先に切れていた）に呼ぶ。渡したはずのものを戻す。 */
	readonly onNotDelivered?: () => void;
}

/** 送った発言の行方（{@link ParadisClaudeModBridge.submitPrompt}）。 */
export type ParadisClaudeModSubmitResult = 'accepted' | 'unavailable' | 'refused' | 'unconfirmed';

type SubmitOutcome = 'ok' | 'received' | 'refused' | 'undelivered';
/** 「受け取った」の後、最後の ack（送れたか）を待つ上限。過ぎたら失敗の知らせは出さない。 */
const SUBMIT_FINAL_ACK_MS = 10 * 60_000;

type WaitOutcome =
	| { readonly state: 'answer'; readonly answers?: Record<string, string>; readonly annotations?: Record<string, unknown>; readonly decision?: 'allow' | 'deny'; readonly always?: boolean }
	| { readonly state: 'settled' }
	| { readonly state: 'expired' };

interface IPendingItem {
	readonly id: string;
	readonly kind: 'question' | 'permission';
	readonly token: string;
	readonly sessionId: string;
	readonly expiresAt: number;
	readonly question?: IParadisClaudeModPendingQuestion;
	readonly permission?: IParadisClaudeModPendingPermission;
	outcome?: WaitOutcome;
	waiter?: (outcome: WaitOutcome | undefined) => void;
	lastPollAt: number;
	presenceLostAt?: number;
}

interface ISessionState {
	lastSeen: number;
	busy: boolean;
	commandWaiter?: (commands: readonly Record<string, unknown>[]) => void;
	/** 渡した発言の id → その行方を知らせる口（ack・会話の行・書けなかった知らせのどれか早いもの）。 */
	readonly acks: Map<string, (outcome: SubmitOutcome) => void>;
	/** 渡した発言の id → 本文（mod の会話の行で受理を確かめるため）。 */
	readonly submitted: Map<string, string>;
	readonly pickups: Set<() => void>;
}

function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function id(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined;
}

function text(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined;
}

function parseQuestions(value: unknown): IParadisClaudeModQuestion[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
		return undefined;
	}
	const questions: IParadisClaudeModQuestion[] = [];
	for (const candidate of value) {
		const question = rec(candidate);
		const questionText = text(question?.question, 10_000);
		if (question === undefined || questionText === undefined) {
			return undefined;
		}
		const options = Array.isArray(question.options)
			? question.options.map(option => text(rec(option)?.label, 2_000)).filter((label): label is string => label !== undefined).slice(0, 16).map(label => ({ label }))
			: [];
		const header = text(question.header, 200);
		questions.push({ question: questionText, ...(header !== undefined ? { header } : {}), multiSelect: question.multiSelect === true, options });
	}
	return questions;
}

export class ParadisClaudeModBridge {

	private readonly _onEvent = new Emitter<ParadisClaudeModEvent>();
	/** mod から届いた出来事（認証済み・形を確かめたもの）。shared process 内限定。 */
	readonly onEvent: Event<ParadisClaudeModEvent> = this._onEvent.event;

	private readonly sessions = new Map<string, ISessionState>();
	/** 会話（`token\0sessionId`）→ 送り主をそのペインのプロセスだと確かめた時刻。 */
	private readonly callerVerifiedAt = new Map<string, number>();
	private readonly pending = new Map<string, IPendingItem>();
	private readonly longPollsByToken = new Map<string, number>();
	private longPolls = 0;
	private presence: () => ParadisClaudeModPresence = () => 'off';
	private approvalWaitMs: () => number = () => 0;
	private sweepTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly now: () => number = Date.now) { }

	/** モバイルとの繋がりを教える口（ParadisMobileRelayService が入れる）。 */
	setPresence(presence: () => ParadisClaudeModPresence): void {
		this.presence = presence;
	}

	/** モバイルの承認を待つ上限（ParadisAgentBrowserService が設定から入れる）。 */
	setApprovalWait(approvalWaitMs: () => number): void {
		this.approvalWaitMs = approvalWaitMs;
	}

	dispose(): void {
		if (this.sweepTimer !== undefined) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
		for (const item of [...this.pending.values()]) {
			this.finish(item, { state: 'expired' });
		}
		for (const state of this.sessions.values()) {
			state.commandWaiter?.([]);
		}
		this.sessions.clear();
		this._onEvent.dispose();
	}

	// ---- 受け口 ----------------------------------------------------------------------------------

	/**
	 * 認証済みの要求を 1 件処理する。`signal` は相手が切れたとき（長いポーリングを外すため）。
	 * 呼び出し側（ParadisAgentBrowserService）は返された status と JSON をそのまま返す。
	 */
	async handle(token: string, op: string, body: unknown, signal: AbortSignal, verifyCaller: () => Promise<boolean>): Promise<IParadisClaudeModReply> {
		const request = rec(body);
		const sessionId = typeof request?.sessionId === 'string' && SESSION_ID_PATTERN.test(request.sessionId) ? request.sessionId : undefined;
		if (request === undefined || sessionId === undefined) {
			return { status: 400, body: { error: 'bad request' } };
		}
		if (op === 'event') {
			if (!Array.isArray(request.events)) {
				return { status: 400, body: { error: 'bad request' } };
			}
			// 観測だけの便（ほとんどがこれ）は送り主を確かめ直さない（確かめはプロセス表を引くので重い）。
			// 直前 60 秒に同じ会話で確かめていれば、確かめたものとして扱う（コマンドの長いポーリングが 25 秒ごとに確かめる）
			const events = request.events.slice(0, MAX_EVENTS_PER_REQUEST);
			const observationOnly = events.every(event => paradisIsObservationEvent(rec(event)));
			const verified = observationOnly ? this.recentlyVerified(token, sessionId) : await this.verify(token, sessionId, verifyCaller);
			return this.handleEvents(token, sessionId, verified ? this.touch(token, sessionId) : undefined, events);
		}
		// 状態を動かす要求は、送り主がそのペインのプロセスだと確かめられたときだけ受ける
		if (!(await this.verify(token, sessionId, verifyCaller))) {
			return { status: 403, body: { error: 'caller not verified' } };
		}
		const state = this.touch(token, sessionId);
		switch (op) {
			case 'question': return this.registerQuestion(token, sessionId, request);
			case 'permission': return this.registerPermission(token, sessionId, request);
			case 'wait': return this.waitFor(token, sessionId, id(request.id), signal);
			case 'settle': return this.handleSettle(token, sessionId, request.ids);
			case 'commands':
				state.busy = request.busy === true;
				return this.waitForCommands(token, state, signal);
			case 'ack': {
				const commandId = id(request.id);
				if (commandId !== undefined) {
					// received: mod が受け取り、これから `$.prompt.submit` する。その後はキーへ戻さない（二重に送らない）
					state.acks.get(commandId)?.(request.received === true ? 'received' : request.ok === true ? 'ok' : 'refused');
				}
				return { status: 200, body: {} };
			}
			default:
				return { status: 404, body: { error: 'unknown operation' } };
		}
	}

	private recentlyVerified(token: string, sessionId: string): boolean {
		const at = this.callerVerifiedAt.get(this.sessionKey(token, sessionId));
		return at !== undefined && this.now() - at <= CALLER_VERIFIED_TTL_MS;
	}

	private async verify(token: string, sessionId: string, verifyCaller: () => Promise<boolean>): Promise<boolean> {
		const verified = await verifyCaller();
		const key = this.sessionKey(token, sessionId);
		if (verified) {
			this.callerVerifiedAt.set(key, this.now());
		} else {
			this.callerVerifiedAt.delete(key);
		}
		return verified;
	}

	private sessionKey(token: string, sessionId: string): string {
		return `${token}\0${sessionId}`;
	}

	private touch(token: string, sessionId: string): ISessionState {
		const key = this.sessionKey(token, sessionId);
		let state = this.sessions.get(key);
		if (state === undefined) {
			state = { lastSeen: this.now(), busy: false, acks: new Map(), submitted: new Map(), pickups: new Set() };
			this.sessions.set(key, state);
			this.ensureSweep();
		}
		state.lastSeen = this.now();
		return state;
	}

	/** state が無い（送り主を確かめていない）ときは、会話の行と生成中の文章だけを受ける。 */
	private handleEvents(token: string, sessionId: string, state: ISessionState | undefined, events: readonly unknown[]): IParadisClaudeModReply {
		for (const candidate of events) {
			const event = rec(candidate);
			if (event === undefined || (state === undefined && !paradisIsObservationEvent(event))) {
				continue;
			}
			const at = typeof event.at === 'number' && Number.isFinite(event.at) ? Math.min(event.at, this.now()) : this.now();
			const base = { token, sessionId, at };
			switch (event.type) {
				case 'hello':
					this.fire({ ...base, type: 'hello', ...(text(event.version, 50) !== undefined ? { version: text(event.version, 50) } : {}) });
					break;
				case 'bye':
					// /clear でも bye が来る（会話の id が変わる）。待ちはどちらでも残らない。
					this.settleSession(token, sessionId, 'expired');
					this.fire({ ...base, type: 'bye', ...(text(event.reason, 50) !== undefined ? { reason: text(event.reason, 50) } : {}) });
					break;
				case 'row': {
					const uuid = id(event.uuid);
					const message = rec(event.message);
					const door = event.door === 'prompt' || event.door === 'response' ? event.door : undefined;
					const type = text(message?.type, 50);
					if (uuid !== undefined && door !== undefined && message !== undefined && type !== undefined && (typeof message.content === 'string' || Array.isArray(message.content))) {
						if (state !== undefined && door === 'prompt' && event.origin === 'plugin') {
							this.confirmSubmitted(token, sessionId, message.content);
						}
						this.fire({
							...base, type: 'row', uuid, door, verified: state !== undefined,
							...(text(event.origin, 50) !== undefined ? { origin: text(event.origin, 50) } : {}),
							message: {
								type,
								...(text(message.role, 20) !== undefined ? { role: text(message.role, 20) } : {}),
								...(message.isMeta === true ? { isMeta: true } : {}),
								...(text(message.name, 100) !== undefined ? { name: text(message.name, 100) } : {}),
								content: message.content,
							},
						});
					}
					break;
				}
				case 'tool-results': {
					const ids = Array.isArray(event.ids) ? event.ids.map(id).filter((value): value is string => value !== undefined).slice(0, 256) : [];
					const errorIds = Array.isArray(event.errorIds) ? event.errorIds.map(id).filter((value): value is string => value !== undefined).slice(0, 256) : [];
					// 結果が書かれた呼び出しの承認・質問は決着している（ターミナルで拒否したときは、これが唯一の手がかり）
					this.settleByToolUseIds(token, sessionId, ids);
					const agentId = id(event.agentId);
					this.fire({ ...base, type: 'tool-results', ids, errorIds, ...(agentId !== undefined ? { agentId } : {}) });
					break;
				}
				case 'turn.start': {
					const turnId = id(event.turnId);
					if (turnId !== undefined && state !== undefined) {
						state.busy = true;
						this.fire({ ...base, type: 'turn.start', turnId });
					}
					break;
				}
				case 'turn.complete': {
					const turnId = id(event.turnId);
					const agentId = id(event.agentId);
					if (turnId !== undefined && state !== undefined) {
						if (agentId === undefined) {
							state.busy = false;
							// ターンが終わった（Esc を含む）。残った待ちに答える相手はもう居ない
							this.settleSession(token, sessionId, 'settled');
						}
						this.fire({ ...base, type: 'turn.complete', turnId, aborted: event.aborted === true, ...(agentId !== undefined ? { agentId } : {}), ...(text(event.reason, 20) !== undefined ? { reason: text(event.reason, 20) } : {}) });
					}
					break;
				}
				case 'step': {
					const turnId = id(event.turnId);
					const step = typeof event.step === 'number' && Number.isSafeInteger(event.step) && event.step >= 0 ? event.step : undefined;
					const chunks = Array.isArray(event.chunks)
						? event.chunks.map(rec).filter((chunk): chunk is Record<string, unknown> => chunk !== undefined)
							.map(chunk => ({ index: typeof chunk.index === 'number' && Number.isSafeInteger(chunk.index) && chunk.index >= 0 ? chunk.index : -1, text: typeof chunk.text === 'string' ? chunk.text.slice(0, 200_000) : '' }))
							.filter(chunk => chunk.index >= 0 && chunk.text.length > 0).slice(0, 256)
						: [];
					if (turnId !== undefined && step !== undefined) {
						this.fire({ ...base, type: 'step', turnId, step, chunks, end: event.end === true });
					}
					break;
				}
				case 'subagent.start': {
					const agentId = id(event.agentId);
					if (agentId !== undefined) {
						const toolUseId = id(event.toolUseId);
						const subagentType = text(event.subagentType, 200);
						const description = text(event.description, 1_000);
						const name = text(event.name, 200);
						this.fire({
							...base, type: 'subagent.start', agentId,
							...(toolUseId !== undefined ? { toolUseId } : {}),
							...(subagentType !== undefined ? { subagentType } : {}),
							...(description !== undefined ? { description } : {}),
							...(name !== undefined ? { name } : {}),
						});
					}
					break;
				}
				case 'subagent.resume': {
					const agentId = id(event.agentId);
					const agentType = text(event.agentType, 200);
					if (agentId !== undefined) {
						this.fire({ ...base, type: 'subagent.resume', agentId, ...(agentType !== undefined ? { agentType } : {}) });
					}
					break;
				}
				case 'tool.check': {
					const toolUseId = id(event.toolUseId);
					const tool = text(event.tool, 200);
					if (toolUseId !== undefined && tool !== undefined) {
						this.fire({ ...base, type: 'tool.check', toolUseId, tool });
					}
					break;
				}
			}
		}
		return { status: 200, body: {} };
	}

	private fire(event: ParadisClaudeModEvent): void {
		this._onEvent.fire(event);
	}

	private countPending(token: string): number {
		let count = 0;
		for (const item of this.pending.values()) {
			if (item.token === token) {
				count++;
			}
		}
		return count;
	}

	private registerQuestion(token: string, sessionId: string, request: Record<string, unknown>): IParadisClaudeModReply {
		const questions = parseQuestions(request.questions);
		if (questions === undefined) {
			return { status: 400, body: { error: 'bad request' } };
		}
		// モバイル連携が無効なら待たない（mod は TUI のダイアログだけで答える）
		if (this.presence() === 'off' || this.countPending(token) >= MAX_PENDING_PER_TOKEN) {
			return { status: 200, body: { wait: false } };
		}
		const itemId = randomUUID();
		const toolUseId = id(request.toolUseId);
		const agentId = id(request.agentId);
		const now = this.now();
		this.pending.set(itemId, {
			id: itemId, kind: 'question', token, sessionId, expiresAt: now + QUESTION_TTL_MS, lastPollAt: now,
			question: { id: itemId, questions, ...(toolUseId !== undefined ? { toolUseId } : {}), ...(agentId !== undefined ? { agentId } : {}) },
		});
		this.ensureSweep();
		this.fire({ token, sessionId, at: now, type: 'pending-changed', kind: 'question' });
		return { status: 200, body: { id: itemId, wait: true } };
	}

	private registerPermission(token: string, sessionId: string, request: Record<string, unknown>): IParadisClaudeModReply {
		const toolName = text(request.toolName, 200);
		if (toolName === undefined) {
			return { status: 400, body: { error: 'bad request' } };
		}
		const waitMs = this.approvalWaitMs();
		// 既定ではモバイルが繋がっているときだけ待つ。PC の許可プロンプトは並んで出ている
		if (waitMs <= 0 || this.presence() !== 'connected' || this.countPending(token) >= MAX_PENDING_PER_TOKEN) {
			return { status: 200, body: { wait: false } };
		}
		const itemId = randomUUID();
		const toolUseId = id(request.toolUseId);
		const agentId = id(request.agentId);
		const now = this.now();
		this.pending.set(itemId, {
			id: itemId, kind: 'permission', token, sessionId, expiresAt: now + waitMs, lastPollAt: now,
			permission: {
				...this.sanitizedPermissionInput(toolName, request.toolInput, request.suggestions),
				id: itemId, toolName,
				...(toolUseId !== undefined ? { toolUseId } : {}),
				...(agentId !== undefined ? { agentId } : {}),
			},
		});
		this.ensureSweep();
		this.fire({ token, sessionId, at: now, type: 'pending-changed', kind: 'permission' });
		return { status: 200, body: { id: itemId, wait: true } };
	}

	/** 入力と permission_suggestions を hook と同じ上限・同じ伏せ字で持つ（カードへ出すので）。 */
	private sanitizedPermissionInput(toolName: string, toolInput: unknown, suggestions: unknown): { readonly toolInput: unknown; readonly suggestions: readonly unknown[]; readonly hasSuggestions: boolean } {
		const sanitized = paradisSanitizeAgentHookPayload({ tool_name: toolName, tool_input: toolInput, permission_suggestions: suggestions });
		const kept = Array.isArray(sanitized?.permission_suggestions) ? sanitized.permission_suggestions.slice(0, 16) : [];
		return { toolInput: sanitized?.tool_input, suggestions: kept, hasSuggestions: kept.length > 0 };
	}

	/** mod の会話に、送った発言（origin: plugin）が入った。ack より先に届けば、それで受理とみなす。 */
	private confirmSubmitted(token: string, sessionId: string, content: unknown): void {
		const state = this.sessions.get(this.sessionKey(token, sessionId));
		if (state === undefined || state.submitted.size === 0) {
			return;
		}
		const textOf = typeof content === 'string' ? content
			: Array.isArray(content) ? content.map(block => rec(block)).filter(block => block?.type === 'text').map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';
		for (const [commandId, submittedText] of state.submitted) {
			if (submittedText.trim() === textOf.trim()) {
				state.acks.get(commandId)?.('ok');
				return;
			}
		}
	}

	private reserveLongPoll(token: string): (() => void) | undefined {
		const count = this.longPollsByToken.get(token) ?? 0;
		if (this.longPolls >= MAX_LONG_POLLS || count >= MAX_LONG_POLLS_PER_TOKEN) {
			return undefined;
		}
		this.longPolls++;
		this.longPollsByToken.set(token, count + 1);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.longPolls = Math.max(0, this.longPolls - 1);
			const current = this.longPollsByToken.get(token) ?? 0;
			if (current <= 1) {
				this.longPollsByToken.delete(token);
			} else {
				this.longPollsByToken.set(token, current - 1);
			}
		};
	}

	private async waitFor(token: string, sessionId: string, itemId: string | undefined, signal: AbortSignal): Promise<IParadisClaudeModReply> {
		const item = itemId !== undefined ? this.pending.get(itemId) : undefined;
		if (item === undefined || item.token !== token || item.sessionId !== sessionId) {
			return { status: 200, body: { state: 'settled' } };
		}
		item.lastPollAt = this.now();
		if (item.outcome !== undefined) {
			this.pending.delete(item.id);
			return { status: 200, body: { ...item.outcome } };
		}
		const release = this.reserveLongPoll(token);
		if (release === undefined) {
			return { status: 429, body: { error: 'too many waits' } };
		}
		try {
			const outcome = await new Promise<WaitOutcome | undefined>(resolve => {
				const timer = setTimeout(() => done(undefined), LONG_POLL_MS);
				const onAbort = () => done(undefined);
				const done = (value: WaitOutcome | undefined) => {
					clearTimeout(timer);
					signal.removeEventListener('abort', onAbort);
					if (item.waiter === done) {
						item.waiter = undefined;
					}
					resolve(value);
				};
				// 前の長いポーリングが残っていれば（相手が張り直した）、それは空で返す
				item.waiter?.(undefined);
				item.waiter = done;
				signal.addEventListener('abort', onAbort);
			});
			item.lastPollAt = this.now();
			if (outcome === undefined) {
				return { status: 200, body: { state: 'pending' } };
			}
			this.pending.delete(item.id);
			return { status: 200, body: { ...outcome } };
		} finally {
			release();
		}
	}

	/** 待ちを決着させる。待っている長いポーリングがあればすぐ返し、無ければ次のポーリングで返す。 */
	private finish(item: IPendingItem, outcome: WaitOutcome): void {
		if (item.outcome !== undefined) {
			return;
		}
		item.outcome = outcome;
		const waiter = item.waiter;
		if (waiter !== undefined) {
			item.waiter = undefined;
			this.pending.delete(item.id);
			waiter(outcome);
		} else if (outcome.state !== 'answer') {
			// 答えでなければ受け取りを待たなくてよい（次のポーリングは「決着済み」になる）
			this.pending.delete(item.id);
		}
		this.fire({ token: item.token, sessionId: item.sessionId, at: this.now(), type: 'pending-changed', kind: item.kind });
	}

	private handleSettle(token: string, sessionId: string, value: unknown): IParadisClaudeModReply {
		const ids = Array.isArray(value) ? value.map(id).filter((candidate): candidate is string => candidate !== undefined).slice(0, 64) : [];
		for (const itemId of ids) {
			const item = this.pending.get(itemId);
			if (item !== undefined && item.token === token && item.sessionId === sessionId) {
				this.finish(item, { state: 'settled' });
			}
		}
		return { status: 200, body: {} };
	}

	private settleByToolUseIds(token: string, sessionId: string, toolUseIds: readonly string[]): void {
		if (toolUseIds.length === 0) {
			return;
		}
		const ids = new Set(toolUseIds);
		for (const item of [...this.pending.values()]) {
			const toolUseId = item.question?.toolUseId ?? item.permission?.toolUseId;
			if (item.token === token && item.sessionId === sessionId && toolUseId !== undefined && ids.has(toolUseId)) {
				this.finish(item, { state: 'settled' });
			}
		}
	}

	private settleSession(token: string, sessionId: string, state: 'settled' | 'expired'): void {
		for (const item of [...this.pending.values()]) {
			if (item.token === token && item.sessionId === sessionId) {
				this.finish(item, { state });
			}
		}
	}

	private async waitForCommands(token: string, state: ISessionState, signal: AbortSignal): Promise<IParadisClaudeModReply> {
		const release = this.reserveLongPoll(token);
		if (release === undefined) {
			return { status: 429, body: { error: 'too many waits' } };
		}
		try {
			const commands = await new Promise<readonly Record<string, unknown>[]>(resolve => {
				const timer = setTimeout(() => done([]), LONG_POLL_MS);
				const onAbort = () => done([]);
				const done = (value: readonly Record<string, unknown>[]) => {
					clearTimeout(timer);
					signal.removeEventListener('abort', onAbort);
					if (state.commandWaiter === done) {
						state.commandWaiter = undefined;
					}
					resolve(value);
				};
				state.commandWaiter?.([]);
				state.commandWaiter = done;
				signal.addEventListener('abort', onAbort);
				for (const pickup of [...state.pickups]) {
					pickup();
				}
			});
			const undelivered = () => {
				for (const command of commands) {
					const commandId = id(command.id);
					if (commandId !== undefined) {
						state.acks.get(commandId)?.('undelivered');
					}
				}
			};
			if (signal.aborted && commands.length > 0) {
				// 渡そうとした時にはもう相手が切れていた
				undelivered();
				return { status: 200, body: { commands: [] } };
			}
			return { status: 200, body: { commands }, ...(commands.length > 0 ? { onNotDelivered: undelivered } : {}) };
		} finally {
			release();
		}
	}

	private ensureSweep(): void {
		if (this.sweepTimer === undefined) {
			this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
		}
	}

	/** 期限切れ・見捨てられた待ちと、死んだ mod の記録を片付ける。 */
	sweep(): void {
		const now = this.now();
		const presence = this.presence();
		for (const item of [...this.pending.values()]) {
			if (item.kind === 'permission') {
				if (presence !== 'connected') {
					item.presenceLostAt ??= now;
				} else {
					item.presenceLostAt = undefined;
				}
			}
			const orphaned = item.waiter === undefined && now - item.lastPollAt > ORPHAN_MS;
			const presenceLost = item.presenceLostAt !== undefined && now - item.presenceLostAt > APPROVAL_PRESENCE_GRACE_MS;
			if (now > item.expiresAt || orphaned || presenceLost) {
				if (item.outcome !== undefined) {
					this.pending.delete(item.id);
				} else {
					this.finish(item, { state: 'expired' });
				}
			}
		}
		for (const [key, state] of [...this.sessions]) {
			if (state.commandWaiter === undefined && now - state.lastSeen > ALIVE_MS * 2) {
				this.sessions.delete(key);
			}
		}
		for (const [key, at] of [...this.callerVerifiedAt]) {
			if (now - at > CALLER_VERIFIED_TTL_MS) {
				this.callerVerifiedAt.delete(key);
			}
		}
		if (this.pending.size === 0 && this.sessions.size === 0 && this.sweepTimer !== undefined) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
	}

	// ---- ParadisMobileAgentChat から使う口 -------------------------------------------------------

	/** この会話で mod が生きているか（読み込まれていない・止まったなら false で、今の経路だけで動く）。 */
	isAlive(token: string, sessionId: string | undefined): boolean {
		const state = sessionId !== undefined ? this.sessions.get(this.sessionKey(token, sessionId)) : undefined;
		return state !== undefined && (state.commandWaiter !== undefined || this.now() - state.lastSeen <= ALIVE_MS);
	}

	/** mod から見て本会話のターンが走っているか。 */
	isBusy(token: string, sessionId: string): boolean {
		return this.sessions.get(this.sessionKey(token, sessionId))?.busy === true;
	}

	pendingQuestions(token: string, sessionId: string | undefined): IParadisClaudeModPendingQuestion[] {
		return [...this.pending.values()].filter(item => item.kind === 'question' && item.token === token && item.sessionId === sessionId && item.outcome === undefined && item.question !== undefined).map(item => item.question!);
	}

	pendingPermissions(token: string, sessionId: string | undefined): IParadisClaudeModPendingPermission[] {
		return [...this.pending.values()].filter(item => item.kind === 'permission' && item.token === token && item.sessionId === sessionId && item.outcome === undefined && item.permission !== undefined).map(item => item.permission!);
	}

	/** モバイルの回答を mod へ渡す。もう待っていなければ false（呼び出し側はキーの経路へ戻さない）。 */
	answerQuestion(token: string, itemId: string, answers: Record<string, string>): boolean {
		const item = this.pending.get(itemId);
		if (item === undefined || item.kind !== 'question' || item.token !== token || item.outcome !== undefined) {
			return false;
		}
		this.finish(item, { state: 'answer', answers });
		return true;
	}

	answerPermission(token: string, itemId: string, decision: 'allow' | 'deny', always: boolean): boolean {
		const item = this.pending.get(itemId);
		if (item === undefined || item.kind !== 'permission' || item.token !== token || item.outcome !== undefined) {
			return false;
		}
		this.finish(item, { state: 'answer', decision, ...(always && decision === 'allow' && item.permission?.hasSuggestions === true ? { always: true } : {}) });
		return true;
	}

	/**
	 * 待機中の会話へ発言を送る（mod の `$.prompt.submit`）。
	 * - `accepted`: mod が送ったと答えた、または送った発言が mod の会話の行に現れた
	 * - `unavailable`: mod へ渡せなかった（渡していないので、呼び出し側はキーの経路で送ってよい）
	 * - `refused`: mod が送れなかったと答えた（何も送っていないので、キーの経路で送ってよい）
	 * - `unconfirmed`: 渡したが、ack も会話の行も来なかった。呼び出し側が transcript で確かめる
	 */
	async submitPrompt(token: string, sessionId: string, promptText: string, onLateFailure?: () => void): Promise<ParadisClaudeModSubmitResult> {
		const state = this.sessions.get(this.sessionKey(token, sessionId));
		if (state === undefined) {
			return 'unavailable';
		}
		if (state.commandWaiter === undefined) {
			// 長いポーリングの張り直しの合間かもしれない。少しだけ待つ
			const picked = await new Promise<boolean>(resolve => {
				const pickup = () => {
					clearTimeout(timer);
					state.pickups.delete(pickup);
					resolve(true);
				};
				const timer = setTimeout(() => {
					state.pickups.delete(pickup);
					resolve(false);
				}, SUBMIT_PICKUP_MS);
				state.pickups.add(pickup);
			});
			if (!picked) {
				return 'unavailable';
			}
		}
		const waiter = state.commandWaiter;
		if (waiter === undefined) {
			return 'unavailable';
		}
		const commandId = randomUUID();
		const outcome = new Promise<SubmitOutcome | undefined>(resolve => {
			const settle = (value: SubmitOutcome | undefined) => {
				clearTimeout(timer);
				state.acks.delete(commandId);
				state.submitted.delete(commandId);
				resolve(value);
			};
			const timer = setTimeout(() => settle(undefined), SUBMIT_ACK_MS);
			state.acks.set(commandId, settle);
			state.submitted.set(commandId, promptText);
		});
		state.commandWaiter = undefined;
		waiter([{ id: commandId, kind: 'submit', text: promptText }]);
		switch (await outcome) {
			case 'received': {
				// mod が受け取り、これから送る。最後の ack で送れなかったと分かったら知らせる（キーでは送り直さない）
				const finalTimer = setTimeout(() => state.acks.delete(commandId), SUBMIT_FINAL_ACK_MS);
				state.acks.set(commandId, final => {
					clearTimeout(finalTimer);
					state.acks.delete(commandId);
					if (final === 'refused') {
						onLateFailure?.();
					}
				});
				state.busy = true;
				return 'accepted';
			}
			case 'ok':
				state.busy = true;
				return 'accepted';
			case 'refused': return 'refused';
			case 'undelivered': return 'unavailable';
			default: return 'unconfirmed';
		}
	}

	/** ペインが消えた。そのペインの待ちと記録を捨てる。 */
	forgetToken(token: string): void {
		for (const item of [...this.pending.values()]) {
			if (item.token === token) {
				this.finish(item, { state: 'expired' });
			}
		}
		for (const [key, state] of [...this.sessions]) {
			if (key.startsWith(`${token}\0`)) {
				state.commandWaiter?.([]);
				this.sessions.delete(key);
			}
		}
		for (const key of [...this.callerVerifiedAt.keys()]) {
			if (key.startsWith(`${token}\0`)) {
				this.callerVerifiedAt.delete(key);
			}
		}
	}
}

/** shared process に 1 つだけ（hook バスと同じ方式）。 */
export const paradisClaudeModBridge = new ParadisClaudeModBridge();
