/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 再起動で外れたブラウザページの共有を張り直す手順（ワークベンチのサービスに依存しない部分）。
// 実際のサービスへの接続は electron-browser/paradisAgentBrowserBindingRestore.contribution.ts。
//
//  1. 起動時の台帳のうち、同じペインと同じページが揃い、まだ共有されていないものを候補にする
//  2. 候補のうち、ユーザーが今見ているスペースのもの（見えないページへの同意にしない）を 1 回の通知にまとめ、
//     「戻す」を選んだものだけを既存の共有の経路で張り直す。「戻さない」なら台帳から消す
//  3. 試す期間（{@link PARADIS_BINDING_RESTORE_WINDOW_MS}）を過ぎたら今回は試さない。台帳からは消さない。
//     スペースの切り替えとリモートの接続が済んだときに期間を数え直す

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	IParadisBindingRestoreCandidate,
	IParadisBindingRestoreEntry,
	paradisBindingRestoreCandidates,
	paradisBindingRestoreKey,
	paradisNextBindingRestoreLedger,
	paradisParseBindingRestoreLedger,
	paradisSerializeBindingRestoreLedger,
} from './paradisBindingRestoreLedger.js';

/** 張り直しを試す期間。起動・スペースの切り替え・リモートの接続から数える。 */
export const PARADIS_BINDING_RESTORE_WINDOW_MS = 3 * 60_000;

/** 状態の変化をまとめて見る間隔。 */
const EVALUATE_DELAY_MS = 500;

/** 準備が整っていない（起動の途中）ときに、もう一度見るまでの間隔。 */
const RETRY_DELAY_MS = 2_000;

/**
 * 候補を今試してよいか。
 * - `ready`: 試せる（ペインとページが同じスペースで、そのスペースを今ユーザーが見ている）
 * - `wait`: まだ決められない・今は見えないスペース。記録は残して後で見る
 * - `never`: 張り直せない（スペースが違う等）。台帳から外す
 */
export type ParadisBindingRestoreReadiness = 'ready' | 'wait' | 'never';

/** 張り直しの結果。`retry` は記録を残してもう一度試す。 */
export type ParadisBindingRestoreOutcome = 'restored' | 'declined' | 'skipped' | 'retry';

/** 通知に出す 1 件分（ページの名前とペインの名前）。 */
export interface IParadisBindingRestoreDescription {
	readonly page: string;
	readonly pane: string;
}

/** 確認の通知の答え。`later` は通知を閉じただけ（今回は試さない。記録は残す）。 */
export type ParadisBindingRestoreAnswer = 'restore' | 'discard' | 'later';

/** 通知に出す名前の長さの上限。 */
export const PARADIS_BINDING_RESTORE_NAME_MAX_LENGTH = 60;

/** リンクの書式に使われる記号を、見た目の近い全角の記号へ置き換える表。 */
const LINK_SYNTAX_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
	['[', '\uFF3B'],
	[']', '\uFF3D'],
	['(', '\uFF08'],
	[')', '\uFF09'],
]);

/**
 * ページ名・ペイン名を、通知の本文に入れても書式として読まれない形にする。通知は `[文字](command:…)` を
 * リンク（コマンドの実行）として描くので、ページやターミナルのタイトルにそれを仕込まれると、押すだけで任意の
 * コマンドが走る。角かっこ・丸かっこを全角にし、改行などの制御文字と双方向の制御文字（表示の順を入れ替えて
 * 別の名前に見せられる）を空白にして、長さを
 * {@link PARADIS_BINDING_RESTORE_NAME_MAX_LENGTH} 文字までに切る。
 */
export function paradisBindingRestoreDisplayName(name: string | undefined, fallback: string): string {
	const cleaned = (name ?? '')
		.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
		.replace(/[\[\]()]/g, character => LINK_SYNTAX_REPLACEMENTS.get(character) ?? character)
		.replace(/\s+/g, ' ')
		.trim();
	const text = cleaned.length > 0 ? cleaned : fallback;
	return text.length > PARADIS_BINDING_RESTORE_NAME_MAX_LENGTH ? `${text.slice(0, PARADIS_BINDING_RESTORE_NAME_MAX_LENGTH - 3)}...` : text;
}

export interface IParadisBindingRestoreHost {
	readStorage(): string | undefined;
	writeStorage(value: string | undefined): void;
	/** このウィンドウの生きているペインのトークン。 */
	listPaneTokens(): readonly string[];
	/** そのペインが今共有されているページ（current）。 */
	boundPageForToken(token: string): string | undefined;
	/** そのペインが current のほかに共有しているページ（古い順）。1 つのペインは複数のページを共有できる。 */
	morePagesForToken?(token: string): readonly string[];
	/** このウィンドウにあるページの ID。 */
	knownPageIds(): ReadonlySet<string>;
	/** ページを開かずに（ID だけで）判定する。 */
	readiness(pageId: string, token: string): ParadisBindingRestoreReadiness;
	describe(pageId: string, token: string): IParadisBindingRestoreDescription;
	/**
	 * まとめて 1 回だけ尋ねる。`token` が取り消されたら（答える前にスペースが切り替わった）、出している
	 * 通知を閉じて `later` を返す。
	 */
	confirm(items: readonly IParadisBindingRestoreDescription[], token: CancellationToken): Promise<ParadisBindingRestoreAnswer>;
	restore(pageId: string, token: string): Promise<ParadisBindingRestoreOutcome>;
	log(message: string, error?: unknown): void;
}

export interface IParadisBindingRestoreControllerOptions {
	readonly now?: () => number;
	readonly windowMs?: number;
	readonly evaluateDelayMs?: number;
	readonly retryDelayMs?: number;
}

export class ParadisBindingRestoreController extends Disposable {

	private _ledger: Map<string, IParadisBindingRestoreEntry>;
	/** 起動時の台帳のうち、まだ張り直すかを決めていない記録のキー。 */
	private readonly _undecided: Set<string>;
	/** この起動でユーザーが「戻す」と答えた記録（再試行では尋ね直さない）。 */
	private readonly _approved = new Set<string>();
	private _deadline: number;
	private _lastWritten: string | undefined;
	/** 尋ねている・張り直している最中か（その間も台帳の更新は続ける。重ねて尋ねないためだけに使う）。 */
	private _busy = false;
	/** 出している確認の通知を閉じるため。 */
	private _confirmation: CancellationTokenSource | undefined;
	private _shuttingDown = false;
	/** 1 つのペインへ複数のページを戻している最中（途中の状態で台帳を書かない）。 */
	private _ledgerHeld = false;
	private readonly _now: () => number;
	private readonly _windowMs: number;
	private readonly _retryDelayMs: number;
	private readonly _scheduler: RunOnceScheduler;

	constructor(private readonly host: IParadisBindingRestoreHost, options: IParadisBindingRestoreControllerOptions = {}) {
		super();
		this._now = options.now ?? Date.now;
		this._windowMs = options.windowMs ?? PARADIS_BINDING_RESTORE_WINDOW_MS;
		this._retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
		this._scheduler = this._register(new RunOnceScheduler(() => { void this.evaluate(); }, options.evaluateDelayMs ?? EVALUATE_DELAY_MS));
		const raw = host.readStorage();
		this._lastWritten = raw;
		this._ledger = paradisParseBindingRestoreLedger(raw, this._now());
		this._undecided = new Set(this._ledger.keys());
		this._deadline = this._now() + this._windowMs;
	}

	/** 状態が変わった。少し待ってまとめて見る。 */
	schedule(delay?: number): void {
		if (this._shuttingDown || this._store.isDisposed) {
			return;
		}
		if (delay !== undefined) {
			this._scheduler.schedule(delay);
		} else if (!this._scheduler.isScheduled()) {
			this._scheduler.schedule();
		}
	}

	/**
	 * スペースが切り替わった。尋ねている最中なら、その通知は前のスペースのページについてなので閉じる
	 * （今回は試さない扱い）。そのうえで試す期間を数え直す。
	 */
	spaceSwitched(): void {
		this._confirmation?.cancel();
		this.restartWindow();
	}

	/** リモートの接続が済んだ（スペースの切り替えからも呼ぶ）。試す期間を数え直す。 */
	restartWindow(): void {
		this._deadline = this._now() + this._windowMs;
		this.schedule();
	}

	/** 終了が始まった。今の状態を同期で 1 回書いてから、以後は書かない（片付けで消えていく共有を書かない）。 */
	beginShutdown(): void {
		if (this._shuttingDown) {
			return;
		}
		this._scheduler.cancel();
		this._updateLedger();
		this._shuttingDown = true;
	}

	override dispose(): void {
		// 出したままの通知を閉じる
		this._confirmation?.cancel();
		super.dispose();
	}

	/** 終了が取り消された。 */
	cancelShutdown(): void {
		this._shuttingDown = false;
		this.schedule();
	}

	get undecidedCount(): number {
		return this._undecided.size;
	}

	/** 1 回分の評価。台帳を書き、試せる候補があれば尋ねて張り直す（終わるまで待つ）。 */
	async evaluate(): Promise<void> {
		if (this._shuttingDown || this._store.isDisposed) {
			return;
		}
		const { liveTokenByKey, boundKeys } = this._updateLedger();
		if (this._busy || this._undecided.size === 0 || this._now() > this._deadline) {
			return;
		}
		const ready: IParadisBindingRestoreCandidate[] = [];
		let waiting = false;
		for (const candidate of paradisBindingRestoreCandidates(this._ledger, this._undecided, liveTokenByKey, boundKeys, this.host.knownPageIds())) {
			const readiness = this.host.readiness(candidate.pageId, candidate.token);
			if (readiness === 'ready') {
				ready.push(candidate);
			} else if (readiness === 'never') {
				this._undecided.delete(candidate.key);
			} else {
				waiting = true;
			}
		}
		if (ready.length === 0) {
			if (waiting) {
				this.schedule(this._retryDelayMs);
			}
			this._updateLedger();
			return;
		}
		this._busy = true;
		let retry = waiting;
		try {
			const toAsk = ready.filter(candidate => !this._approved.has(candidate.key));
			if (toAsk.length > 0) {
				const confirmation = this._confirmation = new CancellationTokenSource();
				let answer: ParadisBindingRestoreAnswer;
				let cancelled = false;
				try {
					// 1 つのペインへ複数のページを戻すときは、ページごとに並べる（何への同意かが分かるように）
					answer = await this.host.confirm(toAsk.flatMap(candidate => [...candidate.morePageIds, candidate.pageId].map(pageId => this.host.describe(pageId, candidate.token))), confirmation.token);
				} finally {
					cancelled = confirmation.token.isCancellationRequested;
					this._confirmation = undefined;
					confirmation.dispose();
				}
				if (this._shuttingDown || this._store.isDisposed) {
					return;
				}
				if (cancelled) {
					// 答える前にスペースが切り替わった。期間は数え直し済みなので、そのまま次の評価に任せる
					return;
				}
				if (answer === 'discard') {
					for (const candidate of toAsk) {
						this._undecided.delete(candidate.key);
					}
				} else if (answer === 'later') {
					// 閉じただけ。今回は試さず、次のスペースの切り替え・接続で尋ね直す
					this._deadline = 0;
					return;
				} else {
					for (const candidate of toAsk) {
						this._approved.add(candidate.key);
					}
				}
			}
			for (const candidate of ready) {
				if (!this._approved.has(candidate.key) || this._shuttingDown || this._store.isDisposed) {
					continue;
				}
				// 尋ねている間・前の張り直しの間にスペースが切り替わっていれば、見えなくなったページは後回しにする
				if (this.host.readiness(candidate.pageId, candidate.token) !== 'ready') {
					retry = true;
					continue;
				}
				// current を先に戻す（戻らなければ 2 枚目以降も戻さず、記録は今までどおり残す・捨てる）。戻ったら
				// 2 枚目以降を古い順に戻し、最後に current をもう一度共有して current に戻す（共有は最後のものが current）。
				// その間は台帳を書かない（途中の状態で台帳を上書きしない）
				this._ledgerHeld = true;
				let outcome: ParadisBindingRestoreOutcome;
				try {
					outcome = await this._restoreOne(candidate.pageId, candidate.token);
					if (outcome === 'restored' && candidate.morePageIds.length > 0) {
						let restoredMore = false;
						for (const pageId of candidate.morePageIds) {
							if (this._shuttingDown || this._store.isDisposed) {
								break;
							}
							const readiness = this.host.readiness(pageId, candidate.token);
							if (readiness !== 'ready') {
								this.host.log(`did not restore one of the other pages a pane shared (${readiness === 'never' ? 'it moved to another space' : 'its space is not on screen'})`);
								continue;
							}
							restoredMore = (await this._restoreOne(pageId, candidate.token)) === 'restored' || restoredMore;
						}
						if (restoredMore && !this._shuttingDown && !this._store.isDisposed) {
							await this._restoreOne(candidate.pageId, candidate.token);
						}
					}
				} finally {
					this._ledgerHeld = false;
				}
				if (outcome === 'retry') {
					retry = true;
				} else {
					this._undecided.delete(candidate.key);
					this._approved.delete(candidate.key);
				}
			}
		} finally {
			this._busy = false;
			if (!this._shuttingDown && !this._store.isDisposed) {
				this._updateLedger();
				if (retry) {
					this.schedule(this._retryDelayMs);
				} else {
					this.schedule();
				}
			}
		}
	}

	private async _restoreOne(pageId: string, token: string): Promise<ParadisBindingRestoreOutcome> {
		try {
			return await this.host.restore(pageId, token);
		} catch (error) {
			this.host.log('failed to restore a browser share after restart', error);
			return 'skipped';
		}
	}

	private _updateLedger(): { liveTokenByKey: Map<string, string>; boundKeys: Set<string> } {
		const liveTokenByKey = new Map<string, string>();
		for (const token of this.host.listPaneTokens()) {
			liveTokenByKey.set(paradisBindingRestoreKey(token), token);
		}
		const boundPageByKey = new Map<string, string>();
		const morePagesByKey = new Map<string, readonly string[]>();
		for (const [key, token] of liveTokenByKey) {
			const pageId = this.host.boundPageForToken(token);
			if (pageId !== undefined) {
				boundPageByKey.set(key, pageId);
				morePagesByKey.set(key, this.host.morePagesForToken?.(token) ?? []);
				// 既に紐づいている（ウィンドウの再読み込みで shared process に残っていた・張り直した）
				this._undecided.delete(key);
			}
		}
		if (!this._shuttingDown && !this._ledgerHeld) {
			this._ledger = paradisNextBindingRestoreLedger(this._ledger, this._undecided, boundPageByKey, this._now(), morePagesByKey);
			this._persist();
		}
		return { liveTokenByKey, boundKeys: new Set(boundPageByKey.keys()) };
	}

	private _persist(): void {
		const serialized = this._ledger.size === 0 ? undefined : paradisSerializeBindingRestoreLedger(this._ledger);
		if (serialized === this._lastWritten) {
			return;
		}
		this._lastWritten = serialized;
		this.host.writeStorage(serialized);
	}
}
