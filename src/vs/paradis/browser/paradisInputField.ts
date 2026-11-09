/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 2（Q600）の文字の入力欄。枠（高さ 32、小さいものは 28）の中に、本家の InputBox を置く。
//
// 包んでいる本家のファイル（upstream を取り込むときは、ここの差分の「キー・フォーカス・読み上げ」を読む）:
//  - src/vs/base/browser/ui/inputbox/inputBox.ts（`<input>`、読み上げの名前、検証の文言の読み上げ、履歴）
//  - src/vs/base/browser/ui/inputbox/inputBox.css（`.monaco-inputbox` の余白を paradisInputField.css で上書きする）
//
// 本家の InputBox は地・文字・枠の色を inline の style で書くので、地と文字は渡さず、枠は透明にする（1px は必ず書かれる）。
// 見た目の枠は外側の `.paradis-field` が持ち、フォーカスの灰色の枠は paradisFocusRing.css の
// `paradis-focus-subtle-within` が描く（入力欄そのものには描かない）。

import './media/paradisInputField.css';
import { $, append } from '../../base/browser/dom.js';
import { IContextViewProvider } from '../../base/browser/ui/contextview/contextview.js';
import { InputBox } from '../../base/browser/ui/inputbox/inputBox.js';
import { Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { defaultInputBoxStyles } from '../../platform/theme/browser/defaultStyles.js';

export interface IParadisInputFieldOptions {
	/** 読み上げの名前。見えるラベルがあっても渡す（InputBox の `<input>` に付く）。 */
	readonly ariaLabel: string;
	readonly placeholder?: string;
	readonly value?: string;
	/** 枠の左に置くアイコン（検索欄の虫眼鏡など）。飾りなので読み上げからは隠す。 */
	readonly icon?: ThemeIcon;
	/** 28px（見出しの帯や行の右端に置くとき）。既定は 32px。 */
	readonly small?: boolean;
	/** 検証の文言を出すときに使う（省くと文言は出ない）。 */
	readonly contextViewProvider?: IContextViewProvider;
}

/**
 * 入力欄の色。InputBox が inline で書く地・文字は渡さず、枠は透明を渡す（InputBox は枠を必ず書き、色が空だと
 * 文字の色の線になる）。検証の文言の色だけ本家のものを使う。
 */
const PARADIS_INPUT_BOX_STYLES = {
	...defaultInputBoxStyles,
	inputBackground: undefined,
	inputForeground: undefined,
	inputBorder: 'transparent',
};

/** UI キットの文字の入力欄。キーと読み上げは本家の InputBox のまま。 */
export class ParadisInputField extends Disposable {

	/** 枠（`.paradis-field`）。幅は置く側の CSS で決める。 */
	readonly element: HTMLElement;

	private readonly inputBox: InputBox;

	constructor(parent: HTMLElement, options: IParadisInputFieldOptions) {
		super();
		this.element = append(parent, $('.paradis-field.paradis-focus-subtle-within'));
		this.element.classList.toggle('paradis-field-small', options.small === true);
		if (options.icon) {
			append(this.element, $(ThemeIcon.asCSSSelector(options.icon))).setAttribute('aria-hidden', 'true');
		}
		this.inputBox = this._register(new InputBox(this.element, options.contextViewProvider, {
			ariaLabel: options.ariaLabel,
			placeholder: options.placeholder,
			inputBoxStyles: PARADIS_INPUT_BOX_STYLES,
		}));
		this.inputBox.inputElement.spellcheck = false;
		if (options.value !== undefined) {
			this.inputBox.value = options.value;
		}
	}

	/** 中の `<input>`。確定のとき（change）だけ書く画面は、ここで change を聞く。 */
	get inputElement(): HTMLInputElement {
		return this.inputBox.inputElement;
	}

	/** 文字が変わるたびに来る。 */
	get onDidChange(): Event<string> {
		return this.inputBox.onDidChange;
	}

	get value(): string {
		return this.inputBox.value;
	}

	set value(value: string) {
		this.inputBox.value = value;
	}

	get enabled(): boolean {
		return !this.inputBox.inputElement.disabled;
	}

	set enabled(enabled: boolean) {
		this.inputBox.setEnabled(enabled);
		this.element.classList.toggle('disabled', !enabled);
	}

	setPlaceholder(placeholder: string): void {
		this.inputBox.setPlaceHolder(placeholder);
	}

	focus(): void {
		this.inputBox.focus();
	}
}
