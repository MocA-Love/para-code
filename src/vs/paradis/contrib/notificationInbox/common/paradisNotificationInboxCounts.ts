/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ベル・「タスク」ボタン・Dock の数の式（設計 bots-ui-design-2026-11-21 の 2 章「件数は 1 つの式で数える」）。
// 数えるのは台帳の「あなたの番」（待ちで、ほかの 1 件に寄せていないもの）と、台帳に載っていないペインの
// 許可待ち・質問の未読（中継がそのペインを見ていないと台帳に載らないため。ペインごとに 1 件）。
// 完了の未読は数えず、ベルに点だけを出す。

import { IParadisHumanAskEntry, paradisHumanAskCounted, paradisHumanAskCounts } from '../../humanAsk/common/paradisHumanAsk.js';
import { IParadisInboxEntry, IParadisInboxSnapshot } from './paradisNotificationInbox.js';

export interface IParadisInboxBadgeCounts {
	/** ベルの数（全部の出どころの「あなたの番」と、台帳に載っていないペインの許可待ち・質問）。 */
	readonly bell: number;
	/** ベルに数の代わりの点を出すか（数えるものは無いが、未読の通知がある）。 */
	readonly bellDot: boolean;
	/** 「タスク」ボタンの数（ボードの分）。 */
	readonly board: number;
	/**
	 * このウィンドウが Dock に出す分。Dock の数は main がウィンドウごとの数を足すので、各ウィンドウは
	 * 自分が持っているペインの分だけを出す。ペインを持たない 1 件（Bot の項目など）は
	 * どのウィンドウの分にもせず、Dock には数えない（ウィンドウの数だけ掛け算になるのを避ける）。
	 */
	readonly dock: number;
}

type ParadisBadgeAsk = Pick<IParadisHumanAskEntry, 'state' | 'foldedInto' | 'source' | 'paneKey'>;
type ParadisBadgeInbox = Pick<IParadisInboxSnapshot, 'unreadCount'> & { readonly entries: readonly Pick<IParadisInboxEntry, 'kind' | 'paneKey' | 'read' | 'live'>[] };

export function paradisInboxBadgeCounts(asks: readonly ParadisBadgeAsk[], inbox: ParadisBadgeInbox, ownedPaneKeys: ReadonlySet<string>): IParadisInboxBadgeCounts {
	const counts = paradisHumanAskCounts(asks);
	let dock = 0;
	// 台帳がそのペインの待ちを持っていれば（寄せた 1 件も含む）、通知の未読とは重ねない
	const askedPanes = new Set<string>();
	for (const ask of asks) {
		if (ask.paneKey !== undefined && ask.state === 'waiting') {
			askedPanes.add(ask.paneKey);
		}
		if (ask.paneKey !== undefined && ownedPaneKeys.has(ask.paneKey) && paradisHumanAskCounted(ask)) {
			dock++;
		}
	}
	const unaskedPanes = new Set<string>();
	for (const entry of inbox.entries) {
		if (entry.kind !== 'review' && !entry.read && entry.live && !askedPanes.has(entry.paneKey)) {
			unaskedPanes.add(entry.paneKey);
		}
	}
	for (const paneKey of unaskedPanes) {
		if (ownedPaneKeys.has(paneKey)) {
			dock++;
		}
	}
	const bell = counts.total + unaskedPanes.size;
	return { bell, bellDot: bell === 0 && inbox.unreadCount > 0, board: counts.board, dock };
}
