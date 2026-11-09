/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code の画面で使うプルダウン。OS の素の `<select>` の一覧ではなく、本家の SelectBox（設定エディタと同じ、
// テーマの色で描く一覧）で開く。macOS では SelectBox の既定が OS の一覧なので、`useCustomDrawn` で常に描く側にする。
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
import { IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { defaultSelectBoxStyles } from '../../platform/theme/browser/defaultStyles.js';

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
	private options: readonly IParadisSelectOption[];
	private current: string | undefined;
	private _enabled = true;

	private readonly _onDidChange = this._register(new Emitter<string>());
	/** 利用者が選んだ値。 */
	readonly onDidChange: Event<string> = this._onDidChange.event;

	constructor(parent: HTMLElement, contextViewService: IContextViewService, options: readonly IParadisSelectOption[], value: string | undefined, selectOptions: IParadisSelectOptions) {
		super();
		this.options = options;
		this.current = this.pick(value);
		this.element = append(parent, $('span.paradis-select'));
		this.selectBox = this._register(new SelectBox(this.toItems(options), this.indexOf(this.current), contextViewService, defaultSelectBoxStyles, {
			useCustomDrawn: true,
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
			const option = this.options[e.index];
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

	/** 値を選ぶ。選択肢に無い値なら何もしない。 */
	set value(value: string) {
		const index = this.options.findIndex(option => option.value === value);
		if (index >= 0) {
			this.current = value;
			this.selectBox.select(index);
		}
	}

	/** 今の選択肢。 */
	get values(): readonly IParadisSelectOption[] {
		return this.options;
	}

	/**
	 * 選択肢を入れ替える。`value` を省くと、今の値が残っていればそれを、無ければ先頭を選ぶ。
	 * 並びも表示名も同じなら何もしない（開いている一覧を閉じない）。
	 *
	 * @returns 選択肢を入れ替えたか
	 */
	setOptions(options: readonly IParadisSelectOption[], value?: string): boolean {
		const same = options.length === this.options.length && options.every((option, index) => option.value === this.options[index].value && option.label === this.options[index].label);
		if (same) {
			if (value !== undefined) {
				this.value = value;
			}
			return false;
		}
		this.options = options;
		this.current = this.pick(value ?? this.current);
		this.selectBox.setOptions(this.toItems(options), this.indexOf(this.current));
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
		this.options.forEach((option, index) => {
			const nativeOption = nativeOptions[index];
			if (nativeOption) {
				nativeOption.value = option.value;
			}
		});
	}

	private pick(value: string | undefined): string | undefined {
		if (value !== undefined && this.options.some(option => option.value === value)) {
			return value;
		}
		return this.options[0]?.value;
	}

	private indexOf(value: string | undefined): number {
		return Math.max(0, this.options.findIndex(option => option.value === value));
	}

	private toItems(options: readonly IParadisSelectOption[]): ISelectOptionItem[] {
		return options.map(option => ({ text: option.label }));
	}
}
