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
//  - 停止（`commands` / `ack`）: バックグラウンドのシェルを mod の `$.tool.call({ tool: 'TaskStop' })` で止める（{@link ParadisClaudeModBridge.stopTask}）
//  - スラッシュコマンド（`commands` / `ack`。mod 1.2.0 以降。`commands` の要求の `features` で分かる）: 一覧を mod の
//    `$.command.list()` で取り（{@link ParadisClaudeModBridge.listCommands}）、モバイルの `/name args` を `$.command.run` で
//    実行する（{@link ParadisClaudeModBridge.runCommand}）
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
/** スラッシュコマンドの一覧（mod の `$.command.list()`）の返事を待つ上限。過ぎたらファイルから組み立てる。 */
const LIST_ACK_MS = 3_000;
/** 画面が開いているかの問い合わせ（{@link ParadisClaudeModBridge.isDialogOpen}）の返事を待つ上限。 */
const DIALOG_ACK_MS = 1_500;
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
	/** preview は TUI が選択肢の横に描く下書き（元の文字列のまま。回答の annotations に入れて返す）。 */
	readonly options: readonly { readonly label: string; readonly description?: string; readonly preview?: string }[];
}

/** 質問の回答に添える注記（Claude Code の `annotations[質問文]`）。 */
export interface IParadisClaudeModQuestionAnnotation {
	readonly preview?: string;
	readonly notes?: string;
}

/**
 * 「質問に答えずに話す」（TUI の「Chat about this」）。`response` はメッセージ（mod は `{ result: { questions, answers: {}, response } }`
 * を返し、モデルは「The user responded: …」を読む）、`deny` はメッセージが無いときの拒否の文面（mod は `{ deny }` を返す）。
 */
export type ParadisClaudeModQuestionClarify = { readonly kind: 'response'; readonly response: string } | { readonly kind: 'deny'; readonly deny: string };

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
	/** 拒否に添えた文を Claude Code へ渡せる mod か（登録に `denyMessage: true` を付けてくる版）。古い mod は固定の文で拒否する。 */
	readonly acceptsDenyMessage: boolean;
}

export type ParadisClaudeModEvent = { readonly token: string; readonly sessionId: string; readonly at: number } & (
	| { readonly type: 'hello'; readonly version?: string }
	| { readonly type: 'bye'; readonly reason?: string }
	/** 会話に残る行（transcript と同じ uuid）。本会話の prompt / response だけ。 */
	/**
	 * `verified` は、この行を送ってきた送り主がそのペインのプロセスだと（その便か直前 60 秒の確かめで）分かっているか。
	 * 分かっていない行は表示にだけ使う（ParadisMobileAgentChat は応答の文章と思考だけを受け、ほかを含む行は捨てる）。
	 */
	| { readonly type: 'row'; readonly uuid: string; readonly door: 'prompt' | 'response'; readonly origin?: string; readonly verified: boolean; readonly advisorModel?: string; readonly message: { readonly type: string; readonly role?: string; readonly isMeta?: boolean; readonly name?: string; readonly content: unknown } }
	| { readonly type: 'tool-results'; readonly agentId?: string; readonly ids: readonly string[]; readonly errorIds: readonly string[] }
	| { readonly type: 'turn.start'; readonly turnId: string }
	| { readonly type: 'turn.complete'; readonly turnId: string; readonly agentId?: string; readonly reason?: string; readonly aborted: boolean }
	/** 生成中の文章（本会話のみ）。chunks は block の index ごとに連結済みの差分。 */
	| { readonly type: 'step'; readonly turnId: string; readonly step: number; readonly chunks: readonly { readonly index: number; readonly text: string }[]; readonly end: boolean }
	| { readonly type: 'subagent.start'; readonly agentId: string; readonly toolUseId?: string; readonly subagentType?: string; readonly description?: string; readonly name?: string }
	| { readonly type: 'subagent.resume'; readonly agentId: string; readonly agentType?: string }
	| { readonly type: 'tool.check'; readonly toolUseId: string; readonly tool: string }
	/** Claude Code の `session.measure` の `context`（statusline と同じコンテキストの値。mod 1.3.0 以降）。 */
	| { readonly type: 'measure'; readonly window: number; readonly tokens?: number; readonly percent?: number }
	/** 質問・承認の待ちが増えた・終わった（ParadisMobileAgentChat がカードの選択肢を直す）。 */
	| { readonly type: 'pending-changed'; readonly kind: 'question' | 'permission' }
	/** {@link ParadisClaudeModBridge.isAlive} の答えが変わった（来た・途絶えた・ペインが消えた）。停止の可否を送り直すのに使う。 */
	| { readonly type: 'alive-changed'; readonly alive: boolean }
);

export interface IParadisClaudeModReply {
	readonly status: number;
	readonly body: Record<string, unknown>;
	/** 返事を相手へ書けなかったとき（長いポーリングの相手が先に切れていた）に呼ぶ。渡したはずのものを戻す。 */
	readonly onNotDelivered?: () => void;
}

/**
 * 止める頼みの行方（{@link ParadisClaudeModBridge.stopTask}）。
 * - `stopped`: mod が TaskStop を呼び、止まったと答えた
 * - `refused`: mod が TaskStop を呼んだが止まらなかった（もう終わっていた等。`message` に Claude Code の文面）
 * - `unavailable`: mod へ渡せなかった
 * - `unconfirmed`: 渡したが答えが来なかった
 */
export type ParadisClaudeModStopResult = { readonly outcome: 'stopped' | 'refused' | 'unavailable' | 'unconfirmed'; readonly message?: string };

/** mod ができること（`commands` の要求の `features`）。古い mod は送ってこない。 */
export type ParadisClaudeModFeature = 'commands.list' | 'command.run' | 'prompt.dialog';
const KNOWN_FEATURES: readonly ParadisClaudeModFeature[] = ['commands.list', 'command.run', 'prompt.dialog'];

/**
 * スラッシュコマンドの行方（{@link ParadisClaudeModBridge.runCommand}）。
 * - `accepted`: 実行した、または mod が受け取って実行中（画面を開くコマンドは閉じるまで終わらない）
 * - `refused`: Claude Code が断った（`message` に理由。名前が無いときは `no command named ...`）。何も実行していない
 * - `unavailable`: mod へ渡せなかった（キーの経路で送ってよい）
 * - `busy`: mod が別の発言を送っている最中で断った（何もしていない）
 * - `unconfirmed`: 渡したが返事が無かった
 * - `stale`: mod の会話が切り替わっていた（`/clear` 等。何もしていない）
 * - `panel-open`: 承認・質問以外の画面（`/config` など）が PC でキーを持っている（何もしていない。キーも打たないこと）
 */
export type ParadisClaudeModRunCommandResult = {
	readonly outcome: 'accepted' | 'refused' | 'unavailable' | 'busy' | 'unconfirmed' | 'stale' | 'panel-open'; readonly message?: string;
	/** `accepted` のうち、mod が受け取ってまだ実行中のもの（画面を開くコマンドは閉じるまで、`/compact` は終わるまで終わらない）。 */
	readonly running?: true;
};

/** 送った発言の行方（{@link ParadisClaudeModBridge.submitPrompt}）。 */
export type ParadisClaudeModSubmitResult = 'accepted' | 'unavailable' | 'refused' | 'unconfirmed' | 'busy' | 'stale' | 'panel-open';

/** busy: mod が別の発言を送っている最中で断った（ack の `reason: 'busy'`）。何も送っていない。 */
type SubmitOutcome = 'ok' | 'received' | 'refused' | 'undelivered' | 'busy' | 'stale' | 'panel-open';
/** 渡した発言のターンが始まる（`turn.start`）のを待つ上限。過ぎたら busy の保持をやめる。 */
const HELD_BUSY_BEFORE_TURN_MS = 30_000;
/** ターンが始まってから busy を保持する上限（`turn.complete` が来ないまま固まらないように）。 */
const HELD_BUSY_TURN_MS = 10 * 60_000;
/** 「受け取った」の後、最後の ack（送れたか）を待つ上限。過ぎたら失敗の知らせは出さない。 */
const SUBMIT_FINAL_ACK_MS = 10 * 60_000;

type WaitOutcome =
	| { readonly state: 'answer'; readonly answers?: Record<string, string>; readonly annotations?: Record<string, IParadisClaudeModQuestionAnnotation>; readonly decision?: 'allow' | 'deny'; readonly always?: boolean; readonly message?: string }
	| { readonly state: 'clarify'; readonly response?: string; readonly deny?: string }
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
	/**
	 * mod に発言を渡した（`received` / `ok`）。その発言のターンが終わる（本会話の `turn.complete`）まで busy を下ろさない。
	 * mod のポーリングは `$.prompt.submit` を待たずに `busy: false` で来ることがあり、それで下ろすと次の発言を mod へ
	 * 渡してしまう（mod は 1 通ずつしか送らず、2 通目は断る）。
	 */
	heldBusy: boolean;
	/** {@link heldBusy} を下ろす期限（received から 30 秒。ターンが始まったら 10 分）。 */
	heldBusyUntil?: number;
	/** mod の最後のポーリングが言った busy（保持をやめたときに戻す値）。 */
	pollBusy: boolean;
	commandWaiter?: (commands: readonly Record<string, unknown>[]) => void;
	/**
	 * 渡した発言の id → その行方を知らせる口（ack・会話の行・書けなかった知らせのどれか早いもの）。停止の頼みは ack の文面も、
	 * 一覧の頼みは ack の中身（`payload`）も渡す。
	 */
	readonly acks: Map<string, (outcome: SubmitOutcome, message?: string, payload?: Record<string, unknown>) => void>;
	/** mod が `commands` の要求で知らせた、できること（古い mod は空）。 */
	features: ReadonlySet<ParadisClaudeModFeature>;
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

/** トークンの数（0 以上の安全な整数。上限は 1 億）。 */
function tokenCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000 ? value : undefined;
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
		const options: { label: string; description?: string; preview?: string }[] = [];
		for (const candidateOption of Array.isArray(question.options) ? question.options : []) {
			const option = rec(candidateOption);
			const label = text(option?.label, 2_000);
			if (label === undefined) {
				continue;
			}
			const description = text(option?.description, 2_000);
			// preview は空文字も「ある」（TUI は undefined かどうかで決める）
			const preview = typeof option?.preview === 'string' ? option.preview.slice(0, 20_000) : undefined;
			options.push({ label, ...(description !== undefined ? { description } : {}), ...(preview !== undefined ? { preview } : {}) });
			if (options.length >= 16) {
				break;
			}
		}
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
	/** 会話ごとに最後に知らせた生き死に（`alive-changed` を境目でだけ出すため）。 */
	private readonly aliveNotified = new Map<string, boolean>();
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
				state.features = new Set(Array.isArray(request.features) ? KNOWN_FEATURES.filter(feature => (request.features as unknown[]).includes(feature)) : []);
				state.pollBusy = request.busy === true;
				state.busy = state.pollBusy || this.holdsBusy(state);
				return this.waitForCommands(token, state, signal);
			case 'ack': {
				const commandId = id(request.id);
				if (commandId !== undefined) {
					// received: mod が受け取り、これから `$.prompt.submit` する。その後はキーへ戻さない（二重に送らない）
					state.acks.get(commandId)?.(request.received === true ? 'received' : request.ok === true ? 'ok' : request.reason === 'busy' ? 'busy' : request.reason === 'stale' ? 'stale' : request.reason === 'panel-open' ? 'panel-open' : 'refused', text(request.message, 500), request);
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
			state = { lastSeen: this.now(), busy: false, heldBusy: false, pollBusy: false, acks: new Map(), submitted: new Map(), pickups: new Set(), features: new Set() };
			this.sessions.set(key, state);
			this.ensureSweep();
		}
		state.lastSeen = this.now();
		this.noteAlive(token, sessionId);
		return state;
	}

	/** 生き死にが前に知らせたものと変わっていれば `alive-changed` を出す。 */
	private noteAlive(token: string, sessionId: string): void {
		const key = this.sessionKey(token, sessionId);
		const alive = this.isAlive(token, sessionId);
		if ((this.aliveNotified.get(key) ?? false) === alive) {
			return;
		}
		if (alive) {
			this.aliveNotified.set(key, true);
		} else {
			this.aliveNotified.delete(key);
		}
		this.fire({ token, sessionId, at: this.now(), type: 'alive-changed', alive });
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
							// transcript の行と同じく、Advisor のモデル名が行に付いていれば写す（会話の Advisor の行に出す）
							...(text(event.advisorModel, 100) !== undefined ? { advisorModel: text(event.advisorModel, 100) } : {}),
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
						if (state.heldBusy) {
							state.heldBusyUntil = this.now() + HELD_BUSY_TURN_MS;
						}
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
							this.releaseHeldBusy(state);
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
				case 'measure': {
					const context = rec(event.context);
					const window = tokenCount(context?.window);
					const tokens = tokenCount(context?.tokens);
					const percent = typeof context?.percent === 'number' && Number.isFinite(context.percent) && context.percent >= 0 && context.percent <= 100 ? context.percent : undefined;
					if (state !== undefined && window !== undefined && window > 0) {
						this.fire({ ...base, type: 'measure', window, ...(tokens !== undefined ? { tokens } : {}), ...(percent !== undefined ? { percent } : {}) });
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
				id: itemId, toolName, acceptsDenyMessage: request.denyMessage === true,
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
		} else if (outcome.state !== 'answer' && outcome.state !== 'clarify') {
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
		for (const key of new Set([...this.sessions.keys(), ...this.aliveNotified.keys()])) {
			const separator = key.indexOf('\0');
			this.noteAlive(key.slice(0, separator), key.slice(separator + 1));
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
		const state = this.sessions.get(this.sessionKey(token, sessionId));
		if (state !== undefined && state.heldBusy && !this.holdsBusy(state)) {
			state.busy = state.pollBusy;
		}
		return state?.busy === true;
	}

	/** 渡した発言のために busy を保持しているか。期限を過ぎていたら下ろす。 */
	private holdsBusy(state: ISessionState): boolean {
		if (state.heldBusy && state.heldBusyUntil !== undefined && this.now() > state.heldBusyUntil) {
			this.releaseHeldBusy(state);
		}
		return state.heldBusy;
	}

	private releaseHeldBusy(state: ISessionState): void {
		state.heldBusy = false;
		state.heldBusyUntil = undefined;
	}

	pendingQuestions(token: string, sessionId: string | undefined): IParadisClaudeModPendingQuestion[] {
		return [...this.pending.values()].filter(item => item.kind === 'question' && item.token === token && item.sessionId === sessionId && item.outcome === undefined && item.question !== undefined).map(item => item.question!);
	}

	pendingPermissions(token: string, sessionId: string | undefined): IParadisClaudeModPendingPermission[] {
		return [...this.pending.values()].filter(item => item.kind === 'permission' && item.token === token && item.sessionId === sessionId && item.outcome === undefined && item.permission !== undefined).map(item => item.permission!);
	}

	/**
	 * モバイルの回答を mod へ渡す。もう待っていなければ false（呼び出し側はキーの経路へ戻さない）。
	 * `annotations` は質問文ごとの preview（選んだ選択肢のもの）とメモ（notes）。
	 */
	answerQuestion(token: string, itemId: string, answers: Record<string, string>, annotations?: Record<string, IParadisClaudeModQuestionAnnotation>): boolean {
		const item = this.pending.get(itemId);
		if (item === undefined || item.kind !== 'question' || item.token !== token || item.outcome !== undefined) {
			return false;
		}
		this.finish(item, { state: 'answer', answers, ...(annotations !== undefined && Object.keys(annotations).length > 0 ? { annotations } : {}) });
		return true;
	}

	/** 「質問に答えずに話す」を mod へ渡す（全問を取り下げる）。もう待っていなければ false。 */
	clarifyQuestion(token: string, itemId: string, clarify: ParadisClaudeModQuestionClarify): boolean {
		const item = this.pending.get(itemId);
		if (item === undefined || item.kind !== 'question' || item.token !== token || item.outcome !== undefined) {
			return false;
		}
		this.finish(item, clarify.kind === 'response' ? { state: 'clarify', response: clarify.response } : { state: 'clarify', deny: clarify.deny });
		return true;
	}

	/**
	 * 承認の回答を mod へ渡す。`denyMessage` は拒否のときに Claude Code へ返す文（モデルが読む）で、受け取れる mod
	 * （{@link IParadisClaudeModPendingPermission.acceptsDenyMessage}）にだけ渡す。受け取れない mod には false を返す
	 * （黙って固定の文で拒否させない）。もう待っていなければ false。
	 */
	answerPermission(token: string, itemId: string, decision: 'allow' | 'deny', always: boolean, denyMessage?: string): boolean {
		const item = this.pending.get(itemId);
		if (item === undefined || item.kind !== 'permission' || item.token !== token || item.outcome !== undefined
			|| (denyMessage !== undefined && (decision !== 'deny' || item.permission?.acceptsDenyMessage !== true))) {
			return false;
		}
		this.finish(item, {
			state: 'answer', decision,
			...(always && decision === 'allow' && item.permission?.hasSuggestions === true ? { always: true } : {}),
			...(denyMessage !== undefined ? { message: denyMessage } : {}),
		});
		return true;
	}

	/**
	 * 待機中の会話へ発言を送る（mod の `$.prompt.submit`）。
	 * - `accepted`: mod が送ったと答えた、または送った発言が mod の会話の行に現れた
	 * - `unavailable`: mod へ渡せなかった（渡していないので、呼び出し側はキーの経路で送ってよい）
	 * - `refused`: mod が送れなかったと答えた。キーでは送り直さない（mod が断った文をキーで打つと、断った理由ごと無視することになる）
	 * - `stale`: mod の会話が切り替わっていた（`/clear` 等）。キーでは送り直さない
	 * - `panel-open`: 承認・質問以外の画面（`/config` など）が PC でキーを持っている。キーで打つと、その画面に文字と Enter が入る
	 * - `busy`: mod が別の発言を送っている最中で断った（1 通目の行方が分かってからキーで送ってよい）
	 * - `unconfirmed`: 渡したが、ack も会話の行も来なかった。呼び出し側が transcript で確かめる
	 */
	async submitPrompt(token: string, sessionId: string, promptText: string, onLateFailure?: () => void): Promise<ParadisClaudeModSubmitResult> {
		const state = this.sessions.get(this.sessionKey(token, sessionId));
		const waiter = state !== undefined ? await this.takeCommandWaiter(state) : undefined;
		if (state === undefined || waiter === undefined) {
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
		waiter([{ id: commandId, kind: 'submit', text: promptText }]);
		switch (await outcome) {
			case 'received': {
				// mod が受け取り、これから送る。最後の ack で送れなかったと分かったら知らせる（キーでは送り直さない）
				const finalTimer = setTimeout(() => state.acks.delete(commandId), SUBMIT_FINAL_ACK_MS);
				state.acks.set(commandId, final => {
					clearTimeout(finalTimer);
					state.acks.delete(commandId);
					if (final !== 'ok' && final !== 'received') {
						// 送れなかった。この発言のターンは始まらない
						// 送れなかった。この発言のターンは始まらないので、ポーリングの言う busy に戻す
						this.releaseHeldBusy(state);
						state.busy = state.pollBusy;
						onLateFailure?.();
					}
				});
				state.busy = true;
				state.heldBusy = true;
				state.heldBusyUntil = this.now() + HELD_BUSY_BEFORE_TURN_MS;
				return 'accepted';
			}
			case 'ok':
				state.busy = true;
				// 最初の ack が送れた（received を経ていない）。保持はしない（ターンの始まり・終わりは mod の知らせで分かる）
				return 'accepted';
			case 'refused': return 'refused';
			case 'busy': return 'busy';
			case 'stale': return 'stale';
			case 'panel-open': return 'panel-open';
			case 'undelivered': return 'unavailable';
			default: return 'unconfirmed';
		}
	}

	/**
	 * 承認・質問以外の画面（`/config`・`/rewind`・`/model` の一覧など）が、この会話の PC の画面でキーを持っているか。mod が
	 * 空の文を入力欄へ足してみて（`$.prompt.fill`）、`refusal: 'dialog'` で断られたら開いている（下書きは変わらない。
	 * Claude Code 2.1.289 で実測）。mod が答えられない（古い・来ない）ときは undefined。
	 */
	async isDialogOpen(token: string, sessionId: string): Promise<boolean | undefined> {
		const state = this.sessions.get(this.sessionKey(token, sessionId));
		if (state === undefined || !state.features.has('prompt.dialog')) {
			return undefined;
		}
		const waiter = await this.takeCommandWaiter(state);
		if (waiter === undefined) {
			return undefined;
		}
		const commandId = randomUUID();
		const answer = new Promise<boolean | undefined>(resolve => {
			const settle = (outcome: SubmitOutcome | undefined, _message?: string, payload?: Record<string, unknown>) => {
				clearTimeout(timer);
				state.acks.delete(commandId);
				resolve(outcome === 'ok' && typeof payload?.dialog === 'boolean' ? payload.dialog : undefined);
			};
			const timer = setTimeout(() => settle(undefined), DIALOG_ACK_MS);
			state.acks.set(commandId, settle);
		});
		waiter([{ id: commandId, kind: 'dialogCheck' }]);
		return answer;
	}

	/** この会話の mod がその機能を持っているか（1.2.0 より前の mod は何も持たない）。 */
	supports(token: string, sessionId: string | undefined, feature: ParadisClaudeModFeature): boolean {
		const state = sessionId !== undefined ? this.sessions.get(this.sessionKey(token, sessionId)) : undefined;
		return state !== undefined && state.features.has(feature) && this.isAlive(token, sessionId);
	}

	/**
	 * いま使えるスラッシュコマンド（mod の `$.command.list()`。Claude Code の候補と同じ順の、mod が送ってきたままの配列）。
	 * mod へ渡せない・答えが来ない・断られたときは undefined（呼び出し側はファイルから組み立てる）。
	 */
	async listCommands(token: string, sessionId: string): Promise<readonly unknown[] | undefined> {
		const state = this.sessions.get(this.sessionKey(token, sessionId));
		if (state === undefined || !state.features.has('commands.list')) {
			return undefined;
		}
		const waiter = await this.takeCommandWaiter(state);
		if (waiter === undefined) {
			return undefined;
		}
		const commandId = randomUUID();
		const commands = new Promise<readonly unknown[] | undefined>(resolve => {
			const settle = (outcome: SubmitOutcome | undefined, _message?: string, payload?: Record<string, unknown>) => {
				clearTimeout(timer);
				state.acks.delete(commandId);
				resolve(outcome === 'ok' && Array.isArray(payload?.commands) ? payload.commands : undefined);
			};
			const timer = setTimeout(() => settle(undefined), LIST_ACK_MS);
			state.acks.set(commandId, settle);
		});
		waiter([{ id: commandId, kind: 'commandList' }]);
		return commands;
	}

	/**
	 * 待機中の会話でスラッシュコマンドを実行する（mod の `$.command.run`。`$.prompt.submit` は `/` で始まる文を断る）。
	 * 名前の無いコマンドは Claude Code が断り、その理由を返す。画面を開くコマンドは閉じるまで終わらないので、mod は
	 * 少し待って「受け取った」を先に返す（`running: true`）。その後に失敗と分かったら `onLateFailure` を呼び、終わりの ack が
	 * 届いたら（画面が閉じた・コマンドが終わった）成否に関わらず `onFinished` を呼ぶ。
	 */
	async runCommand(token: string, sessionId: string, command: string, args: string, onLateFailure?: (message: string | undefined) => void, onFinished?: () => void): Promise<ParadisClaudeModRunCommandResult> {
		const state = this.sessions.get(this.sessionKey(token, sessionId));
		if (state === undefined || !state.features.has('command.run')) {
			return { outcome: 'unavailable' };
		}
		const waiter = await this.takeCommandWaiter(state);
		if (waiter === undefined) {
			return { outcome: 'unavailable' };
		}
		const commandId = randomUUID();
		const outcome = new Promise<{ readonly outcome: SubmitOutcome; readonly message?: string } | undefined>(resolve => {
			const settle = (value: SubmitOutcome | undefined, message?: string) => {
				clearTimeout(timer);
				state.acks.delete(commandId);
				resolve(value !== undefined ? { outcome: value, ...(message !== undefined ? { message } : {}) } : undefined);
			};
			const timer = setTimeout(() => settle(undefined), SUBMIT_ACK_MS);
			state.acks.set(commandId, settle);
		});
		waiter([{ id: commandId, kind: 'commandRun', command, args }]);
		const result = await outcome;
		switch (result?.outcome) {
			case 'received': {
				// 画面を開くコマンド・時間のかかるコマンドで、まだ終わっていない。終わりの ack で失敗と分かったら知らせる
				// （キーでは送り直さない）。画面が開いているかは時間では決めず、{@link isDialogOpen} で mod に聞く
				const finalTimer = setTimeout(() => state.acks.delete(commandId), SUBMIT_FINAL_ACK_MS);
				state.acks.set(commandId, (final, message) => {
					clearTimeout(finalTimer);
					state.acks.delete(commandId);
					if (final !== 'ok' && final !== 'received') {
						onLateFailure?.(message);
					}
					// 開いた画面が閉じた（または長いコマンドが終わった）
					onFinished?.();
				});
				return { outcome: 'accepted', running: true };
			}
			case 'ok': return { outcome: 'accepted' };
			case 'refused': return { outcome: 'refused', ...(result.message !== undefined ? { message: result.message } : {}) };
			case 'busy': return { outcome: 'busy' };
			case 'stale': return { outcome: 'stale' };
			case 'panel-open': return { outcome: 'panel-open' };
			case 'undelivered': return { outcome: 'unavailable' };
			default: return { outcome: 'unconfirmed' };
		}
	}

	/** コマンドの長いポーリングを取る。張り直しの合間かもしれないので少しだけ待つ。来なければ undefined。 */
	private async takeCommandWaiter(state: ISessionState): Promise<((commands: readonly Record<string, unknown>[]) => void) | undefined> {
		if (state.commandWaiter === undefined) {
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
				return undefined;
			}
		}
		const waiter = state.commandWaiter;
		state.commandWaiter = undefined;
		return waiter;
	}

	/**
	 * バックグラウンドのタスク（シェル）を mod の `$.tool.call({ tool: 'TaskStop', task_id })` で止める。
	 * 許可のダイアログは出ず、transcript にも何も残らないので、止まったかは mod の ack だけで知る。
	 */
	async stopTask(token: string, sessionId: string, taskId: string): Promise<ParadisClaudeModStopResult> {
		const state = this.sessions.get(this.sessionKey(token, sessionId));
		const waiter = state !== undefined ? await this.takeCommandWaiter(state) : undefined;
		if (state === undefined || waiter === undefined) {
			return { outcome: 'unavailable' };
		}
		const commandId = randomUUID();
		const outcome = new Promise<{ readonly outcome: SubmitOutcome; readonly message?: string } | undefined>(resolve => {
			const settle = (value: SubmitOutcome | undefined, message?: string) => {
				clearTimeout(timer);
				state.acks.delete(commandId);
				resolve(value !== undefined ? { outcome: value, ...(message !== undefined ? { message } : {}) } : undefined);
			};
			const timer = setTimeout(() => settle(undefined), SUBMIT_ACK_MS);
			state.acks.set(commandId, settle);
		});
		waiter([{ id: commandId, kind: 'taskStop', taskId }]);
		const result = await outcome;
		switch (result?.outcome) {
			case 'ok': return { outcome: 'stopped', ...(result.message !== undefined ? { message: result.message } : {}) };
			case 'refused':
			case 'stale':
			case 'panel-open':
			case 'busy':
				return { outcome: 'refused', ...(result.message !== undefined ? { message: result.message } : {}) };
			case 'undelivered': return { outcome: 'unavailable' };
			default: return { outcome: 'unconfirmed' };
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
		for (const key of [...this.aliveNotified.keys()]) {
			if (key.startsWith(`${token}\0`)) {
				this.noteAlive(token, key.slice(token.length + 1));
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

/**
 * mod が別の発言の最中で断った（busy）2 通目を、1 通目の行方が分かるまで待つ。`previous` が無ければすぐ、
 * 上限（`timeoutMs`）を過ぎたら待つのをやめる（呼び出し側はその後キーで送る）。
 */
export async function paradisClaudeModWaitForPrevious(previous: Promise<unknown> | undefined, timeoutMs: number): Promise<void> {
	if (previous === undefined) {
		return;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([previous.then(() => undefined, () => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
	} finally {
		clearTimeout(timer);
	}
}
