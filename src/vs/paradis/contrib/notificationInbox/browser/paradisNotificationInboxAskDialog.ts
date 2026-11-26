/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 受信箱の「あなたの番」の、大きい問いに答える S のモーダル（UI キットの箱。paradisModal.ts）。
//
// - 問いが 2 つ以上・選択肢が 5 つ以上・複数選ぶ問い・自分で書く答え: 選んでから「回答する」
// - 問いが 1 つで 1 つだけ選ぶもの: 選択肢を押すとすぐ送る
// - 危険な操作を含む許可・中身の長い許可: 中身の全文と危険の札を出し、下の帯のボタンで答える。最初のフォーカスは
//   「やめる」に置く（開いた勢いの Enter で許可しない）
// - 開いている間にほかの場所で答えられたら、ボタンを外して「〇〇で回答済み」と出し、閉じるだけにする

import './media/paradisNotificationInbox.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { PARADIS_MODAL_BACKDROP_CLASS, PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';
import { IParadisHumanAskAction, IParadisHumanAskEntry, IParadisHumanAskService, ParadisHumanAskAnswer } from '../../humanAsk/common/paradisHumanAsk.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import {
	IParadisInboxAskDraft,
	paradisInboxAskAnsweredCount,
	paradisInboxAskAnswerFromDrafts,
	paradisInboxAskDangerLabels,
	paradisInboxAskKindLabel,
	paradisInboxAskRefusedText,
	paradisInboxAskSendsOnPick,
	paradisInboxAskSettledText,
	paradisInboxAskSourceLabel,
} from '../common/paradisNotificationInboxAsk.js';

const $ = dom.$;

export interface IParadisInboxAskDialogOptions {
	readonly container: HTMLElement;
	/** 開く 1 件の鍵。 */
	readonly key: string;
	/** 「自分で書く」から開いた（最初のフォーカスを入力欄に置く）。 */
	readonly focusText?: boolean;
	readonly onClose: () => void;
}

/** 問い・選択肢・ボタンが同じか（同じなら、選びかけを残したまま状態だけ書き直す）。 */
function shapeOf(entry: IParadisHumanAskEntry): string {
	return JSON.stringify([entry.questions, entry.actions, entry.preface, entry.canSkip]);
}

export class ParadisInboxAskDialog extends Disposable {

	private readonly backdrop: HTMLElement;
	private readonly modal: HTMLElement;
	private readonly body: HTMLElement;
	private readonly foot: HTMLElement;
	private readonly content = this._register(new DisposableStore());
	private readonly footStore = this._register(new DisposableStore());
	private readonly drafts = new Map<string, IParadisInboxAskDraft>();
	private shape: string | undefined;
	private firstInput: HTMLElement | undefined;
	private firstOption: HTMLElement | undefined;
	private cancelButton: HTMLElement | undefined;
	private sending = false;
	private refused: string | undefined;
	private closed = false;
	/** 許可の中身を最後まで読んだか（中身がモーダルの枠を超えるときは、最後までスクロールするまで「許可」を押せない）。 */
	private readToEnd = true;
	/** 確認の途中のボタン（押す前の確認が付いたボタンを押した）。 */
	private confirming: IParadisHumanAskAction | undefined;

	constructor(
		private readonly options: IParadisInboxAskDialogOptions,
		private readonly humanAskService: IParadisHumanAskService,
	) {
		super();
		const entry = this.entry();
		this.backdrop = $(`.paradis-inbox-ask-backdrop.${PARADIS_MODAL_BACKDROP_CLASS}`);
		this.modal = dom.append(this.backdrop, $('.paradis-inbox-ask-dialog'));
		this.modal.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		this.modal.tabIndex = -1;
		this.modal.setAttribute('role', 'dialog');
		this.modal.setAttribute('aria-modal', 'true');

		const head = renderParadisModalHead(this.modal, entry?.from.title ?? '');
		head.title.id = 'paradis-inbox-ask-dialog-title';
		this.modal.setAttribute('aria-labelledby', head.title.id);
		if (entry) {
			const chips = $('span.pniad-chips');
			head.element.insertBefore(chips, head.title);
			createParadisChip(chips, paradisInboxAskKindLabel(entry.kind), entry.kind === 'question' ? 'info' : 'warning');
			createParadisChip(chips, paradisInboxAskSourceLabel(entry.source));
		}
		const close = this._register(new ParadisButton(head.actions, { kind: 'icon', icon: Codicon.close, ariaLabel: localize('paradis.inbox.ask.close', "閉じる"), title: localize('paradis.inbox.ask.close', "閉じる") }));
		this._register(close.onDidClick(() => this.close()));

		this.body = dom.append(this.modal, $(`.${PARADIS_MODAL_BODY_CLASS}.pniad-body`));
		this.foot = dom.append(this.modal, $(`.${PARADIS_MODAL_FOOT_CLASS}.pniad-foot`));

		this._register(dom.addDisposableListener(this.backdrop, dom.EventType.MOUSE_DOWN, e => {
			if (e.target === this.backdrop) {
				this.close();
			}
		}));
		this.options.container.appendChild(this.backdrop);
		this._register(new ParadisModalFocus({ backdrop: this.backdrop, modal: this.modal, nested: false, onEscape: () => this.close(), close: () => this.close() }));
		this._register(this.humanAskService.onDidChange(() => this.render()));
		this.render();
		this.focusFirst();
	}

	override dispose(): void {
		this.backdrop.remove();
		super.dispose();
	}

	private entry(): IParadisHumanAskEntry | undefined {
		return this.humanAskService.snapshot.entries.find(candidate => candidate.key === this.options.key);
	}

	private close(): void {
		if (!this.closed) {
			this.closed = true;
			this.options.onClose();
		}
	}

	/** 最初のフォーカス。書く答えから開いたら入力欄、許可なら「やめる」、それ以外は最初の選択肢。 */
	private focusFirst(): void {
		((this.options.focusText ? this.firstInput : undefined) ?? this.cancelButton ?? this.firstOption ?? this.modal).focus();
	}

	private render(): void {
		const entry = this.entry();
		const shape = entry !== undefined && entry.state === 'waiting' ? shapeOf(entry) : undefined;
		if (shape !== undefined && shape === this.shape) {
			this.renderFoot(entry!);
			return;
		}
		if (shape !== undefined && this.shape !== undefined) {
			// 問いの中身が変わった。古い問いへの選びかけを新しい問いへ持ち越さない
			this.drafts.clear();
		}
		this.shape = shape;
		const hadFocus = dom.isAncestor(dom.getActiveElement(), this.modal);
		this.content.clear();
		this.footStore.clear();
		this.firstInput = undefined;
		this.firstOption = undefined;
		this.cancelButton = undefined;
		dom.clearNode(this.body);
		dom.clearNode(this.foot);
		if (entry === undefined || entry.state !== 'waiting') {
			// 開いている間にほかの場所で答えられた・取り下げられた
			const settled = dom.append(this.body, $('.pniad-settled'));
			settled.setAttribute('role', 'status');
			dom.append(settled, $(`span${ThemeIcon.asCSSSelector(Codicon.check)}`)).setAttribute('aria-hidden', 'true');
			dom.append(settled, $('span')).textContent = paradisInboxAskSettledText(entry ?? { state: 'withdrawn' });
			const done = this.content.add(new ParadisButton(this.foot, { kind: 'primary', label: localize('paradis.inbox.ask.close', "閉じる") }));
			this.content.add(done.onDidClick(() => this.close()));
			if (hadFocus) {
				done.element.focus();
			}
			return;
		}

		if (entry.from.detail) {
			dom.append(this.body, $('.pniad-from')).textContent = entry.from.detail;
		}
		const dangers = entry.kind === 'permission' ? paradisInboxAskDangerLabels(entry.preface) : [];
		if (dangers.length > 0) {
			const row = dom.append(this.body, $('.pniad-dangers'));
			for (const label of dangers) {
				createParadisChip(row, label, 'danger');
			}
		}
		if (entry.preface) {
			const preface = dom.append(this.body, $(entry.kind === 'permission' ? 'pre.pniad-detail' : '.pniad-preface'));
			preface.textContent = entry.preface;
			if (entry.kind === 'permission') {
				const atEnd = () => preface.scrollTop + preface.clientHeight >= preface.scrollHeight - 2;
				this.readToEnd = atEnd();
				this.content.add(dom.addDisposableListener(preface, dom.EventType.SCROLL, () => {
					if (!this.readToEnd && atEnd()) {
						this.readToEnd = true;
						const current = this.entry();
						if (current !== undefined && current.state === 'waiting') {
							this.renderFoot(current);
						}
					}
				}));
			}
		}
		const sendsOnPick = paradisInboxAskSendsOnPick(entry);
		entry.questions.forEach((question, index) => {
			const section = dom.append(this.body, $('.pniad-question'));
			section.setAttribute('role', 'group');
			const text = dom.append(section, $('.pniad-question-text'));
			text.id = `paradis-inbox-ask-question-${index}`;
			text.textContent = entry.questions.length > 1 ? `${index + 1}. ${question.text}` : question.text;
			section.setAttribute('aria-labelledby', text.id);
			const draft = (): IParadisInboxAskDraft => this.drafts.get(question.id) ?? { optionIds: [], text: '' };
			const options = dom.append(section, $('.pniad-options'));
			const buttons = new Map<string, ParadisButton>();
			const paint = () => {
				for (const [id, button] of buttons) {
					button.checked = draft().optionIds.includes(id);
				}
			};
			for (const option of question.options) {
				const button = this.content.add(new ParadisButton(options, { kind: 'secondary', label: option.label, title: option.detail }));
				button.element.classList.add('pniad-option');
				this.firstOption ??= button.element;
				if (option.recommended) {
					dom.append(button.element, $('small.pniad-recommended')).textContent = localize('paradis.inbox.ask.recommended', "おすすめ");
				}
				buttons.set(option.id, button);
				this.content.add(button.onDidClick(() => {
					if (sendsOnPick) {
						void this.send({ type: 'answers', answers: [{ questionId: question.id, optionIds: [option.id] }] });
						return;
					}
					const current = draft();
					const picked = current.optionIds.includes(option.id);
					const optionIds = question.multiSelect
						? (picked ? current.optionIds.filter(id => id !== option.id) : [...current.optionIds, option.id])
						: (picked ? [] : [option.id]);
					this.drafts.set(question.id, { optionIds, text: current.text });
					paint();
					this.renderFoot(entry);
				}));
			}
			paint();
			if (question.allowText) {
				const label = localize('paradis.inbox.ask.writeOwn', "自分で書く");
				const field = this.content.add(new ParadisInputField(section, { ariaLabel: `${label}: ${question.text}`, placeholder: label, value: draft().text }));
				field.element.classList.add('pniad-text');
				field.inputElement.autocomplete = 'off';
				this.firstInput ??= field.inputElement;
				this.content.add(field.onDidChange(value => {
					this.drafts.set(question.id, { optionIds: draft().optionIds, text: value });
					this.renderFoot(entry);
				}));
				// 打ち終わりの Enter で送る（変換の確定の Enter では送らない）
				this.content.add(dom.addDisposableListener(field.inputElement, dom.EventType.KEY_DOWN, e => {
					if (e.key === 'Enter' && !e.isComposing) {
						e.preventDefault();
						this.submitDrafts();
					}
				}));
			}
		});
		this.renderFoot(entry);
		if (hadFocus && !dom.isAncestor(dom.getActiveElement(), this.modal)) {
			this.focusFirst();
		}
	}

	/** 下の帯（状態の 1 行とボタン）。選ぶたび・台帳が変わるたびに書き直す。 */
	private renderFoot(entry: IParadisHumanAskEntry): void {
		const focusedClass = [...(dom.getActiveElement()?.classList ?? [])].find(name => name.startsWith('pniad-foot-'));
		this.footStore.clear();
		dom.clearNode(this.foot);
		const delivering = this.sending || entry.pending !== undefined;
		const status = dom.append(this.foot, $('.pniad-status'));
		status.setAttribute('role', 'status');
		if (this.refused !== undefined) {
			status.classList.add('error');
			status.textContent = this.refused;
		} else if (delivering) {
			status.textContent = localize('paradis.inbox.ask.delivering', "回答を届けています…");
		} else if (entry.failedAt !== undefined) {
			status.classList.add('error');
			status.textContent = localize('paradis.inbox.ask.failed', "回答を届けられませんでした。元の場所で確かめてください");
		} else if (entry.kind === 'permission' && !this.readToEnd && entry.actions.length > 0) {
			status.textContent = localize('paradis.inbox.ask.readToEnd', "中身を最後まで読むと「{0}」を押せます", entry.actions[0].label);
		} else if (entry.questions.length > 1) {
			status.textContent = entry.source === 'pane'
				? localize('paradis.inbox.ask.progressAll', "{0} / {1} を選びました。全部に答えると送れます", paradisInboxAskAnsweredCount(entry, this.drafts), entry.questions.length)
				: localize('paradis.inbox.ask.progress', "{0} / {1} を選びました", paradisInboxAskAnsweredCount(entry, this.drafts), entry.questions.length);
		}
		const add = (name: string, kind: 'primary' | 'secondary' | 'ghost' | 'danger', label: string, enabled: boolean, run: () => void) => {
			const button = this.footStore.add(new ParadisButton(this.foot, { kind, label, disabled: !enabled }));
			button.element.classList.add(`pniad-foot-${name}`);
			if (name === 'cancel') {
				this.cancelButton = button.element;
			}
			this.footStore.add(button.onDidClick(run));
			if (focusedClass === `pniad-foot-${name}`) {
				button.element.focus();
			}
		};
		if (entry.canSkip) {
			add('skip', 'ghost', localize('paradis.inbox.ask.skip', "飛ばす"), !delivering, () => void this.send({ type: 'skip' }));
		}
		const confirming = this.confirming !== undefined && entry.questions.length === 0 ? entry.actions.find(action => action.id === this.confirming!.id && action.confirm !== undefined) : undefined;
		if (confirming?.confirm !== undefined) {
			// 押す前の確認（ボードの画面と同じ文）。「やめる」はボタンの一覧へ戻るだけ
			if (this.refused === undefined && !delivering) {
				status.textContent = '';
				status.classList.add('confirm');
				dom.append(status, $('strong.pniad-confirm-title')).textContent = confirming.confirm.title;
				if (confirming.confirm.body) {
					dom.append(status, $('span.pniad-confirm-body')).textContent = confirming.confirm.body;
				}
			}
			add('cancel', 'secondary', localize('paradis.inbox.ask.cancel', "やめる"), true, () => {
				this.confirming = undefined;
				this.renderFoot(entry);
			});
			add('confirm', 'primary', confirming.confirm.ok, !delivering, () => void this.send({ type: 'action', actionId: confirming.id }));
			// 確認を開いた直後は「やめる」に置く（Enter の押し続けで確認まで通さない）
			if (focusedClass?.startsWith('pniad-foot-action-')) {
				this.cancelButton?.focus();
			}
			return;
		}
		this.confirming = undefined;
		add('cancel', 'secondary', localize('paradis.inbox.ask.cancel', "やめる"), true, () => this.close());
		if (entry.questions.length > 0) {
			// 押してすぐ送る問いでも、自分で書いた答えは「回答する」で送る
			if (!paradisInboxAskSendsOnPick(entry) || entry.questions[0].allowText) {
				add('submit', 'primary', localize('paradis.inbox.ask.submit', "回答する"), !delivering && paradisInboxAskAnswerFromDrafts(entry, this.drafts) !== undefined, () => this.submitDrafts());
			}
		} else {
			entry.actions.forEach((action, index) => {
				// 主のボタンは 1 つだけ。拒否にあたるもの（2 つ目以降）は副のボタン
				// 許可にあたる主のボタンは、中身を最後まで読むまで押せない（拒否は読まずに押せる）
				const unread = entry.kind === 'permission' && index === 0 && !this.readToEnd;
				add(`action-${index}`, index === 0 ? 'primary' : 'secondary', action.label, !delivering && !unread, () => {
					if (action.confirm !== undefined) {
						this.confirming = action;
						this.renderFoot(entry);
						return;
					}
					void this.send({ type: 'action', actionId: action.id });
				});
			});
		}
	}

	private submitDrafts(): void {
		const entry = this.entry();
		const answer = entry !== undefined && entry.state === 'waiting' ? paradisInboxAskAnswerFromDrafts(entry, this.drafts) : undefined;
		if (answer !== undefined) {
			void this.send(answer);
		}
	}

	private async send(answer: ParadisHumanAskAnswer): Promise<void> {
		const entry = this.entry();
		if (this.sending || entry === undefined || entry.state !== 'waiting' || entry.pending !== undefined) {
			return;
		}
		this.sending = true;
		this.refused = undefined;
		this.renderFoot(entry);
		const result = await this.humanAskService.answer(this.options.key, answer, 'inbox');
		this.sending = false;
		if (this._store.isDisposed) {
			return;
		}
		if (result.ok) {
			// 届いたかどうかは受信箱のカードに出る（回答済みになるか、「届けられませんでした」が付く）
			this.close();
			return;
		}
		this.refused = paradisInboxAskRefusedText(result.reason);
		const current = this.entry();
		if (current !== undefined && current.state === 'waiting') {
			this.renderFoot(current);
		} else {
			this.render();
		}
	}
}
