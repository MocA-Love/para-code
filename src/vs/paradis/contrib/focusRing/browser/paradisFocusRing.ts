/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 本家の workbench は button・チェックボックス・select・[tabindex] の `:focus` に focusBorder の枠を付ける
// （src/vs/workbench/browser/media/style.css の Keyboard Focus Indication Styles）。`:focus` なので
// マウスで押した後も枠が残り、fork の画面の自前のボタンに水色の四角が出たままになる。
//
// fork の画面（クラスが `paradis-` か `para-` で始まる要素とその中）でフォーカスが入ったとき、
// キーボードのフォーカス（`:focus-visible`）でなければ印のクラスを付け、CSS（media/paradisFocusRing.css）で
// その間だけ枠を消す。CSS の接頭辞の属性セレクタ（[class*=" paradis-"]）は、どこかのクラスが変わるたびに
// 画面全体のスタイルを計算し直させるので hygiene が禁じている。判定は JS の classList で行い、CSS は
// 固定の印のクラスだけを見る。

import { addDisposableListener, EventType, isHTMLElement, isHTMLInputElement, isHTMLTextAreaElement } from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';

/** マウスなど、キーボード以外で入ったフォーカスの間だけ付く印。 */
export const PARADIS_POINTER_FOCUS_CLASS = 'paradis-pointer-focus';

const FORK_CLASS_PREFIXES = ['paradis-', 'para-'];

function isForkElement(element: Element): boolean {
	for (const name of element.classList) {
		if (name !== PARADIS_POINTER_FOCUS_CLASS && FORK_CLASS_PREFIXES.some(prefix => name.startsWith(prefix))) {
			return true;
		}
	}
	return false;
}

/** 要素自身かその祖先（`.monaco-workbench` まで）が fork の画面か。workbench の外は対象にしない。 */
function isInsideForkUi(element: Element): boolean {
	let forkFound = false;
	for (let current: Element | null = element; current; current = current.parentElement) {
		if (current.classList.contains('monaco-workbench')) {
			return forkFound;
		}
		if (!forkFound && isForkElement(current)) {
			forkFound = true;
		}
	}
	return false;
}

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit']);

/** 文字を入れる場所。マウスで入っても枠を残す（文字が入る場所を示す）。 */
function isTextEntry(element: Element): boolean {
	if (isHTMLTextAreaElement(element) || (isHTMLElement(element) && element.isContentEditable)) {
		return true;
	}
	return isHTMLInputElement(element) && !NON_TEXT_INPUT_TYPES.has(element.type);
}

/**
 * fork のダイアログやパネルが Esc を受けるために自分でフォーカスする入れ物（tabindex="-1"）。
 * キーボードで開いたときも枠は出さず、中の部品で出す。
 */
function isForkFocusContainer(element: Element): boolean {
	return element.getAttribute('tabindex') === '-1' && isForkElement(element);
}

/** 1 つの窓の文書で、fork の画面に入ったフォーカスに印を付け外しする。 */
export function installParadisFocusQuieting(targetWindow: Window): IDisposable {
	const store = new DisposableStore();
	store.add(addDisposableListener(targetWindow.document, EventType.FOCUS_IN, event => {
		const target = event.target;
		if (!isHTMLElement(target)) {
			return;
		}
		if (isForkFocusContainer(target) || (!isTextEntry(target) && !target.matches(':focus-visible') && isInsideForkUi(target))) {
			target.classList.add(PARADIS_POINTER_FOCUS_CLASS);
		}
	}, true));
	store.add(addDisposableListener(targetWindow.document, EventType.FOCUS_OUT, event => {
		const target = event.target;
		if (isHTMLElement(target)) {
			target.classList.remove(PARADIS_POINTER_FOCUS_CLASS);
		}
	}, true));
	return store;
}
