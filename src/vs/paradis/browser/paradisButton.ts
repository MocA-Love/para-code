/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 1（Q596）のボタン。主・副・素・危険・アイコンの 5 種。
//
// 包んでいる本家のファイル（upstream を取り込むときは、ここの差分の「キー・フォーカス・読み上げ」を読む）:
//  - src/vs/base/browser/ui/button/button.ts（DOM は `<a class="monaco-button" role="button" tabindex="0">`、
//    Enter・Space で押す、Escape で外す、無効のときクリックを止める）
//  - src/vs/base/browser/ui/button/button.css（`.monaco-text-button` の幅・余白・角丸を paradisButton.css で上書きする）
//
// 見た目は土台のトークン（paradisTokens.css の高さ・角丸・動き、paradis.* の色）だけで描く。本家の Button は
// 色を inline の style で書くので、色の引数（IButtonStyles）は 1 つも渡さない（渡すと mouseover のたびに
// inline の色が CSS に勝つ）。フォーカスの枠は paradisFocusRing.css の `paradis-focus-ring` が描く。
//
// ActionBar の 1 項目（タイトルバーのボタンなど）は、矢印キーの移動と読み上げを ActionBar に任せるため本家の
// Button を中に入れない（タブの止まりが 2 つになる）。その場合は paradisActionButton.ts で同じ見た目のクラスを付ける。

import './media/paradisButton.css';
import { $, reset } from '../../base/browser/dom.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { renderIcon } from '../../base/browser/ui/iconLabel/iconLabels.js';
import { IHoverDelegate } from '../../base/browser/ui/hover/hoverDelegate.js';
import { Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { ThemeIcon } from '../../base/common/themables.js';

/** ボタンの種類。主は 1 つの面に 1 つだけ。危険は消す・止めるなど戻せない操作。アイコンは文字の無い正方形。 */
export type ParadisButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';

/**
 * ボタンの見た目のクラス。本家の Button を包まない場所（ActionBar の項目）でも同じ見た目にするために公開する。
 * `small` は 24px（タイトルバー・ダイアログの見出しの閉じる）、既定は 28px。
 */
export function paradisButtonClasses(kind: ParadisButtonKind, small?: boolean): string[] {
	const classes = ['paradis-button', `paradis-button-${kind}`, 'paradis-focus-ring'];
	if (small) {
		classes.push('paradis-button-small');
	}
	return classes;
}

export interface IParadisButtonOptions {
	readonly kind: ParadisButtonKind;
	/** 文字のボタンの文字。アイコンのボタンでは使わない（`ariaLabel` を必ず渡す）。 */
	readonly label?: string;
	/** アイコンのボタンのアイコン（16px の codicon）。 */
	readonly icon?: ThemeIcon;
	/** 読み上げの名前。アイコンのボタンでは必須。 */
	readonly ariaLabel?: string;
	/** ホバーの文字。省くと出さない。 */
	readonly title?: string;
	readonly small?: boolean;
	readonly disabled?: boolean;
	readonly hoverDelegate?: IHoverDelegate;
}

/** UI キットのボタン。キーの扱いと読み上げは本家の Button のまま、見た目だけ土台のトークンで描く。 */
export class ParadisButton extends Disposable {

	private readonly button: Button;
	private _label: string | undefined;
	private _icon: ThemeIcon | undefined;

	constructor(parent: HTMLElement, options: IParadisButtonOptions) {
		super();
		this.button = this._register(new Button(parent, {
			title: options.title,
			// The label goes into spans, so a label that does not fit is cut with an ellipsis (paradisButton.css).
			supportIcons: true,
			ariaLabel: options.ariaLabel,
			disabled: options.disabled,
			hoverDelegate: options.hoverDelegate,
		}));
		this.button.element.classList.add(...paradisButtonClasses(options.kind, options.small));
		this._label = options.label;
		this._icon = options.icon;
		this._renderContent();
	}

	/**
	 * アイコンと文字を、ボタンの中の子の span として描く。アイコンを本家の `Button.icon` に渡すと、ボタンの要素
	 * そのものに codicon のクラスが付き、`.paradis-button` の `font-family: inherit` と読み込みの順で取り合って
	 * アイコンが四角（豆腐）になる。
	 *
	 * 文字は `$(…)` も含めてそのまま文字として出す（アイコンとして描くのはキットの `icon` だけ）。本家の `Button.label`
	 * に渡すと `$(…)` をアイコンとして読み、`escapeIcons()` しても前後の空白が詰められるので、中身は自分で描く。
	 * 文字が収まらないときは span ごと「…」で切れる（paradisButton.css）。
	 */
	private _renderContent(): void {
		if (this._label === undefined && !this._icon) {
			return;
		}
		const element = this.button.element;
		element.classList.add('monaco-text-button');
		const children: HTMLElement[] = [];
		if (this._icon) {
			children.push(renderIcon(this._icon));
		}
		if (this._label) {
			const text = $('span');
			text.textContent = this._label;
			children.push(text);
		}
		reset(element, ...children);
	}

	get element(): HTMLElement {
		return this.button.element;
	}

	get onDidClick(): Event<unknown> {
		return this.button.onDidClick;
	}

	set label(value: string) {
		this._label = value;
		this._renderContent();
	}

	set icon(value: ThemeIcon) {
		this._icon = value;
		this._renderContent();
	}

	get enabled(): boolean {
		return this.button.enabled;
	}

	set enabled(value: boolean) {
		this.button.enabled = value;
	}

	/** 切り替えのボタン（「日別」など）で選んでいる状態。 */
	set checked(value: boolean) {
		this.button.checked = value;
	}

	setAriaLabel(value: string): void {
		this.button.setAriaLabel(value);
	}

	focus(): void {
		this.button.focus();
	}
}
