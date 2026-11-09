/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 4（Q600）の切り替えの組。よく替える少数の選択肢（期間など）を 1 つの組に並べ、選んだものを浮かせる。
// 選択肢が多いもの・たまにしか替えないものはプルダウン（paradisSelect.ts）にする。
//
// 包んでいる本家のファイル: 無し（base に切り替えの組の部品が無い）。中身は `button` の並びで、選んでいるものは
// `aria-pressed="true"`（押されたボタン）。Tab で 1 つずつ止まり、Space・Enter で選ぶのはボタンの既定の動き。
// タブ（tablist）にはしない（対応する tabpanel が無いため）。

import './media/paradisSegmented.css';
import { $, addDisposableListener, append, EventType } from '../../base/browser/dom.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';

export interface IParadisSegmentedItem<T extends string> {
	readonly value: T;
	readonly label: string;
}

export interface IParadisSegmentedOptions<T extends string> {
	readonly items: readonly IParadisSegmentedItem<T>[];
	/** 選んでいる値。どれも選んでいないときは undefined（「ほかの期間」をプルダウンで選んだときなど）。 */
	readonly value: T | undefined;
	/** 組の読み上げの名前。 */
	readonly ariaLabel: string;
}

/** 切り替えの組。利用者が押したときだけ {@link onDidChange} が来る（{@link value} の代入では来ない）。 */
export class ParadisSegmented<T extends string> extends Disposable {

	readonly element: HTMLElement;

	private readonly buttons = new Map<T, HTMLButtonElement>();
	private _value: T | undefined;

	private readonly _onDidChange = this._register(new Emitter<T>());
	readonly onDidChange: Event<T> = this._onDidChange.event;

	constructor(parent: HTMLElement, options: IParadisSegmentedOptions<T>) {
		super();
		this.element = append(parent, $('.paradis-seg'));
		this.element.setAttribute('role', 'group');
		this.element.setAttribute('aria-label', options.ariaLabel);
		for (const item of options.items) {
			const button = append(this.element, $<HTMLButtonElement>('button.paradis-focus-ring-inset'));
			button.type = 'button';
			button.textContent = item.label;
			this.buttons.set(item.value, button);
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				if (button.disabled) {
					return;
				}
				const changed = this._value !== item.value;
				this.value = item.value;
				if (changed) {
					this._onDidChange.fire(item.value);
				}
			}));
		}
		this.value = options.value;
	}

	get value(): T | undefined {
		return this._value;
	}

	set value(value: T | undefined) {
		this._value = value;
		for (const [itemValue, button] of this.buttons) {
			button.setAttribute('aria-pressed', String(itemValue === value));
		}
	}

	/** 1 つの選択肢を押せる・押せない状態にする。押せない理由は `title` に出す。 */
	setItemEnabled(value: T, enabled: boolean, title?: string): void {
		const button = this.buttons.get(value);
		if (button) {
			button.disabled = !enabled;
			button.title = title ?? '';
		}
	}
}
