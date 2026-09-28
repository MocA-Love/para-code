/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 終了処理の後始末に名前を付けて時間を測る（W2-26）。
//
// 常駐ターミナルを有効にした環境で終了に数分かかることがあり、どの後始末で止まっているかを
// 後から追えるようにするのが目的。**計測だけ**で、期限は足さない。各ステップが元から持っている
// 上限（`raceTimeout`）はそのまま使い、その上限で打ち切られたかどうかも記録する。
//
// 遅いものだけをログの warn と Sentry（`quit-teardown` / `slow:<ステップ名>`）へ出す。Sentry の
// 指紋は実質 operation だけで決まるので、ステップ名は operation に入れる（extra に入れると全ステップが
// 1つの「10分3件」の枠を取り合う）。ユーザーの返事を待つステップ（ダイアログ）は、遅くても
// 後始末の問題ではないので、ログに残すだけで Sentry へは出さない。

import { raceTimeout } from '../../../../base/common/async.js';
import { reportParadisDiagnosticError } from './paradisSentryDiagnostics.js';

/** これ以上かかったステップを「遅い」とみなす。fork の後始末の上限は 0.5〜5 秒なので、その手前に置く。 */
export const PARADIS_TEARDOWN_SLOW_MS = 1_000;

export type ParadisTeardownOutcome = 'settled' | 'failed' | 'timed-out';

export interface IParadisTeardownStepRecord {
	/** ステップ名。`<feature>.<step>` の形で、パスや利用者の内容を含めないこと。 */
	readonly step: string;
	readonly durationMs: number;
	readonly outcome: ParadisTeardownOutcome;
	/** ステップが元から持っている上限（この計測が足したものではない）。 */
	readonly boundMs?: number;
	/** ユーザーの返事を待つステップか。遅くても Sentry へは出さない。 */
	readonly waitsForUser?: boolean;
}

/** ログの出し先。プロセスごとに ILogService か console を渡す。 */
export interface IParadisTeardownLog {
	trace(message: string): void;
	warn(message: string): void;
}

export interface IParadisTeardownStepOptions {
	readonly log: IParadisTeardownLog;
	/** ユーザーの返事を待つステップ。 */
	readonly waitsForUser?: boolean;
	/** 上限で打ち切られたときに呼ぶ（`raceTimeout` の第3引数と同じ）。境界付きの計測でだけ使う。 */
	readonly onTimeout?: () => void;
	/** テスト用。既定は `Date.now`。 */
	readonly now?: () => number;
	/** テスト用。既定は Sentry への報告。 */
	readonly report?: (record: IParadisTeardownStepRecord) => void;
}

/** 記録を「遅い」として扱うか。打ち切り・失敗は所要時間にかかわらず遅い側に数える。 */
export function paradisIsSlowTeardownStep(record: IParadisTeardownStepRecord): boolean {
	return record.outcome !== 'settled' || record.durationMs >= PARADIS_TEARDOWN_SLOW_MS;
}

/** ログの1行。ステップ名と所要時間と結果だけを書く。 */
export function paradisDescribeTeardownStep(record: IParadisTeardownStepRecord): string {
	const bound = record.boundMs !== undefined ? ` (bound ${record.boundMs}ms)` : '';
	const user = record.waitsForUser ? ' (waited for the user)' : '';
	return `[paradisTeardown] ${record.step}: ${record.outcome} after ${record.durationMs}ms${bound}${user}`;
}

/** 遅いステップを Sentry へ送る。既定の `report`。 */
export function paradisReportSlowTeardownStep(record: IParadisTeardownStepRecord): void {
	reportParadisDiagnosticError('owned', 'quit-teardown', `slow:${record.step}`, undefined, {
		safe_duration_ms: record.durationMs,
		safe_outcome: record.outcome,
		...(record.boundMs !== undefined ? { safe_bound_ms: record.boundMs } : {}),
	}, 'warning');
}

/**
 * 記録を出す。全ステップを trace に、遅いものは warn に書き、ユーザー待ちでなければ Sentry へ送る。
 * 計測の失敗で終了処理を壊さないよう、ここからは投げない。
 */
export function paradisRecordTeardownStep(record: IParadisTeardownStepRecord, options: Pick<IParadisTeardownStepOptions, 'log' | 'report'>): boolean {
	const slow = paradisIsSlowTeardownStep(record);
	try {
		const line = paradisDescribeTeardownStep(record);
		if (slow) {
			options.log.warn(line);
		} else {
			options.log.trace(line);
		}
		if (slow && !record.waitsForUser) {
			(options.report ?? paradisReportSlowTeardownStep)(record);
		}
	} catch {
		/* 計測は終了を止めない */
	}
	return slow;
}

/**
 * 後始末 1 つを測る。結果と例外はそのまま返す（計測で振る舞いを変えない）。
 */
export async function paradisTimeTeardownStep<T>(step: string, work: Promise<T>, options: IParadisTeardownStepOptions): Promise<T> {
	const now = options.now ?? Date.now;
	const startedAt = now();
	let outcome: ParadisTeardownOutcome = 'settled';
	try {
		return await work;
	} catch (error) {
		outcome = 'failed';
		throw error;
	} finally {
		paradisRecordTeardownStep({ step, durationMs: now() - startedAt, outcome, waitsForUser: options.waitsForUser }, options);
	}
}

/**
 * 元から上限を持つ後始末を測る。`raceTimeout(work, boundMs)` と同じ振る舞いで、上限で打ち切られたら
 * `timed-out` として記録する。上限はこの関数が足すものではなく、呼び出し側が以前から持っていたもの。
 */
export async function paradisTimeBoundedTeardownStep<T>(step: string, work: Promise<T>, boundMs: number, options: IParadisTeardownStepOptions): Promise<T | undefined> {
	const now = options.now ?? Date.now;
	const startedAt = now();
	let outcome: ParadisTeardownOutcome = 'settled';
	try {
		return await raceTimeout(work, boundMs, () => {
			outcome = 'timed-out';
			options.onTimeout?.();
		});
	} catch (error) {
		outcome = 'failed';
		throw error;
	} finally {
		paradisRecordTeardownStep({ step, durationMs: now() - startedAt, outcome, boundMs, waitsForUser: options.waitsForUser }, options);
	}
}
