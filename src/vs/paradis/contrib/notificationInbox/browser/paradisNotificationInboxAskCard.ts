/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 受信箱の「あなたの番」の 1 件のカード（台帳 humanAsk の問い・許可）。受信箱のポップオーバーと、チャット表示の会話の中
// （agentChat）の両方から使う。見た目は paradisNotificationInbox.css の `.pnip-ask`（ポップオーバーの中か、
// `.paradis-inbox-ask-scope` の中で効く）。

import './media/paradisNotificationInbox.css';
import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { ParadisButton, ParadisButtonKind } from '../../../browser/paradisButton.js';
import { IParadisHumanAskEntry, ParadisHumanAskAnswer } from '../../humanAsk/common/paradisHumanAsk.js';
import {
	paradisInboxAskDangerLabels,
	paradisInboxAskKindLabel,
	paradisInboxAskLayout,
	paradisInboxAskSettledText,
	paradisInboxAskSourceLabel,
} from '../common/paradisNotificationInboxAsk.js';

const $ = dom.$;

/** カードを `.pnip-ask` の見た目で描くための外側のクラス（受信箱のポップオーバーの外で使うとき）。 */
export const PARADIS_INBOX_ASK_SCOPE_CLASS = 'paradis-inbox-ask-scope';

/** 行数を切り詰めた欄の高さ（px）。`shown` は見えている高さ、`full` は切り詰めを外したときの高さ。 */
export interface IParadisInboxClampSize {
	readonly shown: number;
	readonly full: number;
}

/**
 * 切り詰めた欄が溢れているか（全体の高さが見えている高さより 1px を超えて高い）。
 * 端数の丸めで 1px ずれることがあるので、1px までは溢れと見なさない。
 */
export function paradisInboxClampOverflows(size: IParadisInboxClampSize | undefined): boolean {
	return size !== undefined && size.full > size.shown + 1;
}

/** 実物の DOM で、切り詰めた欄の高さを測る。描かれていない（つながっていない・高さ 0）なら測らない。 */
export function measureParadisInboxClamp(element: HTMLElement): IParadisInboxClampSize | undefined {
	if (!element.isConnected || element.clientHeight === 0) {
		return undefined;
	}
	// 行数の切り詰め（line-clamp）は、切った後ろを高さに数えない。いったん外して全体の高さと比べる
	const shown = element.clientHeight;
	element.style.setProperty('-webkit-line-clamp', 'none');
	const full = element.scrollHeight;
	element.style.removeProperty('-webkit-line-clamp');
	return { shown, full };
}

/** 受信箱の「あなたの番」の 1 件のカード。 */
export interface IParadisInboxAskCard extends IDisposable {
	readonly element: HTMLElement;
	readonly signature: string;
	/** 時刻の欄と、聞かれた時刻。 */
	readonly time: HTMLElement;
	readonly askedAt: number;
	/** カードの中のボタン（役目の名前 → 要素）。作り直したときに、同じ役目のボタンへフォーカスを戻す。 */
	readonly controls: Map<string, HTMLElement>;
	/** 許可の中身が、描いた後に枠（6 行）から溢れているか（溢れていたら行の中で許可させない）。 */
	readonly overflows?: () => boolean;
}

/** カードを組む側が渡すもの。 */
export interface IParadisInboxAskCardOptions {
	/** ここから送った答えを届けている最中か。 */
	readonly sending: boolean;
	/** 答えようとして断られた理由の 1 行。 */
	readonly refused: string | undefined;
	/** 許可の中身が描いた後に枠から溢れた（行の中で許可させず、モーダルへ回す）。 */
	readonly overflowing: boolean;
	now(): number;
	/** この時刻までは、答えを送るボタンを効かせない（行が動いた直後）。 */
	guardUntil(): number;
	/** 行数を切り詰めた欄の高さを測る（テストで差し替える。既定は実物の DOM を測る）。 */
	readonly measureClamp?: (element: HTMLElement) => IParadisInboxClampSize | undefined;
	answer(key: string, answer: ParadisHumanAskAnswer): void;
	/** 受信箱と同じモーダルで答える（`focusText` は「自分で書く」から開いた）。 */
	openAsk(key: string, focusText: boolean): void;
	/** 「ペインへ移動」。省けば出さない（チャット表示の会話の中では、もうそのペインにいる）。 */
	readonly revealPane?: (entry: IParadisHumanAskEntry) => void;
}

export function paradisBuildInboxAskCard(entry: IParadisHumanAskEntry, signature: string, options: IParadisInboxAskCardOptions, hoverService: IHoverService): IParadisInboxAskCard {
	const store = new DisposableStore();
	const card = $('.pnip-ask');
	const time = $('span.pnip-time');
	const controls = new Map<string, HTMLElement>();
	let command: HTMLElement | undefined;
	const built: IParadisInboxAskCard = {
		element: card, signature, time, askedAt: entry.askedAt, controls, dispose: () => { store.dispose(); card.remove(); },
		overflows: () => command !== undefined && paradisInboxClampOverflows((options.measureClamp ?? measureParadisInboxClamp)(command)),
	};
	card.setAttribute('role', 'listitem');
	card.dataset.askKey = entry.key;
	const estimated = paradisInboxAskLayout(entry);
	const layout = estimated === 'inline-actions' && options.overflowing ? 'dialog' : estimated;
	card.classList.toggle('settled', layout === 'settled');

	// 1 段目: 種類の札・出どころの札・だれから・時刻
	const top = dom.append(card, $('.pnip-row-top'));
	dom.append(top, $(`span.pnip-kind.${entry.kind}`)).textContent = paradisInboxAskKindLabel(entry.kind);
	createParadisChip(top, paradisInboxAskSourceLabel(entry.source));
	const title = dom.append(top, $('span.pnip-space'));
	title.textContent = entry.from.title;
	store.add(hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), title, entry.from.detail ? `${entry.from.title} (${entry.from.detail})` : entry.from.title));
	dom.append(top, $('span.pnip-grow'));
	top.appendChild(time);
	time.textContent = fromNow(entry.askedAt, true);
	store.add(hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), time, new Date(entry.askedAt).toLocaleString()));
	if (entry.from.detail) {
		dom.append(card, $('.pnip-detail')).textContent = entry.from.detail;
	}
	card.setAttribute('aria-label', [paradisInboxAskKindLabel(entry.kind), paradisInboxAskSourceLabel(entry.source), entry.from.title, entry.from.detail].filter(part => !!part).join(' '));

	if (layout === 'settled') {
		const settled = dom.append(card, $('.pnip-ask-settled'));
		settled.setAttribute('role', 'status');
		dom.append(settled, $(`span${ThemeIcon.asCSSSelector(Codicon.check)}`)).setAttribute('aria-hidden', 'true');
		dom.append(settled, $('span')).textContent = paradisInboxAskSettledText(entry);
		return built;
	}

	// 中身: 許可は何を許可するのか（コマンドなど）を等幅で 6 行まで、質問は前置きと問い
	if (entry.kind === 'permission') {
		const dangers = paradisInboxAskDangerLabels(entry.preface);
		if (dangers.length > 0) {
			const row = dom.append(card, $('.pnip-ask-dangers'));
			for (const label of dangers) {
				createParadisChip(row, label, 'danger');
			}
		}
		if (entry.preface) {
			command = dom.append(card, $('pre.pnip-ask-command'));
			command.textContent = entry.preface;
		}
	} else if (entry.preface) {
		dom.append(card, $('.pnip-ask-preface')).textContent = entry.preface;
	}
	if (entry.questions.length === 1) {
		dom.append(card, $('.pnip-ask-question')).textContent = entry.questions[0].text;
	} else if (entry.questions.length > 1) {
		dom.append(card, $('.pnip-ask-question')).textContent = localize('paradis.inbox.ask.questionCount', "{0}（ほか {1} 問）", entry.questions[0].text, entry.questions.length - 1);
	}

	const busy = options.sending || entry.pending !== undefined;
	const buttons = dom.append(card, $('.pnip-ask-buttons'));
	const add = (control: string, kind: ParadisButtonKind, label: string, run: () => void, guarded = true, hint?: string) => {
		const button = store.add(new ParadisButton(buttons, { kind, label, small: true, disabled: guarded && busy, title: hint }));
		button.element.dataset.askControl = control;
		controls.set(control, button.element);
		store.add(button.onDidClick(() => {
			// 答えを送るボタンは、行が動いた直後には効かせない
			if (!guarded || options.now() >= options.guardUntil()) {
				run();
			}
		}));
	};
	if (layout === 'inline-options') {
		const question = entry.questions[0];
		for (const option of question.options) {
			add(`option:${option.id}`, option.recommended ? 'primary' : 'secondary', option.recommended ? localize('paradis.inbox.ask.recommendedOption', "{0}（おすすめ）", option.label) : option.label,
				() => options.answer(entry.key, { type: 'answers', answers: [{ questionId: question.id, optionIds: [option.id] }] }), true, option.detail);
		}
		if (question.allowText) {
			add('write', 'ghost', localize('paradis.inbox.ask.writeOwn', "自分で書く"), () => options.openAsk(entry.key, true), false);
		}
	} else if (layout === 'inline-actions') {
		entry.actions.forEach((action, index) => {
			add(`action:${action.id}`, index === 0 ? 'primary' : 'secondary', action.label, () => {
				// 押した時点でも、中身が枠に収まっているかを確かめる（収まっていなければ全文を見せるモーダルを開く）
				if (built.overflows?.() === true) {
					options.openAsk(entry.key, false);
					return;
				}
				options.answer(entry.key, { type: 'action', actionId: action.id });
			});
		});
	} else if (layout === 'dialog') {
		add('open', 'secondary', entry.questions.length > 0 ? localize('paradis.inbox.ask.openToAnswer', "開いて答える") : localize('paradis.inbox.ask.openToCheck', "中身を確かめて答える"), () => options.openAsk(entry.key, false), false);
	}
	const revealPane = options.revealPane;
	if (revealPane !== undefined && entry.paneKey !== undefined && entry.windowId !== undefined) {
		add('reveal', layout === 'unanswerable' ? 'secondary' : 'ghost', localize('paradis.inbox.ask.revealPane', "ペインへ移動"), () => revealPane(entry), false);
	}
	if (entry.canSkip && layout !== 'unanswerable') {
		add('skip', 'ghost', localize('paradis.inbox.ask.skip', "飛ばす"), () => options.answer(entry.key, { type: 'skip' }));
	}

	const refused = options.refused;
	const note = refused
		?? (busy ? localize('paradis.inbox.ask.delivering', "回答を届けています…")
			: entry.failedAt !== undefined ? localize('paradis.inbox.ask.failed', "回答を届けられませんでした。元の場所で確かめてください")
				: layout === 'unanswerable' ? (entry.source === 'pane' ? localize('paradis.inbox.ask.paneOnly', "この種類はペインで答えます") : localize('paradis.inbox.ask.elsewhereOnly', "ここからは答えられません。元の場所で答えてください"))
					: undefined);
	if (note !== undefined) {
		const line = dom.append(card, $('.pnip-ask-note'));
		line.setAttribute('role', 'status');
		line.classList.toggle('error', refused !== undefined || (!busy && entry.failedAt !== undefined));
		line.textContent = note;
	}
	return built;
}
