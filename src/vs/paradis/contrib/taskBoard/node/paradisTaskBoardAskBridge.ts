/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ボードの「あなたの番」を「人が答えるもの」の台帳（humanAsk）へ載せる取り込み役（shared process）。
//
//  - `PUT /v1/asks`: ボードが今の人の出番を丸ごと知らせる。台帳の持ち主は「そのボード」（つながるたびに振る
//    `board:<連番>`。台帳は全ウィンドウへ配られるので、ボードの鍵やその hash は持ち主の名前に使わない）で、
//    出どころは必ず `board` にする（ボードにペインや Bot の待ちを名乗らせない）
//  - 台帳の側（受信箱・スマホ）で答えられたら、SSE の `ask-answer` を**そのボードにだけ**流す。答えの本文は
//    伏せ字を掛けていないので、ほかのボードへは流さない
//  - `POST /v1/asks/settle`: ボードが答えを届けた結果。届いたら回答済み、届かなければ待ちへ戻す
//  - ボードの SSE が切れたら、そのボードの待ちを取り下げる（戻ってきて知らせ直せば待ちに戻る）
//  - 逆向き: ボードの外のペインの待ち（台帳の出どころ `pane`）を、手元のボードにだけ SSE の `pane-asks` で丸ごと流す
//    （「フロー外のエージェント」の欄）。ボードが答えられるのは質問の選択肢（問い 1 つ・1 つ選ぶもの）だけで、許可には
//    答えさせない（受信箱へ回す）。`POST /v1/asks/pane-answer` から台帳の claim を通す（ペインへの
//    打鍵は台帳の持ち主が受信箱と同じ口で行う。ボードはペインにもトークンにも触れない）。SSH の窓のボードには流さない
//
// 真の記録はボードの台帳ファイル（state.json）のまま。ここは写しを運ぶだけで、ボードの画面も道具も変えない。
// 認可は接続口の受け口（paradisTaskBoardBridgeServer.ts）が済ませている（Bearer・ボードの鍵・接続元の pid）。

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../common/paradisGuards.js';
import { IParadisHumanAskAnswerRequest, IParadisHumanAskEntry, IParadisHumanAskSnapshot, ParadisHumanAskAnswerResult, ParadisHumanAskSurface, paradisHumanAskCounted, paradisHumanAskKey } from '../../humanAsk/common/paradisHumanAsk.js';
import { paradisInboxAskLayout } from '../../notificationInbox/common/paradisNotificationInboxAsk.js';
import { ITaskBoardPaneAsk } from '../common/paradisTaskBoard.js';
import { TASK_BOARD_ASK_ANSWER_EVENT, TASK_BOARD_ASKS_LIMIT, TASK_BOARD_PANE_ASKS_EVENT } from '../common/paradisTaskBoardAsks.js';
import { paradisIsTaskBoardTerminalId } from '../common/paradisTaskBoardBridge.js';

/** 台帳のうち、取り込み役が使う分（本物は ParadisHumanAskService。テストでも本物を渡す）。 */
export interface IParadisTaskBoardAskLedger {
	readonly onDidRequestAnswer: Event<IParadisHumanAskAnswerRequest>;
	sync(owner: string, values: readonly unknown[]): number;
	resolve(owner: string, key: string, resolution?: { readonly surface?: ParadisHumanAskSurface; readonly summary?: string }): boolean;
	reject(owner: string, key: string, claim: string): boolean;
	removeOwner(owner: string): boolean;
	/** 台帳が変わった（ボードの外のペインの待ちを流し直す）。 */
	readonly onDidChange: Event<unknown>;
	getSnapshot(): IParadisHumanAskSnapshot;
	answer(key: unknown, answer: unknown, surface: unknown): ParadisHumanAskAnswerResult;
}

/** 接続口の中身（ParadisTaskBoardBridgeService）から借りるもの。 */
export interface IParadisTaskBoardAskHost {
	/** そのボードの SSE の受け手にだけ書く。受け手が 1 つも無ければ false。 */
	writeToBoard(keyHash: string, chunk: string): boolean;
	/** ボードが起動したターミナルの、ペインの鍵と窓。そのボードが触れないターミナルなら undefined。 */
	terminalPane(terminal: string, remoteBoard: boolean): { readonly paneKey?: string; readonly windowId?: number } | undefined;
	/** 手元のボード（SSH の窓のボードを除く）の SSE の受け手の全部に書く。 */
	writeToLocalBoards(chunk: string): void;
	/** ボードが起動したターミナルのペインの鍵（その待ちはボードのタスクの側に出るので、フロー外の欄に出さない）。 */
	boardPaneKeys(): ReadonlySet<string>;
}

/** ボードの画面で押してよいものだけを残した、ボードの外のペインの 1 件。 */
function paneAskOf(entry: IParadisHumanAskEntry): ITaskBoardPaneAsk | undefined {
	if (entry.kind !== 'question' && entry.kind !== 'permission') {
		return undefined;
	}
	const layout = paradisInboxAskLayout(entry);
	const question = entry.questions[0];
	const text = entry.kind === 'permission' ? (entry.preface ?? entry.from.title) : (question?.text ?? entry.preface ?? '');
	return {
		key: entry.key,
		kind: entry.kind,
		from: entry.from,
		text: text.length > 400 ? `${text.slice(0, 399)}\u2026` : text,
		askedAt: entry.askedAt,
		busy: entry.pending !== undefined,
		failed: entry.failedAt !== undefined,
		...(layout === 'inline-options' && question !== undefined ? { questionId: question.id, options: question.options.map(option => ({ id: option.id, label: option.label, ...(option.recommended ? { recommended: true } : {}) })) } : {}),
	};
}

export type ParadisTaskBoardAskResponse =
	| { readonly ok: true; readonly body: object }
	| { readonly ok: false; readonly code: 'invalid' | 'not-found' | 'unavailable'; readonly message: string };

/** 覚えておく依頼の数（ボードが結果を返さないまま溜まらないように）。 */
const MAX_CLAIMS = 500;

const OWNER_PREFIX = 'board:';

interface IClaim {
	readonly owner: string;
	readonly key: string;
}

export class ParadisTaskBoardAskBridge extends Disposable {

	/** ボード（鍵の hash）ごとの、つながっている SSE の数と、台帳での持ち主の名前。 */
	private readonly boards = new Map<string, { connections: number; readonly owner: string }>();
	private boardSequence = 0;
	/**
	 * id の頭（ボードの台帳の名前。リポジトリごとに違う）と、それを使っているボードの鍵（の hash）。頭はボードが自分で
	 * 名乗るので、その頭を使っているボードがつながっている間は、別の鍵のボードが同じ頭を名乗っても断る（別のリポジトリの
	 * 待ちに成り代わって答えを受け取らせない）。ボードの鍵は起動ごとに変わるので、使っていたボードの接続が全部切れたら
	 * （その待ちは取り下げる）その頭を表から外し、開き直したボードの新しい鍵が名乗れるようにする。
	 */
	private readonly prefixOwners = new Map<string, string>();
	/** 届けてもらっている最中の依頼（依頼の番号 → 持ち主と鍵）。 */
	private readonly claims = new Map<string, IClaim>();

	/** 最後に流したボードの外のペインの待ち（同じ中身を台帳の変化のたびに流さない）。 */
	private sentPaneAsks: string | undefined;

	constructor(
		private readonly ledger: IParadisTaskBoardAskLedger,
		private readonly host: IParadisTaskBoardAskHost,
	) {
		super();
		this._register(ledger.onDidRequestAnswer(request => this.onAnswerRequest(request)));
		this._register(ledger.onDidChange(() => this.publishPaneAsks(false)));
	}

	/** ボードの外のペインの今の待ち（数えるもの、つまり待ちで、ボード・Bot の 1 件に寄せていないもの）。 */
	paneAsks(): ITaskBoardPaneAsk[] {
		const boardPanes = this.host.boardPaneKeys();
		const asks: ITaskBoardPaneAsk[] = [];
		for (const entry of this.ledger.getSnapshot().entries) {
			if (entry.source !== 'pane' || !paradisHumanAskCounted(entry) || (entry.paneKey !== undefined && boardPanes.has(entry.paneKey))) {
				continue;
			}
			const ask = paneAskOf(entry);
			if (ask !== undefined && asks.length < TASK_BOARD_ASKS_LIMIT) {
				asks.push(ask);
			}
		}
		return asks;
	}

	/** 手元のボードへ、ボードの外のペインの待ちを丸ごと流す。`force` はつないだ直後（同じ中身でも流す）。 */
	private publishPaneAsks(force: boolean): void {
		if (this.boards.size === 0) {
			this.sentPaneAsks = undefined;
			return;
		}
		const chunk = `data: ${JSON.stringify({ type: TASK_BOARD_PANE_ASKS_EVENT, asks: this.paneAsks() })}\n\n`;
		if (!force && chunk === this.sentPaneAsks) {
			return;
		}
		this.sentPaneAsks = chunk;
		this.host.writeToLocalBoards(chunk);
	}

	/**
	 * `POST /v1/asks/pane-answer`（手元のボードだけ）。今流している 1 件で、ボードの画面に出したボタンと同じ答えだけを、
	 * 台帳の claim に通す（台帳が問い・選択肢・ボタンと突き合わせて検め直す）。
	 */
	answerPane(body: unknown, keyHash: string | undefined, remoteBoard: boolean): ParadisTaskBoardAskResponse {
		if (remoteBoard || keyHash === undefined || !this.boards.has(keyHash)) {
			return { ok: false, code: 'unavailable', message: 'Only a task board on this computer that is connected to /v1/events can answer.' };
		}
		if (!isRecord(body) || typeof body.key !== 'string' || !isRecord(body.answer)) {
			return { ok: false, code: 'invalid', message: 'key must be a string and answer an object.' };
		}
		const ask = this.paneAsks().find(candidate => candidate.key === body.key);
		if (ask === undefined) {
			return { ok: false, code: 'not-found', message: 'That question is no longer waiting.' };
		}
		const answer = body.answer;
		// 選んだ選択肢 1 つだけ（ボードの画面に文を書く欄は無い。文の付いた答えは受けない）
		const first = answer.type === 'answers' && Array.isArray(answer.answers) && answer.answers.length === 1 && isRecord(answer.answers[0]) ? answer.answers[0] : undefined;
		const optionIds = first !== undefined && first.questionId === ask.questionId && first.text === undefined ? first.optionIds : undefined;
		if (!Array.isArray(optionIds) || optionIds.length !== 1 || !ask.options?.some(option => option.id === optionIds[0])) {
			return { ok: false, code: 'invalid', message: 'Answer with one of the options the board shows; answer permissions and other questions in the Para Code inbox.' };
		}
		const result = this.ledger.answer(ask.key, { type: 'answers', answers: [{ questionId: ask.questionId, optionIds }] }, 'board');
		return { ok: true, body: result.ok ? { ok: true } : { ok: false, reason: result.reason } };
	}

	/** ボードの SSE がつながった。 */
	boardConnected(keyHash: string): void {
		const board = this.boards.get(keyHash);
		if (board) {
			board.connections++;
		} else {
			this.boards.set(keyHash, { connections: 1, owner: `${OWNER_PREFIX}${++this.boardSequence}` });
		}
		this.publishPaneAsks(true);
	}

	/** ボードの SSE が切れた。最後の 1 本なら、そのボードの待ちを取り下げる（止まったボードの問いを残さない）。 */
	boardDisconnected(keyHash: string): void {
		if (this._store.isDisposed) {
			return;
		}
		const board = this.boards.get(keyHash);
		if (!board || --board.connections > 0) {
			return;
		}
		this.boards.delete(keyHash);
		// このボードが名乗っていた頭を表から外す（待ちはこの後すべて取り下げる。残すと頭の上限が埋まったまま減らない）
		for (const [prefix, holder] of [...this.prefixOwners]) {
			if (holder === keyHash) {
				this.prefixOwners.delete(prefix);
			}
		}
		const owner = board.owner;
		for (const [claim, entry] of [...this.claims]) {
			if (entry.owner === owner) {
				this.claims.delete(claim);
			}
		}
		this.ledger.removeOwner(owner);
	}

	/**
	 * `PUT /v1/asks`。`asks` は今の人の出番の丸ごとの一覧、`answered` はボードの画面で答えて一覧から外れた id
	 * （回答済みにする。書かずに外れたものは取り下げになる）。
	 */
	put(body: unknown, keyHash: string | undefined, remoteBoard: boolean): ParadisTaskBoardAskResponse {
		if (!isRecord(body) || !Array.isArray(body.asks) || body.asks.length > TASK_BOARD_ASKS_LIMIT || (body.answered !== undefined && (!Array.isArray(body.answered) || body.answered.length > TASK_BOARD_ASKS_LIMIT))) {
			return { ok: false, code: 'invalid', message: `asks must be an array of up to ${TASK_BOARD_ASKS_LIMIT} entries.` };
		}
		// SSE がつながっていないボードの待ちは受けない: 答えを届ける先が無く、止まったときに取り下げる契機も無い
		const owner = keyHash !== undefined ? this.boards.get(keyHash)?.owner : undefined;
		if (owner === undefined) {
			return { ok: false, code: 'unavailable', message: 'Connect to /v1/events before reporting asks.' };
		}
		for (const id of Array.isArray(body.answered) ? body.answered : []) {
			if (typeof id === 'string') {
				this.ledger.resolve(owner, paradisHumanAskKey('board', id), { surface: 'board' });
			}
		}
		const mine = body.asks.filter(ask => this.ownsPrefix(ask, keyHash!));
		const refused = this.ledger.sync(owner, mine.map(ask => this.toInput(ask, remoteBoard))) + (body.asks.length - mine.length);
		return { ok: true, body: { ok: true, refused } };
	}

	/** id の頭がこのボードのものか。まだ誰も使っていない頭なら、このボードの頭として覚える。 */
	private ownsPrefix(ask: unknown, keyHash: string): boolean {
		const id = isRecord(ask) && typeof ask.id === 'string' ? ask.id : undefined;
		const separator = id?.indexOf(':') ?? -1;
		if (id === undefined || separator <= 0) {
			return false;
		}
		const prefix = id.slice(0, separator);
		const holder = this.prefixOwners.get(prefix);
		if (holder === keyHash) {
			return true;
		}
		if (holder !== undefined && this.boards.has(holder)) {
			return false;
		}
		if (holder === undefined && this.prefixOwners.size >= TASK_BOARD_ASKS_LIMIT) {
			return false;
		}
		this.prefixOwners.set(prefix, keyHash);
		return true;
	}

	/** ボードの 1 件を台帳の入力にする。出どころは `board` に固定し、ターミナルの id をペインの鍵と窓に引き直す。 */
	private toInput(ask: unknown, remoteBoard: boolean): unknown {
		if (!isRecord(ask)) {
			return undefined;
		}
		const { terminal, paneKey: _paneKey, windowId: _windowId, stateKey: _stateKey, ...rest } = ask;
		const pane = paradisIsTaskBoardTerminalId(terminal) ? this.host.terminalPane(terminal, remoteBoard) : undefined;
		return {
			...rest,
			source: 'board',
			canSkip: false,
			...(pane?.paneKey !== undefined ? { paneKey: pane.paneKey } : {}),
			...(pane?.windowId !== undefined ? { windowId: pane.windowId } : {}),
		};
	}

	/** `POST /v1/asks/settle`。依頼の番号は、そのボードへ出したものだけ受ける。 */
	settle(body: unknown, keyHash: string | undefined): ParadisTaskBoardAskResponse {
		if (!isRecord(body) || typeof body.claim !== 'string' || typeof body.ok !== 'boolean') {
			return { ok: false, code: 'invalid', message: 'claim must be a string and ok must be a boolean.' };
		}
		const entry = this.claims.get(body.claim);
		if (entry === undefined || keyHash === undefined || entry.owner !== this.boards.get(keyHash)?.owner) {
			return { ok: false, code: 'not-found', message: 'No answer is waiting for that claim.' };
		}
		this.claims.delete(body.claim);
		if (body.ok) {
			this.ledger.resolve(entry.owner, entry.key);
		} else {
			this.ledger.reject(entry.owner, entry.key, body.claim);
		}
		return { ok: true, body: { ok: true } };
	}

	/** 台帳の側で答えられた。持ち主のボードへ流し、流せなければその場で待ちへ戻す。 */
	private onAnswerRequest(request: IParadisHumanAskAnswerRequest): void {
		let keyHash: string | undefined;
		for (const [candidate, board] of this.boards) {
			if (board.owner === request.owner) {
				keyHash = candidate;
			}
		}
		if (request.source !== 'board' || keyHash === undefined) {
			return;
		}
		if (this.claims.size >= MAX_CLAIMS) {
			const oldest = this.claims.keys().next();
			if (!oldest.done) {
				this.claims.delete(oldest.value);
			}
		}
		this.claims.set(request.claim, { owner: request.owner, key: request.key });
		const delivered = this.host.writeToBoard(keyHash, `data: ${JSON.stringify({ type: TASK_BOARD_ASK_ANSWER_EVENT, claim: request.claim, id: request.id, answer: request.answer })}\n\n`);
		if (!delivered) {
			this.claims.delete(request.claim);
			this.ledger.reject(request.owner, request.key, request.claim);
		}
	}
}
