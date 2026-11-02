/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisRedactTextSecrets } from '../../../common/paradisSecretRedaction.js';
import { paradisJoinTruncatedMiddle, paradisNormalizeCommandOutput, paradisTruncateMiddle, paradisTruncateMiddleSplit } from './paradisMobileScmSync.js';

/**
 * コマンドの出力（コミットのフック・git の push・CI のログ）から秘密らしい値を伏せる（Orca W2-15 / W2-36）。
 * スマホの画面に出し、エージェントへの依頼文にも載せるため。
 *
 * 色の制御文字と改行の形を揃えてから、PC の通知・受信箱と同じ `paradisRedactTextSecrets` で伏せる
 * （複数行の PEM・URL の資格情報・`AccountKey=`・Slack の Webhook と、既知の形のトークン・`KEY=値`・Bearer など）。
 * 形の決まっていない秘密は拾えない（見落としはありうる）。
 */
export function paradisRedactMobileCommandOutput(raw: string): string {
	return paradisRedactTextSecrets(paradisNormalizeCommandOutput(raw));
}

/**
 * 伏せる前に切る余白。切り目で割れた秘密が、捨てる余白の中に収まる長さにする（4096 ビットの RSA の秘密鍵の PEM が 3,300 字ほど）。
 */
const TRUNCATE_BEFORE_REDACT_MARGIN = 4_096;

/**
 * 長い出力を、先頭と末尾を残して `limit` 字に切ってから伏せ字を当てる（形は `paradisTruncateMiddle` と同じ）。
 * 先に切るのは、伏せる時間を出力の長さでなく `limit` で決めるため。先頭と末尾は余白を付けて切ってから伏せ、
 * 余白を捨てるので、切り目で割れた秘密の断片は残さない。
 */
export function paradisRedactMobileCommandOutputWithin(raw: string, limit: number): string {
	if (raw.length <= limit + 2 * TRUNCATE_BEFORE_REDACT_MARGIN) {
		return paradisTruncateMiddle(paradisRedactMobileCommandOutput(raw), limit);
	}
	const { head, tail } = paradisTruncateMiddleSplit(limit);
	const redactedHead = paradisRedactMobileCommandOutput(raw.slice(0, head + TRUNCATE_BEFORE_REDACT_MARGIN)).slice(0, head);
	const redactedTail = paradisRedactMobileCommandOutput(raw.slice(raw.length - tail - TRUNCATE_BEFORE_REDACT_MARGIN));
	return paradisJoinTruncatedMiddle(redactedHead, raw.length - limit, redactedTail.slice(Math.max(0, redactedTail.length - tail)));
}

/**
 * 応答の `error` に伏せ字を当てる（設計書 4 章の着手順 3）。scm・fs の応答の出口（`reply` の手前）で一律に通す。
 * 例外の文や git の stderr には remote の URL の資格情報・フックの環境変数が混ざりうるため。
 *
 * 当てるのは文字列の `error` だけ。ファイルの本文・差分・コードなど他の項目には触らない（正当な中身を置き換えない）。
 */
export function paradisRedactMobileReplyError<T extends object>(body: T): T {
	const error = (body as { readonly error?: unknown }).error;
	if (typeof error !== 'string' || error.length === 0) {
		return body;
	}
	const redacted = paradisRedactMobileCommandOutput(error);
	return redacted === error ? body : { ...body, error: redacted };
}
