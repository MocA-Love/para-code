/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisRedactSecrets } from '../../notificationInbox/common/paradisNotificationInbox.js';
import { paradisNormalizeCommandOutput } from './paradisMobileScmSync.js';

/**
 * コマンドの出力（コミットのフック・git の push・CI のログ）から秘密らしい値を伏せる（Orca W2-15 / W2-36）。
 * スマホの画面に出し、エージェントへの依頼文にも載せるため。
 *
 * 伏せ方の本体は通知の本文と同じ `paradisRedactSecrets`（既知の形のトークン・`KEY=値`・Bearer など）。
 * あちらは1行に畳まれた文を前提にしているので、ここで次の2つを足す。
 * - 複数行の PEM の秘密鍵は、BEGIN から END までを丸ごと伏せる（1行ずつ見ると鍵の本文の行が残る）
 * - URL に埋め込まれた資格情報（`https://user:token@host`）の `user:token` を伏せる（git の remote の表記に出る）
 * - Azure の接続文字列の `AccountKey=` など、Slack の Incoming Webhook の URL
 * 形の決まっていない秘密は拾えない（見落としはありうる）。
 */
export function paradisRedactMobileCommandOutput(raw: string): string {
	const normalized = paradisNormalizeCommandOutput(raw)
		.replace(/-----BEGIN (?<kind>[A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '-----BEGIN $<kind>PRIVATE KEY----- ***')
		.replace(/(?<scheme>[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$<scheme>***@')
		// Azure の接続文字列（`AccountKey=…;`・`SharedAccessKey=…`・SAS の `sig=…`）
		.replace(/\b(?<name>AccountKey|SharedAccessKey|SharedAccessSignature|sig)=(?<value>[^;&\s"']+)/gi, '$<name>=***')
		// Slack の Incoming Webhook（URL そのものが資格情報）
		.replace(/https:\/\/hooks\.slack(?:-gov)?\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g, 'https://hooks.slack.com/***');
	return normalized.split('\n').map(line => paradisRedactSecrets(line)).join('\n');
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
