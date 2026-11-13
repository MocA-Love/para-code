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
//   重なりの段はどのモーダルも同じ（vs/paradis/browser/paradisModal.ts の表）で、後から入れた幕が上に出る
// - Tab・Shift+Tab はモーダルの末尾と先頭で折り返す（折り返さないと背面のエディタやターミナルへ抜け、見えない所に打てる）。
//   巡る先は開くたびに DOM から集める（作った側が要素を登録しない。登録漏れで抜けないように）
// - 開いている間は背後のワークベンチ（モーダルを入れた入れ物の直下の作業領域）を inert にする（Q644）。クリック・Tab・読み上げが
//   背後へ出ない。本家の浮く部品（quick input・メニュー・確認・通知・ホバー）は同じ入れ物の直下にあってもモーダルの中から
//   使うので inert にしない。native の dialog（showModal）にしないのは、top layer に入って本家の浮く部品がモーダルの下に隠れるため

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

/**
 * モーダルの背後として inert にする要素。モーダルを入れた入れ物の直下の、本家の作業領域だけを選ぶ（主ウィンドウの部品の格子、
 * 別ウィンドウの各部品、本家のモーダルのエディタ）。quick input・コンテキストビュー・通知・確認・ホバーは自分で inert を切り替える
 * ものもあり、モーダルの中から開いて使うので選ばない。
 */
const BACKGROUND_CLASSES = ['monaco-grid-view', 'part', 'monaco-modal-editor-block'];

/** inert にした背後の要素ごとの、持っているモーダルの数（入れ子の箱が重なっても、最後の 1 つが閉じるまで外さない）。 */
const backgroundHolders = new Map<HTMLElement, number>();

/** フォーカスしていた要素を、描き直しの後に同じものとして見つけるための目印。 */
function identityOf(element: HTMLElement): string {
	return [
		element.tagName,
		element.className,
		element.getAttribute('aria-label') ?? '',
		(element.textContent ?? '').trim().slice(0, 80),
	].join('|');
}

/** `element` が Tab で巡る先か（無効・非表示・tabIndex が負のものは除く）。 */
function isTabbable(element: HTMLElement): boolean {
	if (element.tabIndex < 0) {
		return false;
	}
	const native = /^(BUTTON|INPUT|SELECT|TEXTAREA|IFRAME)$/.test(element.tagName) || (element.tagName === 'A' && element.hasAttribute('href'));
	if (!native && !element.hasAttribute('tabindex') && !element.isContentEditable) {
		return false;
	}
	if ((element as HTMLButtonElement).disabled || (dom.isHTMLInputElement(element) && element.type === 'hidden')) {
		return false;
	}
	return element.getClientRects().length > 0;
}

/** `root` の中で、Tab で巡る要素を文書の順に集める（inert の中は飛ばす）。 */
function collectTabbables(root: HTMLElement, result: HTMLElement[] = []): HTMLElement[] {
	for (const child of root.children) {
		if (!dom.isHTMLElement(child) || child.inert) {
			continue;
		}
		if (isTabbable(child)) {
			result.push(child);
		}
		collectTabbables(child, result);
	}
	return result;
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

	/** `element` と同じウィンドウに、fork のモーダルが開いているか（入れ子の箱で開くかを決めるのに使う）。 */
	static isModalOpenIn(element: HTMLElement): boolean {
		const targetWindow = dom.getWindow(element);
		return openModals.some(modal => modal.targetWindow === targetWindow);
	}

	private readonly previousFocus: HTMLElement | undefined;
	private lastFocusedIdentity: string | undefined;
	private closed = false;
	/** このモーダルが inert にした背後の要素（未だ付けていなければ undefined）。 */
	private heldBackground: HTMLElement[] | undefined;

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
		// 背後の inert は、開く前のフォーカスを覚えた後に付ける（先に付けるとフォーカスが BODY に落ちる）。
		// 外枠をこの後で入れ物へ入れる呼び出し側もあるので、まだ入っていなければ同じ処理の終わりに付ける
		if (options.backdrop.isConnected) {
			this.holdBackground();
		} else {
			queueMicrotask(() => this.holdBackground());
		}

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
		// Tab は泡立ちで受ける（中のエディタなどが Tab を自分で使ったとき＝preventDefault 済みには手を出さない）
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

	/** 先頭より前へ Shift+Tab、末尾より後へ Tab で出ようとしたら反対の端へ移す。それ以外はブラウザの順送りに任せる。 */
	private wrapTab(backwards: boolean, e: KeyboardEvent): void {
		const tabbables = collectTabbables(this.options.backdrop);
		const doc = this.targetWindow.document;
		const active = doc.activeElement;
		let target: HTMLElement | undefined;
		if (tabbables.length === 0) {
			target = this.options.modal;
		} else if (!active || active === doc.body) {
			target = backwards ? tabbables[tabbables.length - 1] : tabbables[0];
		} else {
			// 今の場所より後（Shift+Tab なら前）に巡る先が無ければ、ブラウザはモーダルの外へ出す
			const bit = backwards ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
			const hasNext = tabbables.some(candidate => candidate !== active && (active.compareDocumentPosition(candidate) & bit) !== 0);
			if (!hasNext) {
				target = backwards ? tabbables[tabbables.length - 1] : tabbables[0];
			}
		}
		if (!target) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		target.focus();
	}

	/** 外枠を入れた入れ物の直下の作業領域を inert にする。元から inert だった要素（別の持ち主）には触らない。 */
	private holdBackground(): void {
		const container = this.options.backdrop.parentElement;
		if (this.closed || this.heldBackground || !container) {
			return;
		}
		const held: HTMLElement[] = [];
		for (const element of container.children) {
			if (!dom.isHTMLElement(element) || !BACKGROUND_CLASSES.some(className => element.classList.contains(className))) {
				continue;
			}
			const count = backgroundHolders.get(element);
			if (count === undefined) {
				if (element.inert) {
					continue;
				}
				element.inert = true;
			}
			backgroundHolders.set(element, (count ?? 0) + 1);
			held.push(element);
		}
		this.heldBackground = held;
	}

	/** {@link holdBackground} で付けた inert を外す（ほかのモーダルがまだ持っている要素は残す）。 */
	private releaseBackground(): void {
		for (const element of this.heldBackground ?? []) {
			const count = backgroundHolders.get(element) ?? 1;
			if (count <= 1) {
				backgroundHolders.delete(element);
				element.inert = false;
			} else {
				backgroundHolders.set(element, count - 1);
			}
		}
		this.heldBackground = [];
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
		// 戻す先が背後の作業領域にあるので、先に inert を外す（外さないと focus() が効かず BODY に落ちる）
		this.releaseBackground();
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
