/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	IParadisHumanAskAnswerRequest,
	IParadisHumanAskEntry,
	IParadisHumanAskInput,
	IParadisHumanAskResolution,
	IParadisHumanAskSnapshot,
	ParadisHumanAskAnswerResult,
	ParadisHumanAskSurface,
	paradisHumanAskAnswerSummary,
	paradisHumanAskCounts,
	paradisHumanAskKey,
	paradisSanitizeHumanAskAnswer,
} from './paradisHumanAsk.js';

export interface IParadisHumanAskLedgerOptions {
	/** 答えを届ける依頼を出してから、持ち主の一覧にまだ残っていたら「届かなかった」とみなすまでの時間。 */
	readonly claimTimeoutMs: number;
	/**
	 * 回答済みにした鍵を、遅れて届いた古い一覧で待ちに戻さない時間。取り下げた鍵は守らない: 持ち主は
	 * 変わったときしか知らせないので、同じ問いがすぐ出直したときに無視すると、そのまま出てこなくなる。
	 */
	readonly reviveGuardMs: number;
	/** 回答済み・取り下げになったものを、ほかの場所が「よそで回答済み」と出せるように残しておく時間。 */
	readonly recentTtlMs: number;
	/** 残しておく回答済み・取り下げの件数の上限。 */
	readonly recentLimit: number;
	/** 待ちの件数の上限。超えた分は入れない（持ち主が減らして知らせ直すまで）。 */
	readonly waitingLimit: number;
}

export const PARADIS_HUMAN_ASK_LEDGER_DEFAULTS: IParadisHumanAskLedgerOptions = Object.freeze({
	claimTimeoutMs: 20_000,
	reviveGuardMs: 10_000,
	recentTtlMs: 60_000,
	recentLimit: 50,
	waitingLimit: 500,
});

interface IPending {
	readonly claim: string;
	readonly surface: ParadisHumanAskSurface;
	readonly at: number;
	readonly summary?: string;
}

interface IMutableEntry {
	input: IParadisHumanAskInput;
	readonly key: string;
	owner: string;
	/** 入った順（同じ時刻の待ちを安定して並べる）。 */
	order: number;
	askedAt: number;
	state: IParadisHumanAskEntry['state'];
	pending?: IPending;
	failedAt?: number;
	resolution?: IParadisHumanAskResolution;
}

/**
 * 「人が答えるもの」の台帳本体（shared process で 1 つだけ動く）。I/O もタイマーも持たない純粋なクラスで、
 * 変更系のメソッドは「中身が変わったか」を返す。変わったときだけ呼び出し側が知らせを出す。
 *
 * 持ち主（出どころごとの取り込み役）との決まり:
 * - 自分の待ちは {@link sync}（丸ごと）か {@link upsert}（1 件）で知らせる。一覧から消えた待ちは取り下げになる。
 *   知らせは作った順に 1 つずつ送る（順序が入れ替わると、古い一覧が新しい一覧を上書きする）
 * - 元の場所（ターミナル・ボードの窓）で答えられたら {@link resolve}、エージェントが先へ進んだら {@link withdraw}
 * - {@link claim} が返した依頼を受け取ったら、答えを届け、届いたら {@link resolve}、届かなかったら {@link reject}。
 *   どちらも呼べないときは、次の {@link sync} で決まる（一覧から消えていれば回答済み、時間切れの後も
 *   残っていれば待ちへ戻す）。**依頼を受けたまま何も知らせないと、その 1 件はどこからも答えられないまま残る**
 *
 * 答えは早い者勝ち。届けている最中の 1 件は {@link claim} が `busy` で断る。時間切れだけでは待ちへ
 * 戻さない: キー操作は届いたのに結果の知らせだけ落ちた場合に、二度目の答えが別のプロンプトへ入るため。
 */
export class ParadisHumanAskLedger {

	private readonly entries = new Map<string, IMutableEntry>();
	private readonly options: IParadisHumanAskLedgerOptions;
	private sequence = 0;
	/** スナップショットの番号。shared process が起動し直しても戻らないよう、作った時刻から数え始める。 */
	private revision: number;

	constructor(
		private readonly now: () => number = Date.now,
		options: Partial<IParadisHumanAskLedgerOptions> = {},
	) {
		this.options = { ...PARADIS_HUMAN_ASK_LEDGER_DEFAULTS, ...options };
		this.revision = now();
	}

	// ---- 持ち主が呼ぶ ---------------------------------------------------------------------------

	/** 持ち主の待ちを丸ごと置き換える。一覧に無い待ちは取り下げ（届けている最中だったものは回答済み）にする。 */
	sync(owner: string, inputs: readonly IParadisHumanAskInput[]): boolean {
		const listed = new Set<string>();
		let changed = false;
		for (const input of inputs) {
			listed.add(paradisHumanAskKey(input.source, input.id));
			changed = this.apply(owner, input) || changed;
		}
		const at = this.now();
		for (const entry of this.entries.values()) {
			if (entry.owner !== owner || entry.state !== 'waiting' || listed.has(entry.key)) {
				continue;
			}
			if (entry.pending) {
				// 届けている最中に持ち主の一覧から消えた。答えが届いて先へ進んだ
				this.settle(entry, 'answered', { at, surface: entry.pending.surface, ...(entry.pending.summary !== undefined ? { summary: entry.pending.summary } : {}) });
			} else {
				this.settle(entry, 'withdrawn', { at });
			}
			changed = true;
		}
		return this.prune() || changed;
	}

	/** 1 件を足す・書き換える。 */
	upsert(owner: string, input: IParadisHumanAskInput): boolean {
		const changed = this.apply(owner, input);
		return this.prune() || changed;
	}

	/**
	 * 回答済みにする。元の場所で答えられたとき（`surface` に持ち主の場所を渡す）と、依頼された答えを
	 * 届け終えたとき（何も渡さなければ、依頼した場所と答えの要約を使う）に呼ぶ。
	 */
	resolve(owner: string, key: string, resolution: { readonly surface?: ParadisHumanAskSurface; readonly summary?: string } = {}): boolean {
		const entry = this.waitingOf(owner, key);
		if (entry === undefined) {
			return false;
		}
		const surface = resolution.surface ?? entry.pending?.surface;
		const summary = resolution.summary ?? (resolution.surface === undefined ? entry.pending?.summary : undefined);
		this.settle(entry, 'answered', { at: this.now(), ...(surface !== undefined ? { surface } : {}), ...(summary !== undefined ? { summary } : {}) });
		this.prune();
		return true;
	}

	/** 依頼された答えが届かなかった。待ちへ戻す。`claim` が今の依頼のものでなければ何もしない（遅れて届いた古い結果）。 */
	reject(owner: string, key: string, claim: string): boolean {
		const entry = this.waitingOf(owner, key);
		if (entry === undefined || entry.pending?.claim !== claim) {
			return false;
		}
		entry.pending = undefined;
		entry.failedAt = this.now();
		return true;
	}

	/** 取り下げる（エージェントが先へ進んだ、ペインが閉じた）。 */
	withdraw(owner: string, key: string): boolean {
		const entry = this.waitingOf(owner, key);
		if (entry === undefined) {
			return false;
		}
		this.settle(entry, 'withdrawn', { at: this.now() });
		this.prune();
		return true;
	}

	/** 持ち主がいなくなった（ボードが止まった等）。その待ちを取り下げる。戻ってきて同じ鍵を知らせたら待ちに戻る。 */
	removeOwner(owner: string): boolean {
		const at = this.now();
		let changed = false;
		for (const entry of this.entries.values()) {
			if (entry.owner === owner && entry.state === 'waiting') {
				this.settle(entry, 'withdrawn', { at });
				changed = true;
			}
		}
		return this.prune() || changed;
	}

	// ---- 答える場所が呼ぶ -----------------------------------------------------------------------

	/**
	 * 答える。待ちで、ほかの場所が届けている最中でなければ、その 1 件を押さえて持ち主への依頼を返す。
	 * 呼び出し側（サービス）が依頼を持ち主へ流す。
	 */
	claim(key: string, answer: unknown, surface: ParadisHumanAskSurface): ParadisHumanAskAnswerResult {
		const entry = this.entries.get(key);
		if (entry === undefined || entry.state !== 'waiting') {
			return { ok: false, reason: 'gone' };
		}
		if (entry.pending) {
			return { ok: false, reason: 'busy' };
		}
		const sanitized = paradisSanitizeHumanAskAnswer(entry.input, answer);
		if (sanitized === undefined) {
			return { ok: false, reason: 'invalid' };
		}
		const summary = paradisHumanAskAnswerSummary(entry.input, sanitized);
		entry.pending = { claim: String(++this.sequence), surface, at: this.now(), ...(summary !== undefined ? { summary } : {}) };
		entry.failedAt = undefined;
		const request: IParadisHumanAskAnswerRequest = {
			claim: entry.pending.claim,
			key,
			owner: entry.owner,
			source: entry.input.source,
			id: entry.input.id,
			...(entry.input.paneKey !== undefined ? { paneKey: entry.input.paneKey } : {}),
			...(entry.input.windowId !== undefined ? { windowId: entry.input.windowId } : {}),
			answer: sanitized,
			surface,
		};
		return { ok: true, request };
	}

	// ---- 読む -----------------------------------------------------------------------------------

	get(key: string): IParadisHumanAskEntry | undefined {
		const entry = this.entries.get(key);
		return entry ? this.toEntry(entry, this.folds()) : undefined;
	}

	/** 変更系のメソッドが true を返したら呼ぶ（スナップショットの番号を進める）。 */
	bumpRevision(): void {
		this.revision++;
	}

	snapshot(): IParadisHumanAskSnapshot {
		const at = this.now();
		const folds = this.folds();
		const waiting: IMutableEntry[] = [];
		const recent: IMutableEntry[] = [];
		for (const entry of this.entries.values()) {
			if (entry.state === 'waiting') {
				waiting.push(entry);
			} else if (at - (entry.resolution?.at ?? 0) < this.options.recentTtlMs) {
				recent.push(entry);
			}
		}
		waiting.sort((a, b) => b.askedAt - a.askedAt || b.order - a.order);
		recent.sort((a, b) => (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0) || b.order - a.order);
		const entries = [...waiting, ...recent].map(entry => this.toEntry(entry, folds));
		return { entries, counts: paradisHumanAskCounts(entries), revision: this.revision };
	}

	// ---- 中身 -----------------------------------------------------------------------------------

	private apply(owner: string, input: IParadisHumanAskInput): boolean {
		const key = paradisHumanAskKey(input.source, input.id);
		const at = this.now();
		const existing = this.entries.get(key);
		if (existing === undefined) {
			if (this.waitingCount() >= this.options.waitingLimit) {
				return false;
			}
			this.entries.set(key, { input, key, owner, order: ++this.sequence, askedAt: input.askedAt ?? at, state: 'waiting' });
			return true;
		}
		if (existing.state === 'waiting') {
			if (existing.owner !== owner) {
				// 鍵は出どころの中で一意。別の持ち主が同じ鍵を名乗っても、先に待っている 1 件を書き換えさせない
				return false;
			}
			let changed = false;
			if (existing.pending && at - existing.pending.at >= this.options.claimTimeoutMs) {
				// 時間切れの後も持ち主の一覧に残っている。答えは届かなかった
				existing.pending = undefined;
				existing.failedAt = at;
				changed = true;
			}
			if (!sameInput(existing.input, input)) {
				existing.input = input;
				changed = true;
			}
			return changed;
		}
		// 回答済みになった鍵。直後に届いた一覧は、答える前に作られた古いものかもしれないので待ちに戻さない。
		// 取り下げた鍵は、持ち主がまた知らせてきたらすぐ待ちに戻す
		if (existing.state === 'answered' && at - (existing.resolution?.at ?? 0) < this.options.reviveGuardMs) {
			return false;
		}
		if (this.waitingCount() >= this.options.waitingLimit) {
			return false;
		}
		this.entries.set(key, { input, key, owner, order: ++this.sequence, askedAt: input.askedAt ?? at, state: 'waiting' });
		return true;
	}

	private waitingOf(owner: string, key: string): IMutableEntry | undefined {
		const entry = this.entries.get(key);
		return entry !== undefined && entry.owner === owner && entry.state === 'waiting' ? entry : undefined;
	}

	private settle(entry: IMutableEntry, state: 'answered' | 'withdrawn', resolution: IParadisHumanAskResolution): void {
		entry.state = state;
		entry.resolution = resolution;
		entry.pending = undefined;
		entry.failedAt = undefined;
	}

	private waitingCount(): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (entry.state === 'waiting') {
				count++;
			}
		}
		return count;
	}

	/** 残しておく時間を過ぎた・上限を超えた回答済み・取り下げを捨てる。 */
	private prune(): boolean {
		const at = this.now();
		const settled = [...this.entries.values()]
			.filter(entry => entry.state !== 'waiting')
			.sort((a, b) => (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0) || b.order - a.order);
		let changed = false;
		settled.forEach((entry, index) => {
			if (index >= this.options.recentLimit || at - (entry.resolution?.at ?? 0) >= this.options.recentTtlMs) {
				this.entries.delete(entry.key);
				changed = true;
			}
		});
		return changed;
	}

	/**
	 * 寄せ先（ペインの待ちの鍵 → ボード・Bot の待ちの鍵）。同じペインの**同じ種類**の待ちだけを寄せる。
	 * 種類が違えば別の用件（ボードの「止まった」の裏でペインが許可を待っている等）なので、両方出す。
	 * 毎回計算し直すので、寄せ先が回答済み・取り下げになれば、寄せていた側はそのまま出てくる。
	 */
	private folds(): ReadonlyMap<string, string> {
		const targets = new Map<string, IMutableEntry>();
		for (const entry of this.entries.values()) {
			if (entry.state !== 'waiting' || entry.input.source === 'pane' || entry.input.paneKey === undefined) {
				continue;
			}
			const slot = `${entry.input.paneKey}\0${entry.input.kind}`;
			const current = targets.get(slot);
			if (current === undefined || entry.order < current.order) {
				targets.set(slot, entry);
			}
		}
		const folds = new Map<string, string>();
		for (const entry of this.entries.values()) {
			if (entry.state === 'waiting' && entry.input.source === 'pane' && entry.input.paneKey !== undefined) {
				const target = targets.get(`${entry.input.paneKey}\0${entry.input.kind}`);
				if (target !== undefined) {
					folds.set(entry.key, target.key);
				}
			}
		}
		return folds;
	}

	private toEntry(entry: IMutableEntry, folds: ReadonlyMap<string, string>): IParadisHumanAskEntry {
		const foldedInto = folds.get(entry.key);
		return {
			...entry.input,
			key: entry.key,
			owner: entry.owner,
			askedAt: entry.askedAt,
			state: entry.state,
			...(entry.pending !== undefined ? { pending: { surface: entry.pending.surface, at: entry.pending.at } } : {}),
			...(entry.failedAt !== undefined ? { failedAt: entry.failedAt } : {}),
			...(entry.resolution !== undefined ? { resolution: entry.resolution } : {}),
			...(foldedInto !== undefined ? { foldedInto } : {}),
		};
	}
}

/** 持ち主が同じ中身を知らせ直しただけか（そのたびに知らせを出さないため）。検め済みの値どうしを比べる。 */
function sameInput(a: IParadisHumanAskInput, b: IParadisHumanAskInput): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
