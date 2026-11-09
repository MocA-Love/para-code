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
import { Button } from '../../base/browser/ui/button/button.js';
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
		if (options.label !== undefined) {
			this.button.label = options.label;
		}
		if (options.icon) {
			this.button.icon = options.icon;
		}
	}

	get element(): HTMLElement {
		return this.button.element;
	}

	get onDidClick(): Event<unknown> {
		return this.button.onDidClick;
	}

	set label(value: string) {
		this.button.label = value;
	}

	set icon(value: ThemeIcon) {
		this.button.icon = value;
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
