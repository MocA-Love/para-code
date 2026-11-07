/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 横断ジャンプ（スペース・タブ・エージェントを 1 つの検索で移る。Orca の Cmd+J 相当、G-05）の
// 並びと表示の文字を決める純関数。画面（クイックピック）は electron-browser 側にある。

import { localize } from '../../../../nls.js';
import { IParadisAgentLiveEntry, ParadisAgentLiveStatus } from '../../agentLiveWindow/common/paradisAgentLiveWindow.js';

/** 並びの優先度。要対応（許可待ち・質問中）が先頭、待機が最後。 */
const STATUS_ORDER: Record<ParadisAgentLiveStatus, number> = {
	permission: 0,
	question: 1,
	working: 2,
	review: 3,
	idle: 4,
};

/**
 * エージェントを要対応から順に並べる。同じ状態の中では、その状態になったのが新しいものを先にする。
 * 状態ストアが知らない値（版の違いで届きうる）は待機の後ろへ回す。
 */
export function paradisSortCrossJumpAgents(entries: readonly IParadisAgentLiveEntry[]): IParadisAgentLiveEntry[] {
	const rank = (status: ParadisAgentLiveStatus) => STATUS_ORDER[status] ?? Number.MAX_SAFE_INTEGER;
	return [...entries].sort((a, b) => rank(a.status) - rank(b.status) || b.since - a.since);
}

/** 状態が変わってからの時間を「今」「N 分前」「N 時間前」「N 日前」で表す。 */
export function paradisFormatCrossJumpAgo(elapsedMilliseconds: number): string {
	const minutes = Math.floor(Math.max(0, elapsedMilliseconds) / 60_000);
	if (minutes < 1) {
		return localize('paradis.crossJump.ago.now', "今");
	}
	if (minutes < 60) {
		return localize('paradis.crossJump.ago.minutes', "{0} 分前", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return localize('paradis.crossJump.ago.hours', "{0} 時間前", hours);
	}
	return localize('paradis.crossJump.ago.days', "{0} 日前", Math.floor(hours / 24));
}

/**
 * 「ワークツリーを作る」の行を出すか。入力が空でなく、名前・説明のどれにも入力が含まれないときだけ出す
 * （Orca と同じく、一致が無いときの逃げ道）。比べるのは大文字小文字を区別しない部分一致。
 */
export function paradisShouldOfferCrossJumpCreate(value: string, haystacks: readonly string[]): boolean {
	const needle = value.trim().toLowerCase();
	if (!needle) {
		return false;
	}
	return !haystacks.some(text => text.toLowerCase().includes(needle));
}
