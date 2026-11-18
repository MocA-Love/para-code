/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料のコメントを持ち主のペインへ届ける係（shared process）。決めるのはここで、貼るのはペインを持つウィンドウ
// （paradisDocCommentDelivery.contribution.ts）。流れ:
//  1. コメントの保存・hook・台帳の変化で、届け待ちを見直す（evaluate）。待つ理由はスレッドの delivery.blockedBy に書く
//  2. 届けてよいペインがあれば、ウィンドウへ「届けたいペインがある」を知らせる（onDidWant）
//  3. ウィンドウが claim で 1 回分（資料 1 つ）を取り、貼る。Enter の直前に confirmEnter で確かめ直し、finish で結果を返す
//  4. そのペインの UserPromptSubmit（prompt に ID があるもの）で「届いた」にする。届くまでは同じペインへ次を貼らない
// 決まりそのものは純関数（common/paradisDocCommentDelivery.ts）。生きているセッションに claude --resume は使わない
// （終わった持ち主を起こすのは段 3 で、ユーザーがボタンを押したときだけ）。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { IParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { IParadisPaneAgentStatusSource } from '../../agentBrowser/node/paradisPaneAgentStatusSource.js';
import { paradisDocFileName } from '../common/paradisAgentDocsView.js';
import {
	IParadisDocDeliveryClaim,
	ParadisDocDeliveryDecision,
	ParadisDocDeliveryOutcome,
	ParadisDocDeliveryOwner,
	ParadisDocDraftState,
	paradisDecideDocDelivery,
	paradisDocDeliveryMayEnter,
	paradisDocDeliveryPromptMatches,
	paradisDocDeliveryText,
} from '../common/paradisDocCommentDelivery.js';
import {
	IParadisDocCommentThread,
	ParadisDocDeliveryBlock,
	paradisDocCommentAwaitsDelivery,
	paradisDocCommentLastUserText,
	paradisWithDocCommentBlocked,
	paradisWithDocCommentDelivered,
	paradisWithDocCommentTyped,
} from '../common/paradisDocComments.js';
import { ParadisAgentDocsService } from './paradisAgentDocsService.js';
import { ParadisDocCommentsStore } from './paradisDocCommentsStore.js';

/** 入力欄の中身を読む口（Claude Code の入力欄の mod）。読めなければ undefined。 */
export type ParadisDocDraftReader = (token: string, session: string) => string | undefined;

/** 見直しをまとめる時間（hook が続けて来ても 1 回にする。hook で状態が書き換わった後に読む）。 */
const EVALUATE_DELAY_MS = 300;
/** 待っているものがある間、見直しを繰り返す間隔（許可の拒否など hook の来ない変化も拾う）。 */
const RETRY_MS = 2_000;
/** ウィンドウが取った分を返さないとき、取り直せるようになるまで。 */
const CLAIM_TIMEOUT_MS = 15_000;
/** Enter まで送った後、届いた知らせを待つ上限（過ぎたら次を貼れるようにする）。 */
const ENTERED_BUSY_MS = 60_000;
/** Enter を送らずに貼った後、ユーザーが送るのを待つ上限。 */
const TYPED_BUSY_MS = 10 * 60_000;
/** 入力欄の中身が分からないペインへ入れてよい、ターンの終わりの後の時間。 */
const TURN_END_WINDOW_MS = 10_000;
/** 1 回に届けるコメントの上限。 */
const MAX_IDS_PER_DELIVERY = 10;

interface IClaim {
	readonly token: string;
	readonly hostId: string;
	readonly path: string;
	readonly ids: readonly string[];
	readonly text: string;
	readonly at: number;
}

interface IBusy {
	readonly hostId: string;
	readonly path: string;
	readonly ids: readonly string[];
	readonly until: number;
}

export class ParadisDocCommentDelivery extends Disposable {

	private readonly _claims = new Map<string, IClaim>();
	private readonly _busy = new Map<string, IBusy>();
	private readonly _lastTurnEnd = new Map<string, number>();
	private readonly _lastSubmit = new Map<string, number>();
	/** ユーザーが「今すぐ届ける」を押したスレッド。 */
	private readonly _forced = new Set<string>();
	/** CLI が終わったのを見たペイン（次の hook で外す）。 */
	private readonly _exited = new Set<string>();
	private readonly _scheduler: RunOnceScheduler;
	private readonly _retry: RunOnceScheduler;

	private readonly _onDidWant = this._register(new Emitter<readonly string[]>());
	/** 届けたいペインがある（トークンの配列）。 */
	readonly onDidWant: Event<readonly string[]> = this._onDidWant.event;

	constructor(
		private readonly _docs: ParadisAgentDocsService,
		private readonly _comments: ParadisDocCommentsStore,
		private readonly _status: () => IParadisPaneAgentStatusSource | undefined,
		private readonly _draftOf: ParadisDocDraftReader,
		hookEvents: Event<IParadisAgentHookEvent>,
		turnEnded: Event<{ readonly token: string; readonly at: number; readonly cause?: 'turn' | 'cli-exit' }>,
		private readonly _now: () => number = Date.now,
	) {
		super();
		this._scheduler = this._register(new RunOnceScheduler(() => void this.evaluate(), EVALUATE_DELAY_MS));
		this._retry = this._register(new RunOnceScheduler(() => void this.evaluate(), RETRY_MS));
		this._register(hookEvents(event => this._onHook(event)));
		this._register(turnEnded(({ token, at, cause }) => {
			if (cause === 'cli-exit') {
				// CLI が終わった。前面はシェルに戻るので、次の hook が来るまでそのペインへは届けない
				this._exited.add(token);
				this._lastTurnEnd.delete(token);
			} else {
				this._lastTurnEnd.set(token, at);
			}
			this._scheduler.schedule();
		}));
		this._register(_docs.ledger.onDidChange(() => this._scheduler.schedule()));
		this._register(_docs.onDidChangeSessions(() => this._scheduler.schedule()));
		this._register(_comments.onDidChange(() => this._scheduler.schedule()));
		void Promise.all([_docs.ledger.ready, _comments.ready]).then(() => this._scheduler.schedule());
	}

	/** ユーザーが「今すぐ届ける」を押した（入力欄の中身が分からないペインでも、ターンの終わりを待たずに入れる）。 */
	deliverNow(id: string): void {
		this._forced.add(id);
		this._scheduler.schedule();
	}

	/** 届け待ちを見直し、待つ理由を書き、届けてよいペインをウィンドウへ知らせる。 */
	async evaluate(): Promise<void> {
		await Promise.all([this._docs.ledger.ready, this._comments.ready]);
		const wanted = new Set<string>();
		let waiting = false;
		for (const sidecar of this._comments.all()) {
			const pending = sidecar.threads.filter(paradisDocCommentAwaitsDelivery);
			if (pending.length === 0) {
				continue;
			}
			const target = this._targetOf(sidecar.hostId, sidecar.path);
			const decision = this._decide(target, pending.some(thread => this._forced.has(thread.id)));
			if (decision.kind === 'deliver') {
				if (target.token !== undefined && !this._claimedNow(target.token)) {
					wanted.add(target.token);
				}
				waiting = true;
				// ウィンドウが貼れなかった理由（画面の確認・前面にエージェントがいない）は、貼れるまで残す（2 秒ごとに消して書き直さない）
				await this._setBlocked(sidecar.hostId, sidecar.path, pending.filter(thread => thread.delivery?.blockedBy !== 'screen' && thread.delivery?.blockedBy !== 'notRunning'), undefined);
				continue;
			}
			if (decision.kind === 'wait' || target.owner === 'live') {
				waiting = true;
			}
			await this._setBlocked(sidecar.hostId, sidecar.path, pending, decision.block);
		}
		if (wanted.size > 0) {
			this._onDidWant.fire([...wanted]);
		}
		if (waiting) {
			this._retry.schedule();
		}
	}

	/** ウィンドウが 1 回分を取る。今は届けないなら undefined。 */
	async claim(token: string): Promise<IParadisDocDeliveryClaim | undefined> {
		await Promise.all([this._docs.ledger.ready, this._comments.ready]);
		if (this._claimedNow(token)) {
			return undefined;
		}
		const pane = this._docs.sessionOf(token);
		if (pane === undefined) {
			return undefined;
		}
		// このペインの会話が持ち主の資料のうち、いちばん古い届け待ちのあるもの
		let best: { hostId: string; path: string; threads: IParadisDocCommentThread[] } | undefined;
		for (const sidecar of this._comments.all()) {
			if (this._docs.ledger.get(sidecar.hostId, sidecar.path)?.owner?.session !== pane.session) {
				continue;
			}
			const threads = sidecar.threads.filter(paradisDocCommentAwaitsDelivery);
			if (threads.length > 0 && (best === undefined || threads[0].createdAt < best.threads[0].createdAt)) {
				best = { hostId: sidecar.hostId, path: sidecar.path, threads };
			}
		}
		if (best === undefined) {
			return undefined;
		}
		const target = this._targetOf(best.hostId, best.path);
		const decision = this._decide(target, best.threads.some(thread => this._forced.has(thread.id)));
		if (decision.kind !== 'deliver' || target.token !== token) {
			if (decision.kind !== 'deliver') {
				await this._setBlocked(best.hostId, best.path, best.threads, decision.block);
			}
			return undefined;
		}
		const threads = best.threads.slice(0, MAX_IDS_PER_DELIVERY);
		const text = paradisDocDeliveryText(paradisDocFileName(best.path), threads.map(thread => ({ id: thread.id, text: paradisDocCommentLastUserText(thread) })));
		const attempt = generateUuid();
		this._claims.set(attempt, { token, hostId: best.hostId, path: best.path, ids: threads.map(thread => thread.id), text, at: this._now() });
		threads.forEach(thread => this._forced.delete(thread.id));
		return { attempt, text, enter: decision.enter };
	}

	/** 貼った後、Enter を送ってよいか確かめ直す。 */
	confirmEnter(attempt: string): boolean {
		const claim = this._claims.get(attempt);
		const pane = claim !== undefined ? this._docs.sessionOf(claim.token) : undefined;
		const source = this._status();
		if (claim === undefined || pane === undefined || source === undefined || pane.hostId !== '') {
			return false;
		}
		const status = source.getPaneAgentStatus(claim.token);
		return paradisDocDeliveryMayEnter(status?.status, source.getUnconfirmedRelease(claim.token), this._draftOf(claim.token, pane.session), claim.text);
	}

	/** ウィンドウからの結果。 */
	async finish(attempt: string, outcome: ParadisDocDeliveryOutcome): Promise<void> {
		const claim = this._claims.get(attempt);
		if (claim === undefined) {
			return;
		}
		this._claims.delete(attempt);
		const ids = new Set(claim.ids);
		const now = this._now();
		switch (outcome) {
			case 'entered':
			case 'typed': {
				const entered = outcome === 'entered';
				this._busy.set(claim.token, { hostId: claim.hostId, path: claim.path, ids: claim.ids, until: now + (entered ? ENTERED_BUSY_MS : TYPED_BUSY_MS) });
				await this._comments.update(claim.hostId, claim.path, thread => ids.has(thread.id) ? paradisWithDocCommentTyped(thread, now, entered) : thread);
				break;
			}
			case 'screen':
			case 'notRunning':
				await this._comments.update(claim.hostId, claim.path, thread => ids.has(thread.id) ? paradisWithDocCommentBlocked(thread, outcome) : thread);
				break;
		}
		this._scheduler.schedule();
	}

	private _onHook(event: IParadisAgentHookEvent): void {
		if (event.ownerUnverified) {
			return;
		}
		this._exited.delete(event.token);
		if (event.event === 'UserPromptSubmit') {
			this._lastSubmit.set(event.token, event.at);
			void this._onPromptSubmitted(event.token, event.payload?.prompt, event.at);
		} else if (event.event === 'Stop') {
			this._lastTurnEnd.set(event.token, event.at);
		} else if (event.event === 'TerminalExit') {
			this._busy.delete(event.token);
			this._lastTurnEnd.delete(event.token);
			this._lastSubmit.delete(event.token);
		}
		this._scheduler.schedule();
	}

	/** 貼った文が送られた。prompt に ID があれば、その分を「届いた」にする。 */
	private async _onPromptSubmitted(token: string, prompt: unknown, at: number): Promise<void> {
		const busy = this._busy.get(token);
		if (busy !== undefined && paradisDocDeliveryPromptMatches(prompt, busy.ids)) {
			this._busy.delete(token);
			const ids = new Set(busy.ids);
			// 貼った後に追記された（貼り直しを待っている）スレッドは、まだ届いていない
			await this._comments.update(busy.hostId, busy.path, thread => ids.has(thread.id) && thread.delivery?.typedAt !== undefined ? paradisWithDocCommentDelivered(thread, at) : thread);
			return;
		}
		// 待ちの上限を過ぎた後でユーザーが送った分も、ID が入っていれば届いたことにする
		if (typeof prompt !== 'string') {
			return;
		}
		for (const sidecar of this._comments.all()) {
			const ids = new Set(sidecar.threads.filter(thread => thread.state === 'queued' && thread.delivery?.typedAt !== undefined && prompt.includes(thread.id)).map(thread => thread.id));
			if (ids.size > 0) {
				await this._comments.update(sidecar.hostId, sidecar.path, thread => ids.has(thread.id) ? paradisWithDocCommentDelivered(thread, at) : thread);
			}
		}
	}

	/** 資料の持ち主と、その会話が動いているペイン。 */
	private _targetOf(hostId: string, path: string): { readonly owner: ParadisDocDeliveryOwner; readonly token?: string; readonly session?: string } {
		const owner = this._docs.ledger.get(hostId, path)?.owner;
		if (owner === undefined) {
			return { owner: 'none' };
		}
		const token = this._docs.tokensOf(owner.session)[0];
		if (token !== undefined) {
			return { owner: 'live', token, session: owner.session };
		}
		return { owner: owner.ended !== undefined ? 'ended' : 'unknown' };
	}

	private _decide(target: { readonly owner: ParadisDocDeliveryOwner; readonly token?: string; readonly session?: string }, forced: boolean): ParadisDocDeliveryDecision {
		const token = target.token;
		const source = this._status();
		if (token === undefined || target.session === undefined || source === undefined || this._exited.has(token)) {
			return paradisDecideDocDelivery({ owner: target.owner === 'live' ? 'unknown' : target.owner, hasHooks: false, status: undefined, unconfirmedRelease: undefined, draft: 'unknown', turnJustEnded: false, forced, remote: false, busy: false });
		}
		const now = this._now();
		const busy = this._busy.get(token);
		if (busy !== undefined && busy.until <= now) {
			this._busy.delete(token);
		}
		const lastTurnEnd = this._lastTurnEnd.get(token);
		const turnJustEnded = lastTurnEnd !== undefined && now - lastTurnEnd <= TURN_END_WINDOW_MS && lastTurnEnd >= (this._lastSubmit.get(token) ?? 0);
		const draft = this._draftOf(token, target.session);
		const draftState: ParadisDocDraftState = draft === undefined ? 'unknown' : draft.trim().length > 0 ? 'text' : 'empty';
		return paradisDecideDocDelivery({
			owner: 'live',
			hasHooks: source.hasAgentHookHistory(token),
			status: source.getPaneAgentStatus(token)?.status,
			unconfirmedRelease: source.getUnconfirmedRelease(token),
			draft: draftState,
			turnJustEnded,
			forced,
			remote: this._docs.sessionOf(token)?.hostId !== '',
			busy: this._busy.has(token),
		});
	}

	private _claimedNow(token: string): boolean {
		const now = this._now();
		for (const [attempt, claim] of this._claims) {
			if (claim.at + CLAIM_TIMEOUT_MS <= now) {
				this._claims.delete(attempt);
			} else if (claim.token === token) {
				return true;
			}
		}
		return false;
	}

	private async _setBlocked(hostId: string, path: string, threads: readonly IParadisDocCommentThread[], block: ParadisDocDeliveryBlock | undefined): Promise<void> {
		if (threads.every(thread => paradisWithDocCommentBlocked(thread, block) === thread)) {
			return;
		}
		const ids = new Set(threads.map(thread => thread.id));
		await this._comments.update(hostId, path, thread => ids.has(thread.id) ? paradisWithDocCommentBlocked(thread, block) : thread);
	}
}

