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
// - Tab と Shift+Tab は、モーダルの中の端で反対の端へ折り返す（幕の下の作業領域へフォーカスを逃がさない）。
//   背景に inert は付けない。モーダルから開くクイックピック・右クリックメニュー・確認ダイアログは作業領域の側の DOM にあるため
// - 同じウィンドウで別のモーダルを開いたら、前のものは閉じる（後から開いたものを前に出す）。
//   重なりの段はどのモーダルも同じ（vs/paradis/browser/paradisModal.ts の表）で、後から入れた幕が上に出る

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
	/**
	 * 開いているモーダルの中から開く入れ子の箱（Hub の中の辞書の編集など）。開いても、下のモーダルを閉じない。
	 * 別のモーダルが開いたときは、下のモーダルと一緒に閉じられる。
	 */
	readonly nested?: boolean;
	/**
	 * 閉じるときに、開く前にフォーカスがあった要素が描き直しで DOM から外れていたら、代わりに戻す先を返す
	 * （作り直された同じ役目のボタンなど）。省くと何もしない。
	 */
	readonly restoreFallback?: () => HTMLElement | undefined;
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

/** Tab で移れる要素（見えていて、無効でなく、tabIndex が 0 以上）を、`root` の中から文書の順に集める。 */
function collectTabbable(root: Element, result: HTMLElement[]): HTMLElement[] {
	for (const child of root.children) {
		if (!dom.isHTMLElement(child) || child.inert) {
			continue;
		}
		// 見えないもの（display: none の区画、hidden の入力欄）は矩形を持たない
		if (child.tabIndex >= 0 && (child as HTMLButtonElement).disabled !== true && child.getClientRects().length > 0) {
			result.push(child);
		}
		collectTabbable(child, result);
	}
	return result;
}

export class ParadisModalFocus extends Disposable {

	/** `element` と同じウィンドウに、fork のモーダルが開いているか（入れ子の箱で開くかを決めるのに使う）。 */
	static isModalOpenIn(element: HTMLElement): boolean {
		const targetWindow = dom.getWindow(element);
		return openModals.some(modal => modal.targetWindow === targetWindow);
	}

	private readonly previousFocus: HTMLElement | undefined;
	private lastFocusedIdentity: string | undefined;
	private closed = false;

	constructor(private readonly options: IParadisModalFocusOptions) {
		super();
		// 前に開いていたモーダルを閉じる（前のモーダルは自分の開く前の場所へフォーカスを戻す）。入れ子の箱は下を閉じない
		for (const other of options.nested ? [] : [...openModals]) {
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
		// Tab は端で折り返す。中の部品（エディタなど）が Tab を使ったときは触らないよう、泡立ちの段で受ける
		this._register(dom.addDisposableListener(this.targetWindow, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (e.defaultPrevented || e.isComposing || event.keyCode !== KeyCode.Tab || event.ctrlKey || event.altKey || event.metaKey || !this.isTopmost() || !this.ownsFocus()) {
				return;
			}
			this.wrapTab(event.shiftKey, e);
		}));
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

	/**
	 * Tab がモーダルの外へ出るところだけを止め、反対の端へ移す。端でなければブラウザに任せる。
	 * フォーカスがモーダル本体か BODY にあるときは、Tab で最初、Shift+Tab で最後へ移す。
	 */
	private wrapTab(backwards: boolean, e: KeyboardEvent): void {
		const doc = this.targetWindow.document;
		const active = doc.activeElement;
		const elements = collectTabbable(this.options.backdrop, []);
		if (elements.length === 0) {
			e.preventDefault();
			this.options.modal.focus();
			return;
		}
		const first = elements[0];
		const last = elements[elements.length - 1];
		const outsideList = !active || active === doc.body || !elements.includes(active as HTMLElement);
		if (outsideList && active && active !== doc.body && active !== this.options.modal) {
			// 一覧に載らない中の要素（部品の中の入力欄など）は、ブラウザの順に任せる
			return;
		}
		const target = outsideList ? (backwards ? last : first) : backwards && active === first ? last : !backwards && active === last ? first : undefined;
		if (target) {
			e.preventDefault();
			target.focus();
		}
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
	 * 閉じるときに呼ぶ。開く前にフォーカスがあった場所へ戻す（その場所が消えていたら、またはフォーカスが既にモーダルの外へ
	 * 移っていたら何もしない）。
	 * モーダルの外枠を DOM から外した後に呼ぶこと。
	 */
	restoreFocus(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		// モーダルの中から開いたエディタなど、閉じる前にフォーカスが外の場所へ移っていたら、そちらを残す
		const active = this.targetWindow.document.activeElement;
		if (dom.isHTMLElement(active) && active.isConnected && active !== this.targetWindow.document.body && !this.options.backdrop.contains(active)) {
			return;
		}
		const previous = this.previousFocus;
		if (previous?.isConnected && !this.options.backdrop.contains(previous)) {
			previous.focus();
		} else if (previous && !previous.isConnected) {
			this.options.restoreFallback?.()?.focus();
		}
	}

	override dispose(): void {
		this.restoreFocus();
		super.dispose();
	}
}
