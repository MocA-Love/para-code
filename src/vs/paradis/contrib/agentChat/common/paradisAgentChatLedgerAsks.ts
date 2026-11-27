/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「聞く・答える」の台帳（humanAsk）の問いのうち、そのペインのチャット表示の会話の流れに出すもの。

import { IParadisHumanAskEntry } from '../../humanAsk/common/paradisHumanAsk.js';
import { paradisInboxPaneKey } from '../../notificationInbox/common/paradisNotificationInbox.js';

/**
 * そのペイン（トークン）のチャット表示に出す台帳の問い（古い順）。`lingering` は、待っている間に出していて答えられた
 * ・取り下げになったもの（{@link PARADIS_AGENT_CHAT_LEDGER_LINGER_MS} の間「回答済み」として同じ位置に残す）。
 *
 * - 出すのはボード・Bot（`ask_human` も Bot・ボードの出どころで入る）の問い。ペインの出どころの質問・許可は、チャット表示が
 *   会話の記録と画面から自前のカードを出すので出さない
 * - 許可（ツールの承認）は出さない（チャット表示の許可のカードのまま）
 * - 待っているものだけ。どこかで答えられたら台帳が回答済みにするので、ここからも消える
 * - ペインが自分の質問を待っている間は出さない（同じペインの同じ待ちはボード・Bot の 1 件に寄せられるので、二重になる）
 */
export function paradisAgentChatLedgerAsks(entries: readonly IParadisHumanAskEntry[], token: string, paneWaitsForQuestion: boolean, lingering: ReadonlySet<string> = new Set()): IParadisHumanAskEntry[] {
	if (paneWaitsForQuestion) {
		return [];
	}
	const paneKey = paradisInboxPaneKey(token);
	return entries
		.filter(entry => entry.paneKey === paneKey && (entry.state === 'waiting' || lingering.has(entry.key)) && entry.source !== 'pane' && entry.kind !== 'permission' && entry.foldedInto === undefined)
		.sort((a, b) => a.askedAt - b.askedAt);
}

/** 答えられた・取り下げになったカードを「回答済み」として残す時間（受信箱と同じ）。その間は後ろのカードが上がってこない。 */
export const PARADIS_AGENT_CHAT_LEDGER_LINGER_MS = 4_000;
/** カードが出た・並びが動いた・自動で末尾へスクロールした直後に、答えを送るボタンを効かせない時間（受信箱と同じ）。 */
export const PARADIS_AGENT_CHAT_LEDGER_SHIFT_GUARD_MS = 600;
