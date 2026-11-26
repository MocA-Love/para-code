/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { IParadisAgentMessageUsage } from './paradisAgentChat.js';

/**
 * 発言の下に出す小さい時刻。今日の発言は「10:02」、それより前は「11/26 23:21」、前の年は「2025/11/26 23:21」。
 * どちらも端末のタイムゾーンで数える。
 */
export function paradisAgentChatTimeLabel(ts: number, now: number): string {
	const date = new Date(ts);
	const today = new Date(now);
	const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
	const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
	if (sameDay) {
		return time;
	}
	const day = `${date.getMonth() + 1}/${date.getDate()} ${time}`;
	return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()}/${day}`;
}

/** 3 桁ごとに区切った数（端末の言語に左右されないよう自分で区切る）。 */
function groupDigits(value: number): string {
	return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 発言の下の小さい行の使用量（「claude-opus-4-5 / 入力 19,659 出力 581」）。モデルが分からなければ数だけ。 */
export function paradisAgentChatUsageLabel(usage: IParadisAgentMessageUsage): string {
	const tokens = localize('paradisAgentChat.usageTokens', "入力 {0} 出力 {1}", groupDigits(usage.inputTokens), groupDigits(usage.outputTokens));
	return usage.model !== undefined && usage.model.length > 0
		? localize('paradisAgentChat.usageWithModel', "{0} / {1}", usage.model, tokens)
		: tokens;
}
