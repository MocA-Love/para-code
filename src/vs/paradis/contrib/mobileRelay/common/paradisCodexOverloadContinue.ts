/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Codex のモデルが混み合って（`codex_error_info = "server_overloaded"`、「Selected model is at capacity」）ターンが
 * 終わったとき、少し待ってから自動で `continue` を送る。
 *
 * Codex 自身はこのエラーを、サーバーが Retry-After を付けたときしか再試行しない（WebSocket と SSE では付かないと 1 回で
 * 終わる。codex-rs `protocol/src/error.rs` の `retry_delay`）。ユーザーは毎回手で continue を送っていた。
 *
 * - 対象は本会話（ペインの transcript）のターンだけ。審査役（guardian）のスレッドはペインの transcript にならない
 * - 待つ間隔は 30・60・120 秒と延ばし、3 回続けて送っても混み合ったままなら止めて知らせる（明らかな障害とみなす）
 * - 待つ間にターンが始まった（ユーザーが送った）・ペインや会話が終わった・設定が切られたら送らない
 * - ほかのエラー（利用上限・接続の失敗など）とユーザーの中断では送らない
 *
 * ここは時計と送り方を外から受け取るだけの純粋な部品（`ParadisMobileAgentChat` が使う）。
 */

/** 設定: Codex のモデルが混み合って止まったとき、自動で続けるか（既定オン）。 */
export const PARADIS_CODEX_AUTO_CONTINUE_SETTING = 'paradis.agentChat.codexAutoContinueOnOverload';

/** 自動で続ける対象のエラーのコード。 */
export const PARADIS_CODEX_OVERLOAD_ERROR_CODE = 'server_overloaded';

/** 自動で送る文（言い換えない）。 */
export const PARADIS_CODEX_OVERLOAD_CONTINUE_TEXT = 'continue';

/** n 回目（0 起点）を送るまで待つ時間。長さが続けて送る回数の上限。 */
export const PARADIS_CODEX_OVERLOAD_RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000];

/** ウィンドウが送信を引き受ける（claim）まで待つ長さ。過ぎたら送れなかったとみなす。 */
const CLAIM_WAIT_MS = 15_000;

/** 送ったものとみなして、そのターンの結果を待つ長さ。これを過ぎても結果が来なければ数え直す。 */
const SENT_RESULT_WAIT_MS = 30 * 60_000;

/**
 * ウィンドウから shared process への知らせ: `claim` 送ってよいか（よければ送ったものとして数える）、`typed` 待つ間に
 * ペインへ打鍵があったので送らない、`draft` Codex の入力欄に書きかけの文がある、`unverified` 前面が Codex か・入力欄が
 * 空かを画面から確かめられない、`failed` 貼り付けられなかった。
 */
export type ParadisCodexAutoContinuePhase = 'claim' | 'typed' | 'draft' | 'unverified' | 'failed';

/** ウィンドウから受けてよい {@link ParadisCodexAutoContinuePhase}（IPC の値を確かめる）。 */
export const PARADIS_CODEX_AUTO_CONTINUE_PHASES: ReadonlySet<string> = new Set<ParadisCodexAutoContinuePhase>(['claim', 'typed', 'draft', 'unverified', 'failed']);

/** `ParadisCodexOverloadContinue` が外へ頼むこと。 */
export interface IParadisCodexOverloadContinueHost {
	/** 設定（`paradis.agentChat.codexAutoContinueOnOverload`）がオンか。 */
	isEnabled(): boolean;
	/** n 回目（0 起点）を送るまで待つ時間（{@link PARADIS_CODEX_OVERLOAD_RETRY_DELAYS_MS}。テストは短くする）。 */
	retryDelaysMs(): readonly number[];
	/** 会話に Para Code の知らせを 1 行足す（モバイルと PC の会話の両方に出る）。 */
	notice(token: string, text: string): void;
	/**
	 * ペインを持つウィンドウへ送信を頼む。ウィンドウは送る直前に {@link ParadisCodexOverloadContinue.claim} で
	 * まだ送ってよいかを確かめる。頼めなかったら false。
	 */
	requestSend(token: string, requestId: string, since: number): boolean;
	/** 自動で続けるのをやめた（送れなかった）ことをプッシュで知らせる。上限に達したときは普段のエラーの通知が出るので呼ばない。 */
	notifyStopped(token: string): void;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
}

interface IPaneState {
	/** このひと続きで自動で送った回数。 */
	sent: number;
	/** 待っている送信（無ければ送った後か、まだ予定が無い）。 */
	timer?: unknown;
	/** 待っている送信の印（ウィンドウが claim で出す）。 */
	requestId?: string;
	/** 失敗したターンが終わった時刻（ウィンドウは、これより後に打鍵があれば送らない）。 */
	failedAt: number;
	/** 送った時刻（結果を待っている）。 */
	sentAt?: number;
	/** 最後に送った送信の印（ウィンドウが貼り付けに失敗したと知らせてくるときに使う）。 */
	sentRequestId?: string;
	/** ウィンドウの引き受けを待つ時計。 */
	claimTimer?: unknown;
}

/** {@link ParadisCodexOverloadContinue} の知らせの文言。 */
export function paradisCodexOverloadWaitNotice(delayMs: number, attempt: number, limit: number): string {
	// allow-any-unicode-next-line
	return `モデルが混み合っていて止まりました。${Math.round(delayMs / 1000)} 秒後に自動で「${PARADIS_CODEX_OVERLOAD_CONTINUE_TEXT}」を送ります（${attempt}/${limit} 回目）`;
}

export function paradisCodexOverloadSentNotice(attempt: number, limit: number): string {
	// allow-any-unicode-next-line
	return `自動で「${PARADIS_CODEX_OVERLOAD_CONTINUE_TEXT}」を送りました（${attempt}/${limit} 回目）`;
}

export function paradisCodexOverloadGaveUpNotice(limit: number): string {
	// allow-any-unicode-next-line
	return `自動で ${limit} 回続けましたが、まだ混み合っています。障害の可能性があるので、自動で続けるのをやめました`;
}

export function paradisCodexOverloadCancelledNotice(): string {
	// allow-any-unicode-next-line
	return 'ほかの入力があったので、自動で続けるのをやめました';
}

export function paradisCodexOverloadDraftNotice(): string {
	// allow-any-unicode-next-line
	return 'Codex の入力欄に書きかけの文があるので、自動で続けるのをやめました';
}

export function paradisCodexOverloadUnverifiedNotice(): string {
	// allow-any-unicode-next-line
	return 'PC のターミナルで Codex の入力欄を確かめられなかったので、自動で続けるのをやめました';
}

export function paradisCodexOverloadSendFailedNotice(): string {
	// allow-any-unicode-next-line
	return 'PC のターミナルに送れなかったので、自動で続けるのをやめました';
}

let requestSeq = 0;

export class ParadisCodexOverloadContinue {
	private readonly panes = new Map<string, IPaneState>();
	private disposed = false;

	constructor(private readonly host: IParadisCodexOverloadContinueHost) { }

	/** 自動の送信を待っているか（このペインの失敗の通知を出さない）。 */
	isWaiting(token: string): boolean {
		return this.panes.get(token)?.timer !== undefined;
	}

	/**
	 * 本会話のターンが終わった（transcript のライブの追記で読んだもの）。混み合いの失敗なら送る予定を立て、それ以外なら
	 * ひと続きを終える。
	 */
	onTurnEnded(token: string, reason: 'completed' | 'failed' | 'interrupted', errorCode: string | undefined): void {
		if (this.disposed) {
			return;
		}
		const state = this.panes.get(token);
		if (reason !== 'failed' || errorCode !== PARADIS_CODEX_OVERLOAD_ERROR_CODE || !this.host.isEnabled()) {
			this.forget(token);
			return;
		}
		const now = this.host.now();
		// 前に送ったものの結果が来ないまま長く経っていたら、別のひと続きとして数え直す
		const sent = state !== undefined && (state.sentAt === undefined || now - state.sentAt <= SENT_RESULT_WAIT_MS) ? state.sent : 0;
		this.clearTimer(state);
		const delays = this.host.retryDelaysMs();
		const limit = delays.length;
		if (sent >= limit) {
			this.panes.delete(token);
			this.host.notice(token, paradisCodexOverloadGaveUpNotice(limit));
			return;
		}
		const delay = delays[sent];
		const requestId = `oc${++requestSeq}`;
		const next: IPaneState = { sent, failedAt: now, requestId };
		next.timer = this.host.setTimeout(() => this.fire(token, requestId), delay);
		this.panes.set(token, next);
		this.host.notice(token, paradisCodexOverloadWaitNotice(delay, sent + 1, limit));
	}

	/**
	 * 本会話のターンが始まった（transcript）。送る前（待っている間と、ウィンドウの引き受けを待つ間）なら、ユーザーが
	 * 送ったので取りやめる。
	 */
	onTurnStarted(token: string): void {
		const state = this.panes.get(token);
		if (state === undefined || (state.timer === undefined && (state.requestId === undefined || state.sentAt !== undefined))) {
			return; // 自動で送った continue のターン（またはひと続きの外）
		}
		this.panes.delete(token);
		this.clearTimer(state);
		this.host.notice(token, paradisCodexOverloadCancelledNotice());
	}

	/** ペイン・会話が終わった。黙って取りやめる。 */
	forget(token: string): void {
		const state = this.panes.get(token);
		if (state !== undefined) {
			this.clearTimer(state);
			this.panes.delete(token);
		}
	}

	/**
	 * ウィンドウが送る直前に呼ぶ。まだ送ってよければ true を返し、送ったものとして数える。
	 */
	claim(token: string, requestId: string): boolean {
		const state = this.panes.get(token);
		if (state === undefined || state.requestId !== requestId || state.timer !== undefined || state.sentAt !== undefined || !this.host.isEnabled()) {
			return false;
		}
		this.clearClaimTimer(state);
		state.sent++;
		state.sentAt = this.host.now();
		state.sentRequestId = requestId;
		state.requestId = undefined;
		this.host.notice(token, paradisCodexOverloadSentNotice(state.sent, this.host.retryDelaysMs().length));
		return true;
	}

	/** ウィンドウからの知らせ（{@link ParadisCodexAutoContinuePhase}）。`claim` だけが結果（送ってよいか）を返す。 */
	report(token: string, requestId: string, phase: ParadisCodexAutoContinuePhase): boolean {
		if (phase === 'claim') {
			return this.claim(token, requestId);
		}
		if (phase === 'typed') {
			const state = this.panes.get(token);
			if (state !== undefined && state.requestId === requestId) {
				this.panes.delete(token);
				this.clearTimer(state);
				this.host.notice(token, paradisCodexOverloadCancelledNotice());
			}
			return false;
		}
		this.sendFailed(token, requestId, phase === 'draft' ? paradisCodexOverloadDraftNotice() : phase === 'unverified' ? paradisCodexOverloadUnverifiedNotice() : paradisCodexOverloadSendFailedNotice());
		return false;
	}

	/** ウィンドウが送れなかった。`requestId` が今のものでなければ何もしない。会話とプッシュで知らせる。 */
	sendFailed(token: string, requestId: string, notice: string = paradisCodexOverloadSendFailedNotice()): void {
		const state = this.panes.get(token);
		if (state === undefined || (state.requestId !== requestId && state.sentRequestId !== requestId)) {
			return;
		}
		this.panes.delete(token);
		this.clearTimer(state);
		this.host.notice(token, notice);
		this.host.notifyStopped(token);
	}

	dispose(): void {
		this.disposed = true;
		for (const state of this.panes.values()) {
			this.clearTimer(state);
		}
		this.panes.clear();
	}

	private fire(token: string, requestId: string): void {
		const state = this.panes.get(token);
		if (state === undefined || state.requestId !== requestId) {
			return;
		}
		state.timer = undefined;
		if (!this.host.isEnabled()) {
			this.panes.delete(token);
			return;
		}
		if (!this.host.requestSend(token, requestId, state.failedAt)) {
			this.sendFailed(token, requestId);
			return;
		}
		state.claimTimer = this.host.setTimeout(() => {
			state.claimTimer = undefined;
			if (this.panes.get(token) === state && state.requestId === requestId) {
				this.sendFailed(token, requestId);
			}
		}, CLAIM_WAIT_MS);
	}

	private clearTimer(state: IPaneState | undefined): void {
		if (state?.timer !== undefined) {
			this.host.clearTimeout(state.timer);
			state.timer = undefined;
		}
		this.clearClaimTimer(state);
	}

	private clearClaimTimer(state: IPaneState | undefined): void {
		if (state?.claimTimer !== undefined) {
			this.host.clearTimeout(state.claimTimer);
			state.claimTimer = undefined;
		}
	}
}
