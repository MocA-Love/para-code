/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ベル・「タスク」ボタン・Dock の数の式（設計 bots-ui-design-2026-11-21 の 2 章「件数は 1 つの式で数える」）。
// 数えるのは台帳の「あなたの番」（待ちで、ほかの 1 件に寄せていないもの）だけ。完了などの未読の通知は
// 数えず、ベルに点だけを出す。

import { IParadisHumanAskEntry, paradisHumanAskCounted, paradisHumanAskCounts } from '../../humanAsk/common/paradisHumanAsk.js';

export interface IParadisInboxBadgeCounts {
	/** ベルの数（全部の出どころの「あなたの番」）。 */
	readonly bell: number;
	/** ベルに数の代わりの点を出すか（「あなたの番」は無いが、未読の通知がある）。 */
	readonly bellDot: boolean;
	/** 「タスク」ボタンの数（ボードの分）。 */
	readonly board: number;
	/**
	 * このウィンドウが Dock に出す分。Dock の数は main がウィンドウごとの数を足すので、各ウィンドウは
	 * 自分が持っているペインの「あなたの番」だけを出す。ペインを持たない 1 件（Bot の項目など）は
	 * どのウィンドウの分にもせず、Dock には数えない（ウィンドウの数だけ掛け算になるのを避ける）。
	 */
	readonly dock: number;
}

export function paradisInboxBadgeCounts(
	asks: readonly Pick<IParadisHumanAskEntry, 'state' | 'foldedInto' | 'source' | 'paneKey'>[],
	unreadNotifications: number,
	ownedPaneKeys: ReadonlySet<string>,
): IParadisInboxBadgeCounts {
	const counts = paradisHumanAskCounts(asks);
	let dock = 0;
	for (const ask of asks) {
		if (ask.paneKey !== undefined && ownedPaneKeys.has(ask.paneKey) && paradisHumanAskCounted(ask)) {
			dock++;
		}
	}
	return { bell: counts.total, bellDot: counts.total === 0 && unreadNotifications > 0, board: counts.board, dock };
}
