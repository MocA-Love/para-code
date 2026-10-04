/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments and messages)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コンテキストの圧縮（compaction）を会話の行にする純粋な関数（モバイルの区切り線と要約のカード、デスクトップの知らせの行）。
//
// - Claude Code（2.1.287〜2.1.289 の実データ）: `system/compact_boundary` の行に `compactMetadata`（trigger・preTokens・
//   postTokens）が付き、その直後の `user` の行（`isCompactSummary: true`）が要約の本文。手動の `/compact` は、その前に
//   `user` の `/compact` の行、後に `<command-name>/compact</command-name>` と `Compacted (ctrl+o to see full summary)` の出力が
//   続く（この 2 つはパーサーが出さない）
// - Codex（0.160.0 の実データ）: rollout の `compacted` の行（本文の要約は空。`replacement_history` に圧縮後の履歴）。
//   `event_msg` の `item_completed`（`ContextCompaction`）は、手元の 3,000 本の rollout で必ず `compacted` の直後に
//   対になって書かれていた（513 / 513）ので、区切りは `compacted` だけから作る（二重に出さない）。トークン数は無い
//
// 区切りと要約は `notice: true` の行にする。新しいアプリは `noticeSource` で区切り線と畳んだカードに描き分け、
// 古いアプリは灰色の 1 行として出す（6,000 字の利用者の吹き出しにはしない）。

import { IParadisAgentCompactionInfo } from './paradisAgentChat.js';

/** 要約のカードに送る先頭の文字数（全文は 'tool-full' で取り寄せる）。古いアプリはこの長さの灰色の行で出す。 */
export const PARADIS_COMPACT_SUMMARY_PREVIEW_LIMIT = 600;

/** 要約の冒頭に Claude Code が付ける定型文（どの要約にも同じ文が付くので表示からは外す）。 */
const SUMMARY_PREAMBLE = /^This session is being continued from a previous conversation[^\n]*\n+(?:Summary:\s*\n+)?/;

function tokenCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** 区切りの行の文（古いアプリとデスクトップの知らせの行に出す）。 */
export function paradisCompactionNoticeText(info: IParadisAgentCompactionInfo): string {
	const trigger = info.trigger === 'manual' ? '（手動）' : info.trigger === 'auto' ? '（自動）' : '';
	const tokens = info.tokensBefore !== undefined && info.tokensAfter !== undefined
		? ` ${info.tokensBefore.toLocaleString('en-US')} → ${info.tokensAfter.toLocaleString('en-US')} トークン`
		: '';
	return `コンテキストを圧縮しました${trigger}${tokens}`;
}

/** Claude Code の `compactMetadata` から、区切りに添える項目を取る（取れたものだけ）。 */
export function paradisClaudeCompactionInfo(metadata: unknown): IParadisAgentCompactionInfo {
	const record = typeof metadata === 'object' && metadata !== null ? metadata as { trigger?: unknown; preTokens?: unknown; postTokens?: unknown } : undefined;
	const trigger = record?.trigger === 'manual' || record?.trigger === 'auto' ? record.trigger : undefined;
	const tokensBefore = tokenCount(record?.preTokens);
	const tokensAfter = tokenCount(record?.postTokens);
	return {
		...(trigger !== undefined ? { trigger } : {}),
		...(tokensBefore !== undefined && tokensAfter !== undefined ? { tokensBefore, tokensAfter } : {}),
	};
}

/** 要約の本文（冒頭の定型文を外したもの）と、その文字数。空なら undefined。 */
export function paradisCompactSummaryBody(raw: string): { readonly body: string; readonly chars: number } | undefined {
	const full = raw.trim();
	if (full.length === 0) {
		return undefined;
	}
	const body = full.replace(SUMMARY_PREAMBLE, '').trim() || full;
	return { body, chars: body.length };
}
