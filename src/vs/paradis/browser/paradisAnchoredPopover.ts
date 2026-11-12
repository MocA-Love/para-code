/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ボタンなどに付いて開く小窓（ドロップダウン・ポップオーバー）に共通の、閉じる条件と行の移動。
//
// どの条件で閉じるかは小窓ごとに違う（ツールバーの一覧は窓の blur では閉じない、など）ので、呼び出し側が選ぶ。
// 外側かどうかは contains() だけで見る。`instanceof Node` は補助ウィンドウで realm が違って false になり得るので
// 使わない（その場合「外側」と誤判定して閉じてしまう）。
//
// 小窓の重なりの段はモーダルより上（paradisModal.ts の表）なので、fork のモーダルが開いたら必ず閉じる
// （{@link paradisCloseWhenModalOpens}。{@link paradisWatchPopoverDismiss} は常にこれを含む）。

import * as dom from '../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { PARADIS_MODAL_BACKDROP_CLASS } from './paradisModal.js';

export interface IParadisPopoverDismissOptions {
	/** 小窓の要素。この中の押下・スクロール・フォーカスは「内側」。 */
	readonly element: HTMLElement;
	/** 小窓を開いたボタン。この中の押下も「内側」（押し直しは開き直しの操作）。 */
	readonly anchor: HTMLElement | undefined;
	readonly close: () => void;
	/** ほかに「内側」とみなす押下（小窓から開いたメニューなど）。 */
	readonly isAlsoInside?: (target: Node) => boolean;
	/** 押下を window ではなく document の capture で受ける。 */
	readonly listenOnDocument?: boolean;
	/** 小窓の外のスクロールで閉じる（アンカーが動くと位置がずれたまま残るため。自分のスクロールでは閉じない）。 */
	readonly closeOnScroll?: boolean;
	/** 窓の大きさが変わったら閉じる。 */
	readonly closeOnResize?: boolean;
	/** 窓がフォーカスを失ったら閉じる。 */
	readonly closeOnBlur?: boolean;
	/** フォーカスが小窓とボタンの外へ移ったら閉じる（キー操作で別の場所へ移ったとき）。 */
	readonly closeOnFocusOut?: boolean;
}

/** 小窓の外側の押下（capture で拾い、ページ側の要素が伝播を止めても閉じる）と、選んだ条件で閉じる。 */
export function paradisWatchPopoverDismiss(targetWindow: Window, options: IParadisPopoverDismissOptions): IDisposable {
	const store = new DisposableStore();
	const isInside = (target: Node | null): boolean => !!target && (options.element.contains(target) || !!options.anchor?.contains(target) || !!options.isAlsoInside?.(target));
	if (options.closeOnFocusOut) {
		store.add(dom.addDisposableListener(options.element, dom.EventType.FOCUS_OUT, event => {
			const next = event.relatedTarget as Node | null;
			if (next && !options.element.contains(next) && !options.anchor?.contains(next)) {
				options.close();
			}
		}));
	}
	store.add(dom.addDisposableListener(options.listenOnDocument ? targetWindow.document : targetWindow, dom.EventType.MOUSE_DOWN, event => {
		if (!isInside(event.target as Node | null)) {
			options.close();
		}
	}, true));
	if (options.closeOnScroll) {
		store.add(dom.addDisposableListener(targetWindow, dom.EventType.SCROLL, event => {
			const target = event.target as Node | null;
			if (target && options.element.contains(target)) {
				return;
			}
			options.close();
		}, true));
	}
	if (options.closeOnResize) {
		store.add(dom.addDisposableListener(targetWindow, dom.EventType.RESIZE, () => options.close()));
	}
	if (options.closeOnBlur) {
		store.add(dom.addDisposableListener(targetWindow, dom.EventType.BLUR, () => options.close()));
	}
	store.add(paradisCloseWhenModalOpens(options.element, options.close));
	return store;
}

/** 開く・閉じる動きの印（paradisTokens.css）。小窓の要素に付ける。 */
export const PARADIS_POPOVER_MOTION_CLASS = 'paradis-popover-motion';

/**
 * 小窓の要素を外す。動きが有効なとき（作業領域の `monaco-enable-motion`）は、閉じる動き（`--paradis-motion-exit`）を
 * 見せてから外す。閉じた後の片付け（リスナー・フォーカスを戻す・開いている印）は呼び出し側が先に済ませる。
 * 外れるまでの間は押せない（paradisTokens.css の `paradis-popover-leaving`）。
 */
export function paradisRemovePopoverElement(element: HTMLElement): void {
	const targetWindow = dom.getWindow(element);
	const moving = element.isConnected && element.classList.contains(PARADIS_POPOVER_MOTION_CLASS) && element.closest('.monaco-workbench.monaco-enable-motion') !== null;
	const duration = moving ? parseFloat(targetWindow.getComputedStyle(element).getPropertyValue('--paradis-motion-exit')) : 0;
	if (!(duration > 0)) {
		element.remove();
		return;
	}
	element.classList.add('paradis-popover-leaving');
	targetWindow.setTimeout(() => element.remove(), duration);
}

/**
 * 小窓より下の段にある幕。fork のモーダル（{@link PARADIS_MODAL_BACKDROP_CLASS}）と、本家のモーダルのエディタ
 * （設定エディタなど、2540）。どちらも作業領域の直下に入る。
 */
const MODAL_BLOCK_CLASSES = [PARADIS_MODAL_BACKDROP_CLASS, 'monaco-modal-editor-block'];

/**
 * モーダル（{@link MODAL_BLOCK_CLASSES}）が同じ作業領域に開いたら、小窓を閉じる。
 * 小窓の段（`--paradis-z-popover`）はモーダルの段（`--paradis-z-modal`）より上なので、開いたまま残すと幕の上に浮く。
 * キーやコマンドでモーダルを開いたとき、小窓の項目からモーダルを開いたとき、モーダルが自分から開いたときのどれでも閉じる。
 * 小窓を作業領域（`.monaco-workbench`）の中へ入れた後に呼ぶ。小窓より後に開いた小窓・メニュー・確認では閉じない。
 */
export function paradisCloseWhenModalOpens(element: HTMLElement, close: () => void): IDisposable {
	const container = element.closest<HTMLElement>('.monaco-workbench');
	if (!container) {
		return Disposable.None;
	}
	// モーダルの幕は作業領域の直下に入る（layoutService.activeContainer.appendChild）ので、直下の出入りだけを見る。
	const observer = new (dom.getWindow(container).MutationObserver)(records => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (dom.isHTMLElement(node) && MODAL_BLOCK_CLASSES.some(className => node.classList.contains(className))) {
					close();
					return;
				}
			}
		}
	});
	observer.observe(container, { childList: true });
	return toDisposable(() => observer.disconnect());
}

/** 小窓の 1 行。 */
export interface IParadisPopoverRow {
	readonly element: HTMLElement;
	readonly run: () => void;
	/** 行に入ったときにフォーカスを渡す先（無ければ行そのもの）。 */
	readonly focusTarget?: HTMLElement;
}

/**
 * 小窓の行の一覧と、キーでの行の移動（上下・Home/End で移り、端で折り返す。Enter・Space で選ぶ。Tab は外へ逃がさず
 * 行を移る。Esc で閉じる）。行ごとに違う扱い（入力欄の中の Home など）は、呼び出し側が先に受けてから
 * {@link handleKeyDown} に渡す。
 */
export class ParadisPopoverRows<T extends IParadisPopoverRow> {

	readonly rows: T[] = [];
	private focusedIndex = 0;

	/** 今フォーカスのある行。 */
	get focused(): T | undefined {
		return this.rows[this.focusedIndex];
	}

	/** 行を足し、その位置を返す。 */
	add(row: T): number {
		this.rows.push(row);
		return this.rows.length - 1;
	}

	/** 開いた直後のフォーカス先は「今使っているもの」（`is-selected` の行）。無ければ先頭。 */
	focusInitial(): void {
		const selected = this.rows.findIndex(row => row.element.classList.contains('is-selected'));
		this.focus(selected >= 0 ? selected : 0, true);
	}

	/** 行に印（`is-focused`）を付ける。`moveFocus` なら DOM のフォーカスも移して見える所まで送る。 */
	focus(index: number, moveFocus: boolean): void {
		if (this.rows.length === 0) {
			return;
		}
		const wrapped = ((index % this.rows.length) + this.rows.length) % this.rows.length;
		this.focusedIndex = wrapped;
		for (const [position, row] of this.rows.entries()) {
			row.element.classList.toggle('is-focused', position === wrapped);
		}
		if (moveFocus) {
			const row = this.rows[wrapped];
			(row.focusTarget ?? row.element).focus();
			row.element.scrollIntoView({ block: 'nearest' });
		}
	}

	/** 共通のキーを扱う。 */
	handleKeyDown(keyboardEvent: StandardKeyboardEvent, close: () => void): void {
		switch (keyboardEvent.keyCode) {
			case KeyCode.Escape:
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				close();
				return;
			case KeyCode.DownArrow:
				keyboardEvent.preventDefault();
				this.focus(this.focusedIndex + 1, true);
				return;
			case KeyCode.UpArrow:
				keyboardEvent.preventDefault();
				this.focus(this.focusedIndex - 1, true);
				return;
			case KeyCode.Home:
				keyboardEvent.preventDefault();
				this.focus(0, true);
				return;
			case KeyCode.End:
				keyboardEvent.preventDefault();
				this.focus(this.rows.length - 1, true);
				return;
			case KeyCode.Enter:
			case KeyCode.Space:
				keyboardEvent.preventDefault();
				this.focused?.run();
				return;
			case KeyCode.Tab:
				// フォーカストラップ。Tab を外へ逃がすと、小窓が開いたままワークベンチ側の要素へフォーカスが移り、
				// 閉じ方が分からなくなる。
				keyboardEvent.preventDefault();
				this.focus(this.focusedIndex + (keyboardEvent.shiftKey ? -1 : 1), true);
				return;
			default:
				return;
		}
	}
}
