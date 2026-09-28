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
