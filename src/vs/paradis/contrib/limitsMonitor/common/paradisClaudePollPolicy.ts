/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from claude-swap (MIT, Copyright (c) 2026 Onur Cetinkol): claude_swap/poll_policy.py, claude_swap/usage_store.py

// Claude の使用量 API（`/api/oauth/usage`）を叩く間隔の決め方。数値はすべてここに置く。
//
// この API は Anthropic 純正以外のクライアントに対して「直近 1 時間に約 28〜30 回」の上限があり、
// 超えると最大 1 時間止められる（claude-swap の実測、2026-07-11）。上限は時間が経って古い呼び出しが
// 窓から抜けるまで戻らないので、一度に使い切ると 1 時間まるごと取れなくなる。
// そのため平均で 3 分に 1 回以下（1 時間に 20 回）に抑え、残りを手動更新や復帰直後の取り直しに回す。
//
// 決め方（設問 Q8 の決定）:
//  - 取得結果は 180 秒キャッシュして配る。どれだけ多くのウィンドウが見ていても、
//    1 アカウントあたり 180 秒に 1 回を超えて呼ばない
//  - 通常は利用の変化で 3〜10 分: 使用率が動いていれば間隔を半分（下限 3 分）、
//    動いていなければ 1.5 倍（使用中のアカウントは 5 分、控えは 10 分まで）
//  - 使用中のアカウントが上限の近くで動いている間だけ 1 分（緊急）
//  - 使い切ったアカウントも 10 分ごとには見る（予告より早く枠が戻ることがあるため）
//  - HTTP 429: Retry-After があればそれに余裕を足して待つ。無ければ 5 分待ってから試す。
//    429 を受けてから 1 時間は、成功しても間隔を 6 分以上に保ち、成功のたびに 1.5 倍して
//    最大 30 分まで伸ばす（複数の PC が同じアカウントを見ていても自然に分け合うため）。
//    1 時間 429 が出なければ通常の間隔に戻る
//  - 予定時刻は窓がリセットされる時刻 + 60 秒より後にしない（リセット後の値は古いので）

/** これより新しい取得結果はそのまま配る（API を呼ばない）。 */
export const PARADIS_CLAUDE_SERVE_TTL_S = 180;
/** 通常の間隔の下限。 */
export const PARADIS_CLAUDE_MIN_INTERVAL_S = 180;
/** 使用中のアカウントが上限の近くで動いている間の間隔。 */
export const PARADIS_CLAUDE_URGENT_INTERVAL_S = 60;
/** 使用中のアカウントが動いていないときの上限。 */
export const PARADIS_CLAUDE_ACTIVE_MAX_INTERVAL_S = 300;
/** 控えのアカウントの既定と上限。 */
export const PARADIS_CLAUDE_CANDIDATE_DEFAULT_INTERVAL_S = 300;
export const PARADIS_CLAUDE_CANDIDATE_MAX_INTERVAL_S = 600;
/** 使い切ったアカウントの間隔。 */
export const PARADIS_CLAUDE_EXHAUSTED_INTERVAL_S = 600;
/** 前回からこれ以上使用率が動いたら「使われている」とみなす。 */
export const PARADIS_CLAUDE_MOVEMENT_DELTA_PCT = 1;
/** 予定時刻に足す揺らぎ（±割合）。複数のプロセスが同じ瞬間に取りに行かないように。 */
export const PARADIS_CLAUDE_JITTER_FRAC = 0.1;
/** Retry-After が 0 か無いときの 429 の待ち時間。 */
export const PARADIS_CLAUDE_EDGE_BACKOFF_S = 300;
/** 429 を受けてからしばらくの間の間隔の下限。 */
export const PARADIS_CLAUDE_POST_429_MIN_INTERVAL_S = 360;
/** 「最近 429 を受けた」とみなす長さ（上限の窓が抜けきる 1 時間）。 */
export const PARADIS_CLAUDE_RECENT_429_WINDOW_S = 3600;
/** 429 が続く間に成功するたび間隔に掛ける倍率と、その上限。 */
export const PARADIS_CLAUDE_POST_429_BACKOFF_MULT = 1.5;
export const PARADIS_CLAUDE_POST_429_MAX_INTERVAL_S = 1800;
/** 上限（100%）からこの幅に入ったら緊急の間隔を使う。 */
export const PARADIS_CLAUDE_ESCALATION_MARGIN_PCT = 15;
/** 予定時刻は窓のリセット + この秒数より後にしない。 */
export const PARADIS_CLAUDE_RESET_SLACK_S = 60;
/** 1 時間規模の Retry-After に足す余裕。期限ちょうどに試すと再びブロックされることが多い（cswap の実測）。 */
export const PARADIS_CLAUDE_RETRY_AFTER_MARGIN_S = 900;
/** 余裕を足すのは Retry-After がこれより長いときだけ（短い指定は正確だった、という cswap の実測）。 */
export const PARADIS_CLAUDE_RETRY_AFTER_MARGIN_THRESHOLD_S = 600;
/** Retry-After（＋余裕）で待つ長さの上限。壊れた値で何時間も止まらないように。 */
export const PARADIS_CLAUDE_RETRY_AFTER_CAP_S = 4500;
/** 429 以外の失敗の待ち時間（30 秒から倍々、10 分まで）。 */
export const PARADIS_CLAUDE_FAILURE_BACKOFF_BASE_S = 30;
export const PARADIS_CLAUDE_FAILURE_BACKOFF_CAP_S = 600;

/** 間隔の判断に使う 1 つの窓。 */
export interface IParadisClaudePolicyWindow {
	readonly usedPercent: number;
	/** epoch ms。 */
	readonly resetsAt?: number;
}

/** 間隔の判断に使うアカウントの使用状況（5 時間枠・7 日枠）。モデル別枠は判断に入れない。 */
export interface IParadisClaudePolicyUsage {
	readonly fiveHour?: IParadisClaudePolicyWindow;
	readonly sevenDay?: IParadisClaudePolicyWindow;
}

export interface IParadisClaudePollPlan {
	/** 次に取りに行く時刻（epoch ms）。 */
	readonly nextPollAt: number;
	/** 次回の計算の基準にする間隔（秒）。 */
	readonly intervalS: number;
}

function paradisClaudeWindows(usage: IParadisClaudePolicyUsage | undefined): IParadisClaudePolicyWindow[] {
	const windows: IParadisClaudePolicyWindow[] = [];
	if (usage?.fiveHour && Number.isFinite(usage.fiveHour.usedPercent)) {
		windows.push(usage.fiveHour);
	}
	if (usage?.sevenDay && Number.isFinite(usage.sevenDay.usedPercent)) {
		windows.push(usage.sevenDay);
	}
	return windows;
}

/** いちばん逼迫している窓の使用率。窓が無ければ undefined。 */
export function paradisClaudeBindingPercent(usage: IParadisClaudePolicyUsage | undefined): number | undefined {
	const windows = paradisClaudeWindows(usage);
	return windows.length > 0 ? Math.max(...windows.map(window => window.usedPercent)) : undefined;
}

function paradisClaudeLimitingResetAt(usage: IParadisClaudePolicyUsage | undefined): number | undefined {
	let latest: number | undefined;
	for (const window of paradisClaudeWindows(usage)) {
		if (window.usedPercent >= 100 && window.resetsAt !== undefined && (latest === undefined || window.resetsAt > latest)) {
			latest = window.resetsAt;
		}
	}
	return latest;
}

function paradisClaudeEarliestFutureResetAt(usage: IParadisClaudePolicyUsage | undefined, now: number): number | undefined {
	let earliest: number | undefined;
	for (const window of paradisClaudeWindows(usage)) {
		if (window.resetsAt !== undefined && window.resetsAt > now && (earliest === undefined || window.resetsAt < earliest)) {
			earliest = window.resetsAt;
		}
	}
	return earliest;
}

export interface IParadisClaudePlanAfterFetchInput {
	readonly previousIntervalS: number | undefined;
	readonly previousUsage: IParadisClaudePolicyUsage | undefined;
	readonly newUsage: IParadisClaudePolicyUsage | undefined;
	/** いま PC で使われているアカウントか。 */
	readonly isActive: boolean;
	/** 直近 {@link PARADIS_CLAUDE_RECENT_429_WINDOW_S} 秒以内に 429 を受けたか。 */
	readonly recent429: boolean;
	/** epoch ms。 */
	readonly now: number;
	/** 0 以上 1 未満の乱数（テストで固定する）。 */
	readonly random: () => number;
}

/**
 * 取得に成功した直後に、次に取りに行く時刻を決める（cswap の `plan_after_fetch`）。
 */
export function paradisClaudePlanAfterFetch(input: IParadisClaudePlanAfterFetchInput): IParadisClaudePollPlan {
	const defaultInterval = input.isActive ? PARADIS_CLAUDE_MIN_INTERVAL_S : PARADIS_CLAUDE_CANDIDATE_DEFAULT_INTERVAL_S;
	const ceiling = input.isActive ? PARADIS_CLAUDE_ACTIVE_MAX_INTERVAL_S : PARADIS_CLAUDE_CANDIDATE_MAX_INTERVAL_S;
	const base = input.previousIntervalS || defaultInterval;
	const previousPercent = paradisClaudeBindingPercent(input.previousUsage);
	const newPercent = paradisClaudeBindingPercent(input.newUsage);

	let moving = false;
	let interval: number;
	if (previousPercent === undefined || newPercent === undefined) {
		interval = defaultInterval;
	} else if (Math.abs(newPercent - previousPercent) >= PARADIS_CLAUDE_MOVEMENT_DELTA_PCT) {
		moving = true;
		interval = Math.max(PARADIS_CLAUDE_MIN_INTERVAL_S, base / 2);
	} else {
		// 下限で丸めるのは、緊急の 60 秒から 90 秒・135 秒…と刻まずに通常の間隔へ戻すため。
		interval = Math.min(ceiling, Math.max(PARADIS_CLAUDE_MIN_INTERVAL_S, base * 1.5));
	}
	if (input.isActive && moving && !input.recent429 && newPercent !== undefined && newPercent >= 100 - PARADIS_CLAUDE_ESCALATION_MARGIN_PCT) {
		interval = PARADIS_CLAUDE_URGENT_INTERVAL_S;
	}
	if (input.recent429) {
		const increased = Math.max(base * PARADIS_CLAUDE_POST_429_BACKOFF_MULT, PARADIS_CLAUDE_POST_429_MIN_INTERVAL_S);
		interval = Math.min(PARADIS_CLAUDE_POST_429_MAX_INTERVAL_S, Math.max(interval, increased));
	}

	const exhausted = newPercent !== undefined && newPercent >= 100;
	if (exhausted) {
		interval = Math.max(interval, PARADIS_CLAUDE_EXHAUSTED_INTERVAL_S);
	}

	let nextPollAt = input.now + interval * 1000 * (1 + PARADIS_CLAUDE_JITTER_FRAC * (2 * input.random() - 1));
	const resetAt = exhausted
		? paradisClaudeLimitingResetAt(input.newUsage)
		: paradisClaudeEarliestFutureResetAt(input.newUsage, input.now);
	if (resetAt !== undefined && resetAt > input.now) {
		nextPollAt = Math.min(nextPollAt, resetAt + PARADIS_CLAUDE_RESET_SLACK_S * 1000);
	}
	return { nextPollAt, intervalS: interval };
}

/**
 * 取得に失敗したとき、次に試すまで待つ秒数（cswap の `_failure_backoff_s`）。
 *
 * @param consecutiveFailures 今回を含む連続失敗回数（1 以上）。
 * @param retryAfterS サーバーが返した Retry-After（秒）。無ければ undefined。
 * @param rateLimited 429 か。Retry-After: 0 と余裕の扱いは 429 のときだけ変える。
 */
export function paradisClaudeFailureBackoffS(consecutiveFailures: number, retryAfterS: number | undefined, rateLimited: boolean): number {
	const shift = Math.min(Math.max(0, consecutiveFailures - 1), 32);
	const computed = Math.min(PARADIS_CLAUDE_FAILURE_BACKOFF_BASE_S * Math.pow(2, shift), PARADIS_CLAUDE_FAILURE_BACKOFF_CAP_S);
	if (retryAfterS === undefined || !Number.isFinite(retryAfterS) || retryAfterS < 0) {
		// 429 なのに Retry-After が無いときは、上限の縁に居るものとして少なくとも 5 分待つ。
		return rateLimited ? Math.max(computed, PARADIS_CLAUDE_EDGE_BACKOFF_S) : computed;
	}
	if (retryAfterS === 0) {
		return rateLimited ? Math.min(Math.max(computed, PARADIS_CLAUDE_EDGE_BACKOFF_S), PARADIS_CLAUDE_FAILURE_BACKOFF_CAP_S) : computed;
	}
	let asked = retryAfterS;
	if (rateLimited && retryAfterS > PARADIS_CLAUDE_RETRY_AFTER_MARGIN_THRESHOLD_S) {
		asked = retryAfterS + PARADIS_CLAUDE_RETRY_AFTER_MARGIN_S;
	}
	asked = Math.min(asked, PARADIS_CLAUDE_RETRY_AFTER_CAP_S);
	return Math.max(asked, computed);
}

/**
 * 429 を「最近受けた」か。
 *
 * 起点は 429 を受けた時刻ではなく、その待ち（backoff）が明ける時刻にする。1 時間規模の
 * Retry-After を待っている間は試さないので、429 を受けた時刻から数えると、明けた直後の最初の
 * 成功の時点で既に 1 時間が過ぎていて、間隔を広げる仕組みが働かなくなるため（cswap の `recent_429`）。
 */
export function paradisClaudeRecent429(last429At: number | undefined, backoffUntil: number | undefined, now: number): boolean {
	if (last429At === undefined) {
		return false;
	}
	const anchor = backoffUntil !== undefined && backoffUntil > last429At ? backoffUntil : last429At;
	return now - anchor < PARADIS_CLAUDE_RECENT_429_WINDOW_S * 1000;
}
