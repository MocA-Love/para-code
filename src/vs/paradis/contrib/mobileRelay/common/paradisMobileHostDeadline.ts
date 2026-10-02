/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';

/**
 * モバイルの要求で、作業ツリーがあるマシン（SSH の接続先を含む）の channel を呼ぶときの待ち時間の上限。
 *
 * `channel.call` 自体には上限が無いので、接続先が返さなければ PC はモバイルへ何も返さず、アプリは自分の
 * timeout まで「読み込み中」のまま待つ。アプリの timeout より短い上限で打ち切り、「接続先が応答しません」を
 * PC から返す。打ち切っても呼び出しは取り消さない（遅れて返った結果は捨てる）。
 */

/** 打ち切ったときにモバイルへ返す文。 */
export const PARADIS_MOBILE_HOST_NO_RESPONSE_MESSAGE = '接続先が応答しません。しばらくしてから読み直してください。';

/**
 * `getPullRequestDetail` の上限。アプリは 60 秒で諦めるので、それより前に返す。接続先側の上限
 * （git 30 秒 + gh 15 秒）を使い切ったときの応答も受け取れるよう、45 秒より少し長くする。
 */
export const PARADIS_MOBILE_PR_LOOKUP_DEADLINE_MS = 50_000;

/** scm `status` の必須の部分（一覧・ブランチ名・行数・未追跡の大きさ）の上限（アプリは 30 秒で諦める）。 */
export const PARADIS_MOBILE_STATUS_DEADLINE_MS = 20_000;

/** 必須の部分が揃ってから、上流との先行・遅れ（任意）を待つ上限。 */
export const PARADIS_MOBILE_STATUS_OPTIONAL_GRACE_MS = 3_000;

/**
 * 使用量（`usage`・`rtk`・`limits`・`github`）の上限。アプリは 60 秒で諦めるので、それより前に返す。
 * ccusage はログが多いと1回に数分かかる。打ち切っても裏の実行は止めないので、終わればキャッシュに入り、
 * 次の問い合わせはすぐ返る。
 */
export const PARADIS_MOBILE_USAGE_DEADLINE_MS = 50_000;

/** 打ち切ったときの応答の `code`（アプリは見出しを「接続先が応答していません」にする）。 */
export const PARADIS_MOBILE_HOST_NO_RESPONSE_CODE = 'no-response';

/** 接続先が上限までに返さなかった。 */
export class ParadisMobileHostNoResponseError extends Error {
	constructor(readonly timeoutMs: number) {
		super(PARADIS_MOBILE_HOST_NO_RESPONSE_MESSAGE);
		this.name = 'ParadisMobileHostNoResponseError';
	}
}

export function paradisIsMobileHostNoResponse(error: unknown): error is ParadisMobileHostNoResponseError {
	return error instanceof ParadisMobileHostNoResponseError;
}

/**
 * `promise` を `timeoutMs` まで待つ。間に合わなければ {@link ParadisMobileHostNoResponseError} で reject する。
 * `promise` の失敗はそのまま伝える。
 */
export function paradisWithHostDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new ParadisMobileHostNoResponseError(timeoutMs)), timeoutMs);
		promise.then(value => {
			clearTimeout(timer);
			resolve(value);
		}, error => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

/** 任意の項目を `timeoutMs` まで待つ。間に合わない・失敗したときは undefined（その項目を省いて返すため）。 */
export function paradisSettleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return paradisWithHostDeadline(promise, timeoutMs).catch(() => undefined);
}

/** 使用量の問い合わせを打ち切ったときにモバイルへ返す文（usage・rtk・limits・github で共通）。 */
export function paradisMobileUsageNoResponseMessage(): string {
	return localize('paradis.mobile.usageNoResponse', "応答に時間がかかっています。PC で取得を続けているので、しばらくしてから読み直してください。");
}

/**
 * 使用量（`usage`・`rtk`・`limits`・`github`）の失敗の応答。{@link PARADIS_MOBILE_USAGE_DEADLINE_MS} の打ち切りは
 * `code: 'no-response'` を付けて返す（アプリは「応答なし」として前回の値を残せる）。それ以外はエラーの文をそのまま返す。
 */
export function paradisMobileUsageErrorReply(error: unknown): { readonly error: string; readonly code?: typeof PARADIS_MOBILE_HOST_NO_RESPONSE_CODE } {
	return paradisIsMobileHostNoResponse(error)
		? { error: paradisMobileUsageNoResponseMessage(), code: PARADIS_MOBILE_HOST_NO_RESPONSE_CODE }
		: { error: String(error) };
}
