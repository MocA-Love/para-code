/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャット表示の、Codex の非同期の質問（request_user_input_async）のカードと、返信の発言の表示。
// 答えは決まった形の発言に組み立て、入力欄と同じ経路（貼り付け → Enter）で送る。一部の問いだけ答えて送ってもよく、
// 残りは中継の台帳に残る（Codex は後から返信の形で送っても受け付ける）。

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IParadisCodexAsyncQuestion, paradisBuildCodexAsyncReply } from '../../mobileRelay/common/paradisCodexAsyncQuestions.js';
import { IParadisAgentQuestionReply } from '../common/paradisAgentChat.js';

/** 1 問の書きかけの答え。選んだ選択肢と自由入力は同時には使わない（打つと選択を外す）。 */
export interface IParadisAgentChatAsyncAnswerDraft {
	option?: number;
	other: string;
}

/** ペインごとの、非同期の質問のカードの状態（表示を切り替えても失わないよう、呼び出し側に持たせる）。 */
export interface IParadisAgentChatAsyncDrafts {
	/** questionItemId → 書きかけの答え。 */
	readonly answers: Map<string, IParadisAgentChatAsyncAnswerDraft>;
	/** call_id → 見ている問いの番号。 */
	readonly steps: Map<string, number>;
	/** 送った問い（中継の台帳から消えるまで、もう一度は送らせない）。 */
	readonly sent: Set<string>;
	/** 送っている最中の呼び出し。 */
	sending?: string;
	error?: { readonly callId: string; readonly message: string };
}

export function paradisNewAgentChatAsyncDrafts(): IParadisAgentChatAsyncDrafts {
	return { answers: new Map(), steps: new Map(), sent: new Set() };
}

/** 書きかけから、送る答えの文字列（自由入力を優先。空なら選んだ選択肢）。答えていなければ undefined。 */
export function paradisAsyncAnswerText(question: IParadisCodexAsyncQuestion, draft: IParadisAgentChatAsyncAnswerDraft | undefined): string | undefined {
	const other = draft?.other.trim() ?? '';
	if (other.length > 0) {
		return other;
	}
	return draft?.option !== undefined ? question.options?.[draft.option] : undefined;
}

/** 呼び出しごとにまとめる（出た順）。 */
export function paradisGroupAsyncQuestions(questions: readonly IParadisCodexAsyncQuestion[]): IParadisCodexAsyncQuestion[][] {
	const groups = new Map<string, IParadisCodexAsyncQuestion[]>();
	for (const question of questions) {
		const group = groups.get(question.callId);
		if (group === undefined) {
			groups.set(question.callId, [question]);
		} else {
			group.push(question);
		}
	}
	return [...groups.values()];
}

/**
 * 呼び出しの中で答えた問いから返信の発言を作る。送った問いは除く。入れる答えが無ければ undefined。
 */
export function paradisBuildAsyncReplyFromDrafts(questions: readonly IParadisCodexAsyncQuestion[], drafts: IParadisAgentChatAsyncDrafts): { readonly text: string; readonly ids: readonly string[] } | undefined {
	const answers = questions
		.filter(question => !drafts.sent.has(question.id))
		.map(question => ({ question, answer: paradisAsyncAnswerText(question, drafts.answers.get(question.id)) }))
		.filter((entry): entry is { question: IParadisCodexAsyncQuestion; answer: string } => entry.answer !== undefined);
	const text = paradisBuildCodexAsyncReply(answers);
	return text !== undefined ? { text, ids: answers.map(entry => entry.question.id) } : undefined;
}

/** 描き直しが要るかの指紋（自由入力の文字は含めない。打つたびに作り直すと入力欄のフォーカスが外れる）。 */
export function paradisAsyncQuestionsSignature(questions: readonly IParadisCodexAsyncQuestion[], drafts: IParadisAgentChatAsyncDrafts, busy: boolean): string {
	return JSON.stringify([
		questions.map(question => question.id), busy, drafts.sending, drafts.error,
		[...drafts.steps], [...drafts.sent],
		questions.map(question => {
			const draft = drafts.answers.get(question.id);
			// 空の書きかけ（描いたときに作ったもの）は、書きかけが無いのと同じ（作り直して入力欄のフォーカスを外さない）
			return draft === undefined || (draft.option === undefined && draft.other.trim().length === 0) ? '' : `${draft.option ?? ''}:${draft.other.trim().length > 0 ? 't' : ''}`;
		}),
	]);
}

export interface IParadisAsyncQuestionCardActions {
	/** カードを描き直す。 */
	rerender(): void;
	/** 答えた問いを送る。 */
	submit(callId: string): void;
}

/** 1 回の呼び出しの質問のカード。 */
export function paradisRenderAsyncQuestionCard(questions: readonly IParadisCodexAsyncQuestion[], drafts: IParadisAgentChatAsyncDrafts, busy: boolean, store: DisposableStore, actions: IParadisAsyncQuestionCardActions): HTMLElement {
	const first = questions[0];
	const callId = first.callId;
	const card = $('.paradis-agent-chat-card.question.async');
	const title = append(card, $('.paradis-agent-chat-card-title'));
	title.append(renderIcon(Codicon.question), $('span', undefined, questions.length > 1
		? localize('paradisAgentChat.asyncQuestionsTitle', "Codex からの {0} つの質問", questions.length)
		: localize('paradisAgentChat.asyncQuestionTitle', "Codex からの質問")));
	append(title, $('span.paradis-agent-chat-question-header')).textContent = busy
		? localize('paradisAgentChat.asyncWorking', "作業は続いています")
		: localize('paradisAgentChat.asyncIdle', "作業は終わっています");
	const sending = drafts.sending === callId;
	const locked = (question: IParadisCodexAsyncQuestion) => sending || drafts.sent.has(question.id);
	const step = Math.min(drafts.steps.get(callId) ?? 0, questions.length - 1);
	if (questions.length > 1) {
		const steps = append(card, $('.paradis-agent-chat-question-steps'));
		questions.forEach((question, index) => {
			const button = append(steps, $('button.paradis-agent-chat-question-step')) as HTMLButtonElement;
			button.type = 'button';
			button.classList.toggle('active', index === step);
			button.classList.toggle('done', paradisAsyncAnswerText(question, drafts.answers.get(question.id)) !== undefined);
			button.textContent = String(index + 1);
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				drafts.steps.set(callId, index);
				actions.rerender();
			}));
		});
	}
	const question = questions[step];
	let draft = drafts.answers.get(question.id);
	if (draft === undefined) {
		draft = { other: '' };
		drafts.answers.set(question.id, draft);
	}
	const currentDraft = draft;
	const block = append(card, $('.paradis-agent-chat-question'));
	append(block, $('.paradis-agent-chat-question-text')).textContent = question.title;
	const optionButtons: HTMLButtonElement[] = [];
	if (question.options !== undefined) {
		const options = append(block, $('.paradis-agent-chat-question-options'));
		question.options.forEach((option, optionIndex) => {
			const button = append(options, $('button.paradis-agent-chat-option')) as HTMLButtonElement;
			button.type = 'button';
			button.disabled = locked(question);
			button.classList.toggle('selected', currentDraft.option === optionIndex && currentDraft.other.trim().length === 0);
			append(button, $('span.paradis-agent-chat-option-label')).textContent = `${optionIndex + 1}. ${option}`;
			optionButtons.push(button);
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				// もう一度押すと選択を外す（一部の問いだけ答えて送れるように）
				currentDraft.option = currentDraft.option === optionIndex && currentDraft.other.trim().length === 0 ? undefined : optionIndex;
				currentDraft.other = '';
				if (currentDraft.option !== undefined && step < questions.length - 1) {
					drafts.steps.set(callId, step + 1);
				}
				actions.rerender();
			}));
		});
	}
	const otherRow = append(block, $('.paradis-agent-chat-question-other'));
	const otherInput = append(otherRow, $('input.paradis-agent-chat-other-input')) as HTMLInputElement;
	otherInput.type = 'text';
	otherInput.placeholder = question.options !== undefined
		? localize('paradisAgentChat.otherPlaceholder', "その他（自由に入力）")
		: localize('paradisAgentChat.asyncAnswerPlaceholder', "回答を入力");
	otherInput.value = currentDraft.other;
	otherInput.disabled = locked(question);
	const composing = { value: false };
	store.add(addDisposableListener(otherInput, 'compositionstart', () => { composing.value = true; }));
	store.add(addDisposableListener(otherInput, 'compositionend', () => { composing.value = false; }));

	const footer = append(card, $('.paradis-agent-chat-card-footer'));
	const submitButton = append(footer, $('button.paradis-agent-chat-primary')) as HTMLButtonElement;
	submitButton.type = 'button';
	const answeredCount = () => questions.filter(candidate => !drafts.sent.has(candidate.id) && paradisAsyncAnswerText(candidate, drafts.answers.get(candidate.id)) !== undefined).length;
	const unsent = questions.filter(candidate => !drafts.sent.has(candidate.id)).length;
	const updateSubmit = () => {
		const count = answeredCount();
		submitButton.disabled = sending || count === 0;
		submitButton.textContent = sending
			? localize('paradisAgentChat.sending', "送っています…")
			: unsent > 1
				? localize('paradisAgentChat.asyncSubmitCount', "回答を送る（{0}/{1}）", count, unsent)
				: localize('paradisAgentChat.submitAnswers', "回答を送る");
	};
	updateSubmit();
	store.add(addDisposableListener(otherInput, EventType.INPUT, () => {
		currentDraft.other = otherInput.value;
		if (otherInput.value.trim().length > 0) {
			// 選んでいた選択肢を外す（打つたびに作り直すとフォーカスが外れるので、表示だけ直す）
			currentDraft.option = undefined;
			for (const button of optionButtons) {
				button.classList.remove('selected');
			}
		}
		updateSubmit();
	}));
	store.add(addDisposableListener(otherInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		if (e.key === 'Enter' && !composing.value && !e.isComposing && e.keyCode !== 229) {
			e.preventDefault();
			e.stopPropagation();
			if (otherInput.value.trim().length === 0) {
				return;
			}
			if (step < questions.length - 1) {
				drafts.steps.set(callId, step + 1);
				actions.rerender();
			} else {
				actions.submit(callId);
			}
		}
	}));
	store.add(addDisposableListener(submitButton, EventType.CLICK, () => actions.submit(callId)));
	const error = drafts.error?.callId === callId ? drafts.error.message : undefined;
	append(footer, $('span.paradis-agent-chat-card-note')).textContent = error ?? (busy
		? localize('paradisAgentChat.asyncNoteWorking', "答えた問いだけを送ります。送ると書きかけの応答は打ち切られ、答えを読んで続けます")
		: localize('paradisAgentChat.asyncNoteIdle', "答えた問いだけを、新しい依頼として送ります"));
	footer.classList.toggle('error', error !== undefined);
	return card;
}

/** 返信の発言（Codex の非同期の質問への答え）を「質問と答え」の並びで描く。 */
export function paradisRenderQuestionReplies(container: HTMLElement, replies: readonly IParadisAgentQuestionReply[]): void {
	const list = append(container, $('.paradis-agent-chat-question-replies'));
	list.setAttribute('aria-label', localize('paradisAgentChat.questionRepliesLabel', "質問への回答"));
	for (const reply of replies) {
		const row = append(list, $('.paradis-agent-chat-question-reply'));
		const question = append(row, $('.paradis-agent-chat-question-reply-question'));
		question.append(renderIcon(Codicon.reply), $('span', undefined, localize('paradisAgentChat.questionReplyQuestion', "回答: {0}", reply.question)));
		append(row, $('.paradis-agent-chat-question-reply-answer')).textContent = reply.answer;
	}
}
