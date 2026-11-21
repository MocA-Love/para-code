/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 外れたブラウザページの共有（再起動・つなぎ直しで勝手に外れたもの）を張り直す手順（ワークベンチのサービスに
// 依存しない部分）。実際のサービスへの接続は electron-browser/paradisAgentBrowserBindingRestore.contribution.ts。
//
//  1. 台帳の行のうち、同じペインと同じページが揃い、まだ共有されておらず、ページのオリジンが控えと同じものを
//     候補にする。尋ねずに既存の共有の経路で張り直し、戻した件数を知らせる
//  2. 時間で試し直す期間（{@link PARADIS_BINDING_RESTORE_WINDOW_MS}）は、起動・スペースの切り替え・リモートの
//     接続と、台帳にあるペインの端末がつなぎ直された（トークンが現れた）ときに数え直す。端末がまだ戻っていない
//     行はタイマーを回さず、現れるのを待つ。期間を過ぎたら試さないが、台帳からは消さない
//     同じ期間の中では、1 つのペインを戻すのは 1 回だけ（戻した直後にまた外れても、次の期間まで戻さない）
//  3. 行を消すのは、利用者が共有を外したとき・端末が終わったとき・戻せないと分かったとき（スペースが違う、
//     共有の検査に断られた等）。勝手に外れただけの行は残す

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import {
	IParadisBindingRestoreCandidate,
	IParadisBindingRestoreEntry,
	paradisBindingRestoreCandidates,
	paradisBindingRestoreKey,
	paradisNextBindingRestoreLedger,
	paradisParseBindingRestoreLedger,
	paradisRemovePageFromBindingRestoreEntry,
	paradisSerializeBindingRestoreLedger,
} from './paradisBindingRestoreLedger.js';

/** 時間で試し直す期間。起動・スペースの切り替え・リモートの接続・端末のつなぎ直しから数える。 */
export const PARADIS_BINDING_RESTORE_WINDOW_MS = 3 * 60_000;

/** 状態の変化をまとめて見る間隔。 */
const EVALUATE_DELAY_MS = 500;

/** 準備が整っていない（起動の途中）ときに、もう一度見るまでの間隔。 */
const RETRY_DELAY_MS = 2_000;

/**
 * 候補を今試してよいか。
 * - `ready`: 試せる（ペインとページが同じスペース。今見ていないスペースでもよい）
 * - `wait`: まだ決められない。記録は残して後で見る
 * - `never`: 張り直せない（スペースが違う等）。台帳から外す
 */
export type ParadisBindingRestoreReadiness = 'ready' | 'wait' | 'never';

/**
 * 張り直しの結果。`retry` は記録を残してもう一度試す。`moved` はページが別のサイトへ移っていた（そのページだけ
 * 台帳から外す）。`skipped` は戻せない（行を台帳から外し、試し直さない）。`failed` は理由の分からない失敗
 * （行は残し、次に期間を数え直すまで試さない）。
 */
export type ParadisBindingRestoreOutcome = 'restored' | 'skipped' | 'retry' | 'moved' | 'failed';

/**
 * 共有の経路が投げた失敗の扱いを決める。別の窓のペイン・ページ（ownerConflict）とスペースの違い
 * （scopeMismatch）は戻せないので行を消す（`skipped`）。状態が動いている最中の失敗（PARA_BROWSER_RETRYABLE と、
 * 窓の一覧の同期が済む前・変わった直後に authority が返すもの）はもう一度試す。ほかの失敗（shared process に
 * 届かない等）は行を残し、次に期間を数え直すまで試さない（`failed`）。
 */
export function paradisBindingRestoreFailureOutcome(error: unknown): 'retry' | 'skipped' | 'failed' {
	const message = error instanceof Error ? error.message : '';
	if (message.startsWith('PARA_BROWSER_RETRYABLE')) {
		return 'retry';
	}
	const reason = /Binding authority rejected: (?<reason>\w+)/.exec(message)?.groups?.reason;
	if (reason === 'ownerConflict' || reason === 'scopeMismatch') {
		return 'skipped';
	}
	return reason !== undefined && ['manifestRequired', 'missingEntry', 'pendingScope', 'revisionMismatch', 'staleRevision', 'staleSnapshot', 'staleTicket', 'expiredTicket', 'staleConnection'].includes(reason) ? 'retry' : 'failed';
}

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
	/** ページの今のオリジン（ページを開かずに分かる範囲で。分からなければ undefined）。 */
	originOf(pageId: string): string | undefined;
	/** ページを開かずに（ID だけで）判定する。 */
	readiness(pageId: string, token: string): ParadisBindingRestoreReadiness;
	/** 既存の共有の経路で張り直す。`origin` は台帳に控えたオリジンで、ページを開いた後にもう一度照合する。 */
	restore(pageId: string, token: string, origin: string): Promise<ParadisBindingRestoreOutcome>;
	/** 1 回の評価で戻したページの数と、別のサイトへ移っていて戻さなかったページの数（どちらかが 1 以上のときだけ呼ぶ）。 */
	report(restored: number, moved: number): void;
	log(message: string, error?: unknown): void;
}

export interface IParadisBindingRestoreControllerOptions {
	readonly now?: () => number;
	readonly windowMs?: number;
	readonly evaluateDelayMs?: number;
	readonly retryDelayMs?: number;
}

/** 利用者が外している最中の共有。`key` が無ければ全ペイン、`pageId` が無ければそのペインの全ページ。 */
interface IUserUnbind {
	readonly key: string | undefined;
	readonly pageId: string | undefined;
}

export class ParadisBindingRestoreController extends Disposable {

	private _ledger: Map<string, IParadisBindingRestoreEntry>;
	private _deadline: number;
	private _lastWritten: string | undefined;
	/** 張り直している最中か（その間も台帳の更新は続ける。重ねて張り直さないためだけに使う）。 */
	private _busy = false;
	private _shuttingDown = false;
	/** 1 つのペインへ複数のページを戻している最中（途中の状態で台帳を書かない）。 */
	private _ledgerHeld = false;
	/** 前の評価で生きていたペインのキー（端末がつなぎ直されたのを見つけるため）。 */
	private _liveKeys = new Set<string>();
	/** 今の期間で戻した・失敗したペインのキー（同じ期間ではもう試さない。期間を数え直すと空にする）。 */
	private readonly _triedKeys = new Set<string>();
	/** 端末が終わったと知らされたペインのキー。次の評価でも居なければ行を消す（付け替えの途中と区別する）。 */
	private readonly _endedKeys = new Set<string>();
	/** 利用者が外している最中の共有（外し終わるまで台帳に書き戻さず、張り直しもしない）。 */
	private readonly _userUnbinds = new Set<IUserUnbind>();
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

	/** スペースが切り替わった・リモートの接続が済んだ。試し直す期間を数え直す。 */
	restartWindow(): void {
		this._startWindow();
		this.schedule();
	}

	private _startWindow(): void {
		this._deadline = this._now() + this._windowMs;
		this._triedKeys.clear();
	}

	/**
	 * 利用者が共有を外し始めた。その共有を台帳から消し、返した IDisposable を dispose する（外し終わる）まで
	 * 台帳に書き戻さず、張り直しもしない。`token` が無ければそのページの全ペイン、`pageId` が無ければそのペインの
	 * 全ページ。
	 */
	userUnbind(token: string | undefined, pageId: string | undefined): IDisposable {
		const unbind: IUserUnbind = { key: token === undefined ? undefined : paradisBindingRestoreKey(token), pageId };
		this._userUnbinds.add(unbind);
		this._forget(unbind);
		return toDisposable(() => {
			// 外している間に書き戻された分（張り直しの途中だった等）も消す。外せずに共有が残っていれば、次の評価で書き直される
			this._userUnbinds.delete(unbind);
			this._forget(unbind);
			this.schedule();
		});
	}

	/** 端末が終わった（シェルの終了・利用者が閉じた）。次の評価でもそのペインが居なければ行を消す。 */
	paneEnded(token: string): void {
		if (this._shuttingDown || this._store.isDisposed) {
			return;
		}
		this._endedKeys.add(paradisBindingRestoreKey(token));
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

	/** 終了が取り消された。 */
	cancelShutdown(): void {
		this._shuttingDown = false;
		this.schedule();
	}

	/** 1 回分の評価。台帳を書き、試せる候補があれば張り直す（終わるまで待つ）。 */
	async evaluate(): Promise<void> {
		if (this._shuttingDown || this._store.isDisposed) {
			return;
		}
		const { liveTokenByKey, boundKeys } = this._updateLedger();
		if (this._busy || this._now() > this._deadline) {
			return;
		}
		let restored = 0;
		let moved = 0;
		const { candidates, dropped } = paradisBindingRestoreCandidates(this._ledger, liveTokenByKey, boundKeys, this.host.knownPageIds(), pageId => this.host.originOf(pageId));
		for (const page of dropped) {
			if (this._isUserUnbinding(page.key, page.pageId)) {
				continue;
			}
			this._forgetPage(page.key, page.pageId);
			if (page.reason === 'moved') {
				moved++;
			} else {
				this.host.log('did not restore a browser share: the record has no origin to compare the page with');
			}
		}
		const ready: IParadisBindingRestoreCandidate[] = [];
		let retry = false;
		for (const candidate of candidates) {
			if (this._triedKeys.has(candidate.key)) {
				continue;
			}
			if ([...candidate.morePageIds, candidate.pageId].some(pageId => this._isUserUnbinding(candidate.key, pageId))) {
				continue;
			}
			const readiness = this.host.readiness(candidate.pageId, candidate.token);
			if (readiness === 'ready') {
				ready.push(candidate);
			} else if (readiness === 'never') {
				this._ledger.delete(candidate.key);
			} else {
				retry = true;
			}
		}
		this._busy = true;
		try {
			for (const candidate of ready) {
				if (this._shuttingDown || this._store.isDisposed) {
					break;
				}
				// current を先に戻す（戻らなければ 2 枚目以降も戻さない）。戻ったら 2 枚目以降を古い順に戻し、最後に
				// current をもう一度共有して current に戻す（共有は最後のものが current）。
				// その間は台帳を書かない（途中の状態で台帳を上書きしない）
				this._ledgerHeld = true;
				let outcome: ParadisBindingRestoreOutcome;
				try {
					outcome = await this._restoreOne(candidate, candidate.pageId);
					if (outcome === 'restored') {
						restored++;
						let restoredMore = false;
						for (const pageId of candidate.morePageIds) {
							if (this._shuttingDown || this._store.isDisposed) {
								break;
							}
							const readiness = this.host.readiness(pageId, candidate.token);
							if (readiness !== 'ready') {
								this.host.log(`did not restore one of the other pages a pane shared (${readiness === 'never' ? 'it moved to another space' : 'its space is not settled'})`);
								continue;
							}
							const more = await this._restoreOne(candidate, pageId);
							if (more === 'restored') {
								restored++;
								restoredMore = true;
							} else if (more === 'moved') {
								moved++;
							}
						}
						if (restoredMore && !this._shuttingDown && !this._store.isDisposed) {
							await this._restoreOne(candidate, candidate.pageId);
						}
					}
				} finally {
					this._ledgerHeld = false;
				}
				if (outcome === 'retry') {
					retry = true;
				} else if (outcome === 'restored' || outcome === 'failed') {
					this._triedKeys.add(candidate.key);
				} else if (outcome === 'moved') {
					// そのページだけ外す。残りのページは次の評価で戻す
					this._forgetPage(candidate.key, candidate.pageId);
					moved++;
				} else if (outcome === 'skipped') {
					this._ledger.delete(candidate.key);
				}
			}
		} finally {
			this._busy = false;
			if (!this._shuttingDown && !this._store.isDisposed) {
				this._updateLedger();
				if (retry) {
					this.schedule(this._retryDelayMs);
				} else if (ready.length > 0) {
					this.schedule();
				}
				if (restored > 0 || moved > 0) {
					this.host.report(restored, moved);
				}
			}
		}
	}

	private async _restoreOne(candidate: IParadisBindingRestoreCandidate, pageId: string): Promise<ParadisBindingRestoreOutcome> {
		try {
			return await this.host.restore(pageId, candidate.token, candidate.origins[pageId]);
		} catch (error) {
			this.host.log('failed to restore a browser share', error);
			return paradisBindingRestoreFailureOutcome(error);
		}
	}

	private _isUserUnbinding(key: string, pageId: string): boolean {
		for (const unbind of this._userUnbinds) {
			if ((unbind.key === undefined || unbind.key === key) && (unbind.pageId === undefined || unbind.pageId === pageId)) {
				return true;
			}
		}
		return false;
	}

	private _forget(unbind: IUserUnbind): void {
		for (const key of unbind.key === undefined ? [...this._ledger.keys()] : [unbind.key]) {
			if (unbind.pageId === undefined) {
				this._ledger.delete(key);
			} else {
				this._forgetPage(key, unbind.pageId);
			}
		}
		if (!this._shuttingDown && !this._ledgerHeld) {
			this._persist();
		}
	}

	private _forgetPage(key: string, pageId: string): void {
		const entry = this._ledger.get(key);
		if (entry === undefined) {
			return;
		}
		const next = paradisRemovePageFromBindingRestoreEntry(entry, pageId);
		if (next === undefined) {
			this._ledger.delete(key);
		} else {
			this._ledger.set(key, next);
		}
	}

	private _updateLedger(): { liveTokenByKey: Map<string, string>; boundKeys: Set<string> } {
		const liveTokenByKey = new Map<string, string>();
		for (const token of this.host.listPaneTokens()) {
			liveTokenByKey.set(paradisBindingRestoreKey(token), token);
		}
		const boundKeys = new Set<string>();
		const boundPageByKey = new Map<string, string>();
		const morePagesByKey = new Map<string, readonly string[]>();
		const originByPageId = new Map<string, string>();
		for (const [key, token] of liveTokenByKey) {
			const current = this.host.boundPageForToken(token);
			if (current === undefined) {
				continue;
			}
			boundKeys.add(key);
			// 利用者が外している最中のページは書かない
			const pages = [...(this.host.morePagesForToken?.(token) ?? []), current].filter(pageId => !this._isUserUnbinding(key, pageId));
			const pageId = pages.pop();
			if (pageId === undefined) {
				continue;
			}
			boundPageByKey.set(key, pageId);
			morePagesByKey.set(key, pages);
			for (const page of [...pages, pageId]) {
				const origin = this.host.originOf(page);
				if (origin !== undefined) {
					originByPageId.set(page, origin);
				}
			}
		}
		if (!this._shuttingDown && !this._ledgerHeld) {
			// 終わったと知らされた端末が、付け替えではなく本当に居なくなっていたら行を消す
			for (const key of this._endedKeys) {
				if (!liveTokenByKey.has(key)) {
					this._ledger.delete(key);
				}
			}
			this._endedKeys.clear();
			// 台帳にあるペインの端末がつなぎ直された。そこから試し直す期間を数える
			for (const key of liveTokenByKey.keys()) {
				if (!this._liveKeys.has(key) && this._ledger.has(key) && !boundKeys.has(key)) {
					this._startWindow();
					break;
				}
			}
			this._liveKeys = new Set(liveTokenByKey.keys());
			this._ledger = paradisNextBindingRestoreLedger(this._ledger, boundPageByKey, this._now(), morePagesByKey, originByPageId);
			this._persist();
		}
		return { liveTokenByKey, boundKeys };
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
