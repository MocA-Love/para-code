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
// その間だけ枠を消す。fork の画面の中にある本家の部品（検索の小窓・一覧など）にも効く。CSS の接頭辞の属性セレクタ（[class*=" paradis-"]）は、どこかのクラスが変わるたびに
// 画面全体のスタイルを計算し直させるので hygiene が禁じている。判定は JS の classList で行い、CSS は
// 固定の印のクラスだけを見る。
//
// フォーカスの枠の案 C（2026-11-09）: 文字の入力欄・検索欄・リストの行は、押しても出る灰色の枠（paradis.focusSubtle）にする。
// 部品は CSS の印のクラス（paradis-focus-subtle 等）で選ぶが、印の無い文字の入力欄（fork の画面の中の本家の InputBox など）も、
// フォーカスの間だけ paradis-text-focus を付けて灰色にする。

import { addDisposableListener, EventType, isHTMLElement, isHTMLInputElement, isHTMLTextAreaElement } from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';

/** マウスなど、キーボード以外で入ったフォーカスの間だけ付く印。 */
export const PARADIS_POINTER_FOCUS_CLASS = 'paradis-pointer-focus';

/** fork の画面の中の文字の入力欄に、フォーカスの間だけ付く印（灰色の枠）。 */
export const PARADIS_TEXT_FOCUS_CLASS = 'paradis-text-focus';

/** 押しても出る灰色の枠の印。マウスで入っても消さない。 */
const PARADIS_FOCUS_SUBTLE_CLASS = 'paradis-focus-subtle';

const MARKER_CLASSES = new Set([PARADIS_POINTER_FOCUS_CLASS, PARADIS_TEXT_FOCUS_CLASS]);

const FORK_CLASS_PREFIXES = ['paradis-', 'para-'];

function isForkElement(element: Element): boolean {
	for (const name of element.classList) {
		if (!MARKER_CLASSES.has(name) && FORK_CLASS_PREFIXES.some(prefix => name.startsWith(prefix))) {
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

const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);

/**
 * fork のダイアログの根元（role="dialog" 等で、Esc を受けるために自分でフォーカスする tabindex="-1" の入れ物）。
 * キーボードで開いたときも枠は出さず、中の部品で出す。矢印キーで動かす部品（roving tabindex）の
 * tabindex="-1" のボタンは対象にしない（矢印や Home・End で移ったときに枠が要る）。
 */
function isForkDialogRoot(element: Element): boolean {
	return element.getAttribute('tabindex') === '-1' && DIALOG_ROLES.has(element.getAttribute('role') ?? '') && isForkElement(element);
}

/** ハイコントラストのテーマでは、本家と同じくマウスのときも枠を出す。 */
function isHighContrast(element: Element): boolean {
	const workbench = element.closest('.monaco-workbench');
	return !!workbench && (workbench.classList.contains('hc-black') || workbench.classList.contains('hc-light'));
}

/** フォーカスが入った要素に印を付けるか。 */
function shouldQuietFocus(element: Element): boolean {
	if (isHighContrast(element) || isTextEntry(element) || element.classList.contains(PARADIS_FOCUS_SUBTLE_CLASS) || !isInsideForkUi(element)) {
		return false;
	}
	return isForkDialogRoot(element) || !element.matches(':focus-visible');
}

/** 1 つの窓の文書で、fork の画面に入ったフォーカスに印を付け外しする。 */
export function installParadisFocusQuieting(targetWindow: Window): IDisposable {
	const store = new DisposableStore();
	store.add(addDisposableListener(targetWindow.document, EventType.FOCUS_IN, event => {
		const target = event.target;
		if (!isHTMLElement(target)) {
			return;
		}
		// 付けるだけでなく外しもする（前のフォーカスの印が残っていると、キーボードで戻ったときに枠が出ない）。
		target.classList.toggle(PARADIS_POINTER_FOCUS_CLASS, shouldQuietFocus(target));
		target.classList.toggle(PARADIS_TEXT_FOCUS_CLASS, isTextEntry(target) && isInsideForkUi(target));
	}, true));
	store.add(addDisposableListener(targetWindow.document, EventType.FOCUS_OUT, event => {
		const target = event.target;
		if (isHTMLElement(target)) {
			target.classList.remove(PARADIS_POINTER_FOCUS_CLASS, PARADIS_TEXT_FOCUS_CLASS);
		}
	}, true));
	return store;
}
