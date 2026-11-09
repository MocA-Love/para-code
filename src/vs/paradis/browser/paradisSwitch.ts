/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code の画面で使うオン/オフのスイッチ（1 種類、32×18、つまみ 14。行の高さ 28 に収まる）。Q537 の決定 2 の B、大きさは Q600 で決定。
// 画面ごとに書き起こしていたスイッチ（設定・使用量・通知・定期実行・共有など）は、これに置き換える。
// 複数から選ぶもの（項目のチェックの並び）はスイッチではなく本家のチェックボックスを使う。
//
// 中身は `<button role="switch" aria-checked>`。Space・Enter で切り替わるのはボタンの既定の動き。
// マウスで押した後のフォーカスの枠は `contrib/focusRing`（#608）が消し、Tab で移ったときだけ出る。
// 色は UI キットの役目の色（paradis.primary・paradis.fillNeutral など、paradisColors.ts）なので、テーマに合わせて変わる。
//
// 包んでいる本家のファイル: 無し。本家の Switch（src/vs/base/browser/ui/toggle/switch.ts）と同じ `button role="switch"`
// の形にそろえてあるが、本家の Switch はクリックの伝播を止める（行のクリックで開閉する画面が壊れる）ため包まない。
// upstream を取り込むときは、本家の Switch のキー・読み上げの変更をここへ写す。

import './media/paradisSwitch.css';
import { $, addDisposableListener, append, EventType } from '../../base/browser/dom.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';

export interface IParadisSwitchOptions {
	/** 最初の状態。 */
	readonly checked: boolean;
	/** 読み上げの名前。見えるラベルが別にある（`<label>` で包む、{@link ariaLabelledBy} を渡す）ときは省く。 */
	readonly ariaLabel?: string;
	/** 読み上げの名前にする要素の id（空白区切りで複数可）。行の見出しなど、包めない所にラベルがあるときに使う。 */
	readonly ariaLabelledBy?: string;
	/** 押せない状態で作る。 */
	readonly disabled?: boolean;
}

/** オン/オフのスイッチ。利用者が切り替えたときだけ {@link onDidChange} が来る（{@link checked} の代入では来ない）。 */
export class ParadisSwitch extends Disposable {

	readonly element: HTMLButtonElement;

	private readonly _onDidChange = this._register(new Emitter<boolean>());
	/** 利用者が切り替えた後の状態。 */
	readonly onDidChange: Event<boolean> = this._onDidChange.event;

	private _checked: boolean;

	constructor(parent: HTMLElement, options: IParadisSwitchOptions) {
		super();
		this.element = append(parent, $<HTMLButtonElement>('button.paradis-switch.paradis-focus-ring'));
		this.element.type = 'button';
		this.element.setAttribute('role', 'switch');
		if (options.ariaLabel) {
			this.element.setAttribute('aria-label', options.ariaLabel);
		}
		if (options.ariaLabelledBy) {
			this.element.setAttribute('aria-labelledby', options.ariaLabelledBy);
		}
		this._checked = options.checked;
		this.render();
		this.enabled = !options.disabled;
		this._register(addDisposableListener(this.element, EventType.CLICK, () => {
			if (this.element.disabled) {
				return;
			}
			this.checked = !this._checked;
			this._onDidChange.fire(this._checked);
		}));
	}

	get checked(): boolean {
		return this._checked;
	}

	set checked(value: boolean) {
		this._checked = value;
		this.render();
	}

	get enabled(): boolean {
		return !this.element.disabled;
	}

	set enabled(value: boolean) {
		this.element.disabled = !value;
	}

	private render(): void {
		this.element.setAttribute('aria-checked', String(this._checked));
		this.element.classList.toggle('checked', this._checked);
	}
}
