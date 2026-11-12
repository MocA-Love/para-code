/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知・読み上げの画面で UI キットの部品を置く小さな手伝い。各節は設定が変わるたびに中身を作り直すので、
// 作った部品はその都度消える DisposableStore（各節の _renderDisposables）に積む。
//
// - ボタンは要素のまま `paradisButtonClasses()` を付ける（作り直しのたびに後始末が要らない）。アイコンは中の span に置く
//   （ボタンの要素に codicon を付けると、キットのボタンの font-family が字形を消す）
// - 文字の入力欄は ParadisInputField（行に置くので 28 の小さい段）。中の `<input>` を返すので、今の入力・確定・
//   フォーカスの処理はそのまま使える
// - 複数行の欄はキットの欄の枠（`.paradis-field`）に textarea を入れる（ワークスペースの詳細のメモと同じ形）

import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ParadisButtonKind, paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { createParadisChip, ParadisChipTone } from '../../../browser/paradisBadges.js';

const $ = dom.$;

export interface IParadisNotifButtonOptions {
	readonly label?: string;
	readonly icon?: ThemeIcon;
	/** 文字の無いボタンの読み上げの名前とホバー。 */
	readonly title?: string;
	/** 渡すと、ホバーを IHoverService で出す（渡さないときは title 属性）。ホバーは store と一緒に消える。 */
	readonly hover?: { readonly service: IHoverService; readonly store: DisposableStore };
	readonly className?: string;
	/** 24px（タイルや表の行の中に置くとき）。既定は 28px。 */
	readonly small?: boolean;
}

/** キットの見た目のボタンを作る（要素は素の `<button>` のまま）。 */
export function paradisNotifButton(parent: HTMLElement, kind: ParadisButtonKind, options: IParadisNotifButtonOptions = {}): HTMLButtonElement {
	return paradisNotifButtonWithHover(parent, kind, options).button;
}

/** {@link paradisNotifButton} と同じで、IHoverService のホバー（`options.hover` を渡したとき）も返す（文言を後で替える場所向け）。 */
export function paradisNotifButtonWithHover(parent: HTMLElement, kind: ParadisButtonKind, options: IParadisNotifButtonOptions = {}): { readonly button: HTMLButtonElement; readonly hover: IManagedHover | undefined } {
	const button = dom.append(parent, $<HTMLButtonElement>('button'));
	button.type = 'button';
	button.classList.add(...paradisButtonClasses(kind, options.small));
	if (options.className) {
		button.classList.add(options.className);
	}
	if (options.icon) {
		dom.append(button, $(ThemeIcon.asCSSSelector(options.icon)));
	}
	if (options.label) {
		dom.append(button, $('span')).textContent = options.label;
	}
	let hover: IManagedHover | undefined;
	if (options.title) {
		button.setAttribute('aria-label', options.title);
		if (options.hover) {
			hover = options.hover.store.add(options.hover.service.setupManagedHover(getDefaultHoverDelegate('element'), button, options.title));
		} else {
			button.title = options.title;
		}
	}
	return { button, hover };
}

/** アイコンのボタンのアイコンを替える（再生 ⇄ 停止、表示 ⇄ 非表示など）。 */
export function paradisNotifSetButtonIcon(button: HTMLButtonElement, icon: ThemeIcon): void {
	dom.clearNode(button);
	dom.append(button, $(ThemeIcon.asCSSSelector(icon)));
}

export interface IParadisNotifInputOptions {
	readonly ariaLabel: string;
	readonly placeholder?: string;
	readonly value?: string;
	readonly className?: string;
	readonly icon?: ThemeIcon;
}

/** キットの文字の入力欄（28px）を置き、枠と中の `<input>` を返す。枠は `store` と一緒に消える。 */
export function paradisNotifInput(parent: HTMLElement, store: DisposableStore, options: IParadisNotifInputOptions): { readonly field: ParadisInputField; readonly input: HTMLInputElement } {
	const field = store.add(new ParadisInputField(parent, { ariaLabel: options.ariaLabel, placeholder: options.placeholder, value: options.value, icon: options.icon, small: true }));
	if (options.className) {
		field.element.classList.add(options.className);
	}
	return { field, input: field.inputElement };
}

/** キットの欄の枠に入れた複数行の欄。 */
export function paradisNotifTextArea(parent: HTMLElement, ariaLabel: string, className?: string): HTMLTextAreaElement {
	const frame = dom.append(parent, $('.paradis-field.paradis-focus-subtle-within.pns-textarea-field'));
	if (className) {
		frame.classList.add(className);
	}
	const textarea = dom.append(frame, $<HTMLTextAreaElement>('textarea'));
	textarea.spellcheck = false;
	textarea.setAttribute('aria-label', ariaLabel);
	return textarea;
}

/**
 * 誤りの文字を出す要素。出た文字は読み上げられる（`role="alert"` は空のうちから付けておく。後から付けると読まれないことがある）。
 * `input` を渡すと、欄の `aria-describedby` でこの要素と結ぶ（欄にフォーカスがあるときも誤りが読まれる）。
 */
export function paradisNotifErrorElement(parent: HTMLElement, className: string, input?: HTMLInputElement): HTMLElement {
	const element = dom.append(parent, $(className));
	element.setAttribute('role', 'alert');
	if (input) {
		element.id = `pns-error-${generateUuid()}`;
		input.setAttribute('aria-describedby', element.id);
	}
	return element;
}

/** 欄の誤りを出す（空の文字で消す）。誤りが出ている間だけ欄に `aria-invalid="true"` を付ける。 */
export function paradisNotifSetFieldError(input: HTMLInputElement, errorElement: HTMLElement, message: string): void {
	errorElement.textContent = message;
	if (message) {
		input.setAttribute('aria-invalid', 'true');
	} else {
		input.removeAttribute('aria-invalid');
	}
}

/**
 * キットのチップ（11px・丸・淡い枠）。`className` は節ごとの置き方（並べ方・省略）と、テストや検索が見る印。
 * 長い文字は中の文字が「…」で切れるので、全文のホバーは返した要素に付ける。
 */
export function paradisNotifChip(parent: HTMLElement, label: string, tone: ParadisChipTone = 'neutral', className?: string): HTMLElement {
	const chip = createParadisChip(parent, label, tone);
	if (className) {
		chip.classList.add(className);
	}
	return chip;
}
