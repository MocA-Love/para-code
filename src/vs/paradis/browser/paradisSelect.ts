/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code の画面で使うプルダウン。OS の素の `<select>` の一覧ではなく、本家の SelectBox（設定エディタと同じ、
// テーマの色で描く一覧）で開く。macOS では SelectBox の既定が OS の一覧なので、本家の自動化のダイアログと同じく
// `window.menuStyle` に従う（既定の custom では描いた一覧、native に戻した人には OS の一覧）。設定は作るときに読むので、
// 変えたらモーダルを開き直したときに反映される。
//
// キーボード（↑↓・Enter・Esc・文字で選ぶ）と読み上げの名前は SelectBox が持つ。名前は `ariaLabel` で必ず渡す
// （`<label>` で包んでも、描いた一覧の側には届かない）。
//
// 一覧は本家のコンテキストビューに出る。その z-index は `2575 + layer` で、fork のモーダル（2570〜2850）より下に
// なることがあるので、{@link PARADIS_MODAL_POPUP_LAYER} でモーダルより上へ出す。

import './media/paradisSelect.css';
import { $, append } from '../../base/browser/dom.js';
import { ISelectOptionItem, SelectBox } from '../../base/browser/ui/selectBox/selectBox.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { defaultSelectBoxStyles } from '../../platform/theme/browser/defaultStyles.js';
import { hasNativeContextMenu } from '../../platform/window/common/window.js';

/**
 * fork のモーダルの中から開くメニュー・プルダウンの一覧に渡す layer。本家のコンテキストビューの z-index は
 * `2575 + layer` なので、2875 になり、fork のモーダルの最も上の段（エージェントの承認 2850）より上に出る。
 * `IContextMenuService.showContextMenu({ layer })` と SelectBox の `contextViewLayer` に渡す。
 */
export const PARADIS_MODAL_POPUP_LAYER = 300;

/** プルダウンの 1 項目。 */
export interface IParadisSelectOption {
	readonly value: string;
	readonly label: string;
}

export interface IParadisSelectOptions {
	/** 読み上げの名前。 */
	readonly ariaLabel: string;
	/** 中の `<select>` に付けるクラス（画面ごとの幅・高さの指定を残すため）。空白区切りで複数可。 */
	readonly className?: string;
}

/** Para Code の画面のプルダウン。利用者が選び直したときだけ {@link onDidChange} が来る（{@link value} の代入では来ない）。 */
export class ParadisSelect extends Disposable {

	/** SelectBox を描いた入れ物（`span.paradis-select`）。 */
	readonly element: HTMLElement;

	private readonly selectBox: SelectBox;
	/** SelectBox が閉じた状態の表示に使う `<select>`。 */
	private readonly nativeSelect: HTMLSelectElement | undefined;
	/** 呼び出し側が渡した選択肢。 */
	private base: readonly IParadisSelectOption[];
	/** 一覧に出している選択肢。渡された値が `base` に無いときは、その値を表す項目を末尾に足してある。 */
	private shown: readonly IParadisSelectOption[];
	private current: string | undefined;
	private _enabled = true;

	private readonly _onDidChange = this._register(new Emitter<string>());
	/** 利用者が選んだ値。 */
	readonly onDidChange: Event<string> = this._onDidChange.event;

	constructor(parent: HTMLElement, contextViewService: IContextViewService, configurationService: IConfigurationService, options: readonly IParadisSelectOption[], value: string | undefined, selectOptions: IParadisSelectOptions) {
		super();
		this.base = options;
		const resolved = paradisResolveSelectOptions(options, value);
		this.shown = resolved.shown;
		this.current = resolved.current;
		this.element = append(parent, $('span.paradis-select'));
		this.selectBox = this._register(new SelectBox(this.toItems(this.shown), this.indexOf(this.current), contextViewService, defaultSelectBoxStyles, {
			useCustomDrawn: !hasNativeContextMenu(configurationService),
			ariaLabel: selectOptions.ariaLabel,
			contextViewLayer: PARADIS_MODAL_POPUP_LAYER,
		}));
		this.selectBox.render(this.element);
		// SelectBox は render で入れ物の直下に `<select>` を置く
		this.nativeSelect = Array.from(this.element.children).find((child): child is HTMLSelectElement => child.tagName === 'SELECT');
		if (selectOptions.className) {
			this.nativeSelect?.classList.add(...selectOptions.className.split(' ').filter(name => name.length > 0));
		}
		this.syncNativeValues();
		this._register(this.selectBox.onDidSelect(e => {
			// SelectBox は選び直したときだけ知らせる（`HTMLSelectElement` の change と同じ）
			const option = this.shown[e.index];
			if (option) {
				this.current = option.value;
				this._onDidChange.fire(option.value);
			}
		}));
	}

	/** 選んでいる値。選択肢が無いときは空文字（`HTMLSelectElement.value` と同じ）。 */
	get value(): string {
		return this.current ?? '';
	}

	/** 値を選ぶ。選択肢に無い値は、その値を表す項目を足して選ぶ（{@link setOptions} と同じ）。 */
	set value(value: string) {
		this.apply(this.base, value);
	}

	/** 呼び出し側が渡した選択肢（今の値を表すために足した項目は含まない）。 */
	get values(): readonly IParadisSelectOption[] {
		return this.base;
	}

	/**
	 * 選択肢を入れ替える。`value` を渡すと、それを選ぶ。選択肢に無い値なら、その値を表す項目を足して選ぶ
	 * （先頭を選んだように見せると、先頭を選び直しても「変わっていない」扱いになり保存されないため）。
	 * `value` を省くと、今の値が新しい選択肢に残っていればそれを、無ければ先頭を選ぶ。
	 * 一覧に出す項目が同じなら作り直さない（開いている一覧を閉じない）。
	 *
	 * @returns 一覧に出す項目を入れ替えたか
	 */
	setOptions(options: readonly IParadisSelectOption[], value?: string): boolean {
		return this.apply(options, value ?? (options.some(option => option.value === this.current) ? this.current : undefined));
	}

	private apply(options: readonly IParadisSelectOption[], value: string | undefined): boolean {
		this.base = options;
		const resolved = paradisResolveSelectOptions(options, value);
		const same = resolved.shown.length === this.shown.length && resolved.shown.every((option, index) => option.value === this.shown[index].value && option.label === this.shown[index].label);
		this.shown = resolved.shown;
		this.current = resolved.current;
		if (same) {
			this.selectBox.select(this.indexOf(this.current));
			return false;
		}
		this.selectBox.setOptions(this.toItems(this.shown), this.indexOf(this.current));
		this.syncNativeValues();
		return true;
	}

	/** 選べる状態か。 */
	get enabled(): boolean {
		return this._enabled;
	}

	set enabled(enabled: boolean) {
		this._enabled = enabled;
		this.selectBox.setEnabled(enabled);
	}

	/** Tab で止まる要素（モーダルのフォーカスの巡回に入れる）。 */
	get focusableElement(): HTMLElement {
		return this.nativeSelect ?? this.element;
	}

	focus(): void {
		this.selectBox.focus();
	}

	/**
	 * SelectBox は中の `<option>` の value に表示名を入れる。表示名ではなく値を入れ直し、要素の value を
	 * 読む側（下書きの保存・テスト）にも、このプルダウンの値と同じものが見えるようにする。
	 */
	private syncNativeValues(): void {
		const nativeOptions = this.nativeSelect?.options;
		if (!nativeOptions) {
			return;
		}
		this.shown.forEach((option, index) => {
			const nativeOption = nativeOptions[index];
			if (nativeOption) {
				nativeOption.value = option.value;
			}
		});
	}

	private indexOf(value: string | undefined): number {
		return Math.max(0, this.shown.findIndex(option => option.value === value));
	}

	private toItems(options: readonly IParadisSelectOption[]): ISelectOptionItem[] {
		return options.map(option => ({ text: option.label }));
	}
}

/**
 * 一覧に出す選択肢と選ぶ値を決める。`value` が選択肢に無い空でない値なら、その値を表す項目（表示名は値そのもの）を
 * 末尾に足して選ぶ。`value` が無い・空なら先頭を選ぶ（空の値は「既定」などの選択肢として渡される）。
 */
function paradisResolveSelectOptions(options: readonly IParadisSelectOption[], value: string | undefined): { readonly shown: readonly IParadisSelectOption[]; readonly current: string | undefined } {
	if (value !== undefined && options.some(option => option.value === value)) {
		return { shown: options, current: value };
	}
	if (value) {
		return { shown: [...options, { value, label: value }], current: value };
	}
	return { shown: options, current: options[0]?.value };
}
