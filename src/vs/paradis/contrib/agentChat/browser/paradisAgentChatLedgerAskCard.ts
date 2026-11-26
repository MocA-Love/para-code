/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャット表示の会話の流れに出す、台帳（humanAsk）の問いのカード。中身は受信箱の「あなたの番」のカード
// （paradisBuildInboxAskCard）そのもので、答え方の決め方・ボードの承認の確認・差し戻し・溢れたらモーダル、の守りも
// 受信箱と同じ。ここでは会話のカードの枠に入れ、「ペインへ移動」を出さない（会話の中ではもうそのペインにいる）。

import { $ } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IParadisHumanAskEntry, ParadisHumanAskAnswer } from '../../humanAsk/common/paradisHumanAsk.js';
import { IParadisInboxAskCard, PARADIS_INBOX_ASK_SCOPE_CLASS, paradisBuildInboxAskCard } from '../../notificationInbox/browser/paradisNotificationInboxAskCard.js';

/** カードが呼び出し側に求めるもの。 */
export interface IParadisAgentChatLedgerAskCardHost {
	answer(key: string, answer: ParadisHumanAskAnswer): void;
	/** 受信箱と同じモーダルで答える（問いが多い・長い選択肢・自分で書く答え・確認の要るボタン）。 */
	openDialog(key: string, focusText: boolean): void;
}

/** カードの今の状態（送っている最中・断られた理由・許可の中身が枠から溢れた）。 */
export interface IParadisAgentChatLedgerAskCardState {
	readonly sending: boolean;
	readonly refused?: string;
	readonly overflowing?: boolean;
}

/** 会話のカードの枠に入れた、受信箱のカード。`card.overflows()` が true なら、`overflowing` を立てて組み直す。 */
export function paradisRenderAgentChatLedgerAskCard(entry: IParadisHumanAskEntry, state: IParadisAgentChatLedgerAskCardState, host: IParadisAgentChatLedgerAskCardHost, hoverService: IHoverService, store: DisposableStore): { readonly element: HTMLElement; readonly card: IParadisInboxAskCard } {
	const element = $(`.paradis-agent-chat-card.ledger.${PARADIS_INBOX_ASK_SCOPE_CLASS}`);
	const card = store.add(paradisBuildInboxAskCard(entry, '', {
		sending: state.sending,
		refused: state.refused,
		overflowing: state.overflowing === true,
		now: () => Date.now(),
		// 会話の中のカードは、受信箱の一覧のように並びが入れ替わらないので、押してすぐ効かせる
		guardUntil: () => 0,
		answer: (key, answer) => host.answer(key, answer),
		openAsk: (key, focusText) => host.openDialog(key, focusText),
	}, hoverService));
	element.appendChild(card.element);
	return { element, card };
}
