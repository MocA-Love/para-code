/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

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
