/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 2（Q600）のチェック。16px の箱と、その右の文字。複数から選ぶもの（項目の並び）に使い、
// 押した瞬間に効く 1 つのオン/オフはスイッチ（paradisSwitch.ts）を使う。
//
// 包んでいる本家のファイル（upstream を取り込むときは、ここの差分の「キー・フォーカス・読み上げ」を読む）:
//  - src/vs/base/browser/ui/toggle/toggle.ts の Checkbox（`div role="checkbox" tabindex="0" aria-checked`、Space・Enter で
//    切り替え、読み上げの名前は title）
//  - src/vs/base/browser/ui/toggle/toggle.css（`.monaco-checkbox` の大きさ・余白を paradisCheck.css で上書きする）
//
// 本家の Checkbox は地・文字・枠の色を inline の style で書くので、色は 1 つも渡さない（paradisCheck.css が描く）。
// 箱のフォーカスの枠は paradisFocusRing.css の `paradis-focus-ring`（キーボードのときだけ青）。横の文字を押しても切り替わる。

import './media/paradisCheck.css';
import { $, addDisposableListener, append, EventType } from '../../base/browser/dom.js';
import { Checkbox, ICheckboxStyles } from '../../base/browser/ui/toggle/toggle.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';

export interface IParadisCheckOptions {
	/** 横に出す文字。読み上げの名前にもなる。 */
	readonly label: string;
	readonly checked: boolean;
	readonly disabled?: boolean;
}

/** 箱は 16px。色は paradisCheck.css（inline の色を書かせない）。 */
const PARADIS_CHECKBOX_STYLES: ICheckboxStyles = {
	checkboxBackground: undefined,
	checkboxBorder: undefined,
	checkboxForeground: undefined,
	checkboxDisabledBackground: undefined,
	checkboxDisabledForeground: undefined,
	size: 16,
};

/** UI キットのチェック。利用者が切り替えたときだけ {@link onDidChange} が来る（{@link checked} の代入では来ない）。 */
export class ParadisCheck extends Disposable {

	/** 箱と文字を並べた入れ物（`.paradis-check`）。 */
	readonly element: HTMLElement;
	/** 横の文字。ホバーの文字（設定のキーなど）はここに付ける。 */
	readonly labelElement: HTMLElement;

	private readonly checkbox: Checkbox;

	private readonly _onDidChange = this._register(new Emitter<boolean>());
	/** 利用者が切り替えた後の状態。 */
	readonly onDidChange: Event<boolean> = this._onDidChange.event;

	constructor(parent: HTMLElement, options: IParadisCheckOptions) {
		super();
		this.element = append(parent, $('.paradis-check'));
		this.checkbox = this._register(new Checkbox(options.label, options.checked, PARADIS_CHECKBOX_STYLES));
		this.checkbox.domNode.classList.add('paradis-focus-ring');
		this.element.appendChild(this.checkbox.domNode);
		this.labelElement = append(this.element, $('span.paradis-check-label'));
		this.labelElement.textContent = options.label;
		// 文字は読み上げの名前に入っているので、読み上げでは二重に読ませない
		this.labelElement.setAttribute('aria-hidden', 'true');
		this.enabled = !options.disabled;

		this._register(this.checkbox.onChange(() => this._onDidChange.fire(this.checkbox.checked)));
		this._register(addDisposableListener(this.labelElement, EventType.CLICK, () => {
			if (!this.enabled) {
				return;
			}
			this.checkbox.checked = !this.checkbox.checked;
			this.checkbox.focus();
			this._onDidChange.fire(this.checkbox.checked);
		}));
	}

	get checked(): boolean {
		return this.checkbox.checked;
	}

	set checked(value: boolean) {
		this.checkbox.checked = value;
	}

	get enabled(): boolean {
		return this.checkbox.enabled;
	}

	set enabled(value: boolean) {
		if (value) {
			this.checkbox.enable();
		} else {
			this.checkbox.disable();
		}
		this.element.classList.toggle('disabled', !value);
	}

	/** Tab で止まる箱。 */
	get focusableElement(): HTMLElement {
		return this.checkbox.domNode;
	}

	focus(): void {
		this.checkbox.focus();
	}
}
