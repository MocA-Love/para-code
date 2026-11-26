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
//
// 真の記録はボードの台帳ファイル（state.json）のまま。ここは写しを運ぶだけで、ボードの画面も道具も変えない。
// 認可は接続口の受け口（paradisTaskBoardBridgeServer.ts）が済ませている（Bearer・ボードの鍵・接続元の pid）。

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../common/paradisGuards.js';
import { IParadisHumanAskAnswerRequest, ParadisHumanAskSurface, paradisHumanAskKey } from '../../humanAsk/common/paradisHumanAsk.js';
import { TASK_BOARD_ASK_ANSWER_EVENT, TASK_BOARD_ASKS_LIMIT } from '../common/paradisTaskBoardAsks.js';
import { paradisIsTaskBoardTerminalId } from '../common/paradisTaskBoardBridge.js';

/** 台帳のうち、取り込み役が使う分（本物は ParadisHumanAskService。テストでも本物を渡す）。 */
export interface IParadisTaskBoardAskLedger {
	readonly onDidRequestAnswer: Event<IParadisHumanAskAnswerRequest>;
	sync(owner: string, values: readonly unknown[]): number;
	resolve(owner: string, key: string, resolution?: { readonly surface?: ParadisHumanAskSurface; readonly summary?: string }): boolean;
	reject(owner: string, key: string, claim: string): boolean;
	removeOwner(owner: string): boolean;
}

/** 接続口の中身（ParadisTaskBoardBridgeService）から借りるもの。 */
export interface IParadisTaskBoardAskHost {
	/** そのボードの SSE の受け手にだけ書く。受け手が 1 つも無ければ false。 */
	writeToBoard(keyHash: string, chunk: string): boolean;
	/** ボードが起動したターミナルの、ペインの鍵と窓。そのボードが触れないターミナルなら undefined。 */
	terminalPane(terminal: string, remoteBoard: boolean): { readonly paneKey?: string; readonly windowId?: number } | undefined;
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
	 * 待ちに成り代わって答えを受け取らせない）。ボードの鍵は起動ごとに変わるので、使っていたボードの接続が全部切れた後
	 * （その待ちはもう取り下げてある）なら、開き直したボードの新しい鍵に結び付け直す。
	 */
	private readonly prefixOwners = new Map<string, string>();
	/** 届けてもらっている最中の依頼（依頼の番号 → 持ち主と鍵）。 */
	private readonly claims = new Map<string, IClaim>();

	constructor(
		private readonly ledger: IParadisTaskBoardAskLedger,
		private readonly host: IParadisTaskBoardAskHost,
	) {
		super();
		this._register(ledger.onDidRequestAnswer(request => this.onAnswerRequest(request)));
	}

	/** ボードの SSE がつながった。 */
	boardConnected(keyHash: string): void {
		const board = this.boards.get(keyHash);
		if (board) {
			board.connections++;
		} else {
			this.boards.set(keyHash, { connections: 1, owner: `${OWNER_PREFIX}${++this.boardSequence}` });
		}
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
