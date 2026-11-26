/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャット表示の会話の流れに出す、台帳（humanAsk）の問いのカード。答え方の決め方（行の中で答えるか、モーダルを開くか）・
// 文言・モーダルは受信箱のもの（notificationInbox の paradisNotificationInboxAsk と ParadisInboxAskDialog）をそのまま使い、
// ここでは形だけをチャット表示のカードに合わせる。答えは台帳へ送るので、ほかの場所（受信箱・スマホ・ボード）からも消える。

import { $, append } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IParadisHumanAskEntry, ParadisHumanAskAnswer } from '../../humanAsk/common/paradisHumanAsk.js';
import { paradisInboxAskKindLabel, paradisInboxAskLayout, paradisInboxAskSourceLabel } from '../../notificationInbox/common/paradisNotificationInboxAsk.js';
import { paradisAgentChatButton } from './paradisAgentChatButton.js';

/** カードが呼び出し側に求めるもの。 */
export interface IParadisAgentChatLedgerAskCardHost {
	answer(key: string, answer: ParadisHumanAskAnswer): void;
	/** 受信箱と同じモーダルで答える（問いが多い・長い選択肢・自分で書く答え・確認の要るボタン）。 */
	openDialog(key: string, focusText: boolean): void;
}

/** カードの今の状態（送っている最中・断られた理由）。 */
export interface IParadisAgentChatLedgerAskCardState {
	readonly sending: boolean;
	readonly refused?: string;
}

export function paradisRenderAgentChatLedgerAskCard(entry: IParadisHumanAskEntry, state: IParadisAgentChatLedgerAskCardState, host: IParadisAgentChatLedgerAskCardHost, store: DisposableStore): HTMLElement {
	const card = $('.paradis-agent-chat-card.ledger');
	card.dataset.askKey = entry.key;
	const title = append(card, $('.paradis-agent-chat-card-title'));
	append(title, $('span.paradis-agent-chat-question-header')).textContent = paradisInboxAskKindLabel(entry.kind);
	append(title, $('span.paradis-agent-chat-ledger-from')).textContent = localize('paradisAgentChat.ledgerFrom', "{0}（{1}）", entry.from.title, paradisInboxAskSourceLabel(entry.source));
	if (entry.preface) {
		append(card, $('.paradis-agent-chat-question-text.paradis-agent-chat-ledger-preface')).textContent = entry.preface;
	}
	if (entry.questions.length === 1) {
		append(card, $('.paradis-agent-chat-question-text')).textContent = entry.questions[0].text;
	} else if (entry.questions.length > 1) {
		append(card, $('.paradis-agent-chat-question-text')).textContent = localize('paradisAgentChat.ledgerQuestionCount', "{0}（ほか {1} 問）", entry.questions[0].text, entry.questions.length - 1);
	}
	const footer = append(card, $('.paradis-agent-chat-card-footer'));
	const busy = state.sending || entry.pending !== undefined;
	const add = (label: string, primary: boolean, run: () => void, guarded = true) => {
		const button = paradisAgentChatButton(footer, primary ? 'primary' : 'secondary', store);
		button.label = label;
		button.enabled = !(guarded && busy);
		store.add(button.onDidClick(run));
	};
	const layout = paradisInboxAskLayout(entry);
	if (layout === 'inline-options') {
		const question = entry.questions[0];
		for (const option of question.options) {
			add(option.recommended ? localize('paradisAgentChat.ledgerRecommended', "{0}（おすすめ）", option.label) : option.label, option.recommended === true,
				() => host.answer(entry.key, { type: 'answers', answers: [{ questionId: question.id, optionIds: [option.id] }] }));
		}
		if (question.allowText) {
			add(localize('paradisAgentChat.ledgerWrite', "自分で書く"), false, () => host.openDialog(entry.key, true), false);
		}
	} else if (layout === 'inline-actions') {
		entry.actions.forEach((action, index) => add(action.label, index === 0, () => host.answer(entry.key, { type: 'action', actionId: action.id })));
	} else if (layout === 'dialog') {
		add(localize('paradisAgentChat.ledgerOpen', "開いて答える"), true, () => host.openDialog(entry.key, false), false);
	}
	if (entry.canSkip && layout !== 'unanswerable') {
		add(localize('paradisAgentChat.ledgerSkip', "飛ばす"), false, () => host.answer(entry.key, { type: 'skip' }));
	}
	const note = state.refused
		?? (busy ? localize('paradisAgentChat.ledgerDelivering', "回答を届けています…")
			: entry.failedAt !== undefined ? localize('paradisAgentChat.ledgerFailed', "回答を届けられませんでした。元の場所で確かめてください")
				: layout === 'unanswerable' ? localize('paradisAgentChat.ledgerElsewhere', "ここからは答えられません。元の場所で答えてください")
					: undefined);
	if (note !== undefined) {
		const line = append(footer, $('span.paradis-agent-chat-card-note'));
		line.setAttribute('role', 'status');
		line.textContent = note;
		footer.classList.toggle('error', state.refused !== undefined || (!busy && entry.failedAt !== undefined));
	}
	return card;
}
