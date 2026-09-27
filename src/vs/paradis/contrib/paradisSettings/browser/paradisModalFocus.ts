/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork の自前モーダル（「設定 (Para Code)」・定期実行・スキル）に共通の、フォーカスと Esc と重なり順の扱い。
//
// - 開く前にフォーカスがあった場所を覚え、閉じたらそこへ戻す（戻さないと BODY に落ち、続けて打った文字が消える）
// - 中身を描き直してフォーカスが外れたら、押していたボタン（同じもの）かモーダル自身へ戻す
// - Esc はモーダルの中のどこにフォーカスがあっても、描き直しでフォーカスが BODY に落ちていても受ける。
//   ただし別の場所（確認ダイアログなど）にフォーカスがあるときは横取りしない
// - 同じウィンドウで別のモーダルを開いたら、前のものは閉じる（後から開いたものを前に出す）。
//   z-index の段（2570 / 2700 と、その間の確認ダイアログ 2575）はそのままにする

import * as dom from '../../../../base/browser/dom.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';

export interface IParadisModalFocusOptions {
	/** モーダルの外枠（背景）。重なり順の判断と、閉じたかどうかの判断に使う。 */
	readonly backdrop: HTMLElement;
	/** フォーカスを受けるモーダル本体（tabIndex=-1）。 */
	readonly modal: HTMLElement;
	/** Esc が押されたとき（既定の動作は呼び出し側が決める。編集の取り消しなど）。 */
	readonly onEscape: () => void;
	/** 別のモーダルが開いたときに、このモーダルを閉じる。 */
	readonly close: () => void;
}

/** 開いているモーダル（開いた順）。 */
const openModals: ParadisModalFocus[] = [];

/** フォーカスしていた要素を、描き直しの後に同じものとして見つけるための目印。 */
function identityOf(element: HTMLElement): string {
	return [
		element.tagName,
		element.className,
		element.getAttribute('aria-label') ?? '',
		(element.textContent ?? '').trim().slice(0, 80),
	].join('|');
}

/** `root` の中で、フォーカスを受けられる要素のうち `predicate` に合う最初のものを探す。 */
function findFocusable(root: HTMLElement, predicate: (element: HTMLElement) => boolean): HTMLElement | undefined {
	for (const child of root.children) {
		if (!dom.isHTMLElement(child)) {
			continue;
		}
		const focusable = child.tabIndex >= 0 || /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(child.tagName);
		if (focusable && predicate(child)) {
			return child;
		}
		const nested = findFocusable(child, predicate);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

export class ParadisModalFocus extends Disposable {

	private readonly previousFocus: HTMLElement | undefined;
	private lastFocusedIdentity: string | undefined;
	private closed = false;

	constructor(private readonly options: IParadisModalFocusOptions) {
		super();
		// 前に開いていたモーダルを閉じる（前のモーダルは自分の開く前の場所へフォーカスを戻す）
		for (const other of [...openModals]) {
			if (other.targetWindow === this.targetWindow) {
				other.options.close();
			}
		}
		const active = this.targetWindow.document.activeElement;
		this.previousFocus = dom.isHTMLElement(active) && active !== this.targetWindow.document.body ? active : undefined;
		openModals.push(this);
		this._register(toDisposable(() => {
			const index = openModals.indexOf(this);
			if (index >= 0) {
				openModals.splice(index, 1);
			}
		}));

		this._register(dom.addDisposableListener(options.modal, 'focusin', e => {
			if (dom.isHTMLElement(e.target) && e.target !== options.modal) {
				this.lastFocusedIdentity = identityOf(e.target);
			} else if (e.target === options.modal) {
				this.lastFocusedIdentity = undefined;
			}
		}));
		// Esc はウィンドウで先に受ける（描き直しで BODY に落ちたフォーカスからも閉じられるように）
		this._register(dom.addDisposableListener(this.targetWindow, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			// 日本語入力の変換中の Esc は変換の取り消しなので、モーダルを閉じない
			if (e.isComposing || event.keyCode !== KeyCode.Escape || !this.isTopmost() || !this.ownsFocus()) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			options.onEscape();
		}, true));
		// 描き直しでフォーカスしていた要素が消えたら、同じもの（無ければモーダル）へ戻す
		const observer = new MutationObserver(() => this.recoverFocus());
		observer.observe(options.modal, { childList: true, subtree: true });
		this._register(toDisposable(() => observer.disconnect()));
	}

	private get targetWindow(): Window & typeof globalThis {
		return dom.getWindow(this.options.modal);
	}

	private isTopmost(): boolean {
		const own = openModals.filter(candidate => candidate.targetWindow === this.targetWindow);
		return own[own.length - 1] === this;
	}

	/** フォーカスがこのモーダルの中にあるか、どこにも無い（BODY に落ちている）か。 */
	private ownsFocus(): boolean {
		const active = this.targetWindow.document.activeElement;
		return !active || active === this.targetWindow.document.body || this.options.backdrop.contains(active);
	}

	/** フォーカスが BODY に落ちていたら戻す。描き直しの直後に呼ばれる。 */
	recoverFocus(): void {
		if (this.closed || !this.isTopmost()) {
			return;
		}
		const doc = this.targetWindow.document;
		const active = doc.activeElement;
		if (active && active !== doc.body && active.isConnected) {
			return;
		}
		const identity = this.lastFocusedIdentity;
		const match = identity !== undefined ? findFocusable(this.options.modal, candidate => identityOf(candidate) === identity) : undefined;
		if (match) {
			match.focus();
			return;
		}
		this.options.modal.focus();
	}

	/**
	 * 閉じるときに呼ぶ。開く前にフォーカスがあった場所へ戻す（その場所が消えていたら何もしない）。
	 * モーダルの外枠を DOM から外した後に呼ぶこと。
	 */
	restoreFocus(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const previous = this.previousFocus;
		if (previous?.isConnected && !this.options.backdrop.contains(previous)) {
			previous.focus();
		}
	}

	override dispose(): void {
		this.restoreFocus();
		super.dispose();
	}
}
