/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 3（Q600）のポップアップ。ボタンの下に出る小さな面（見出しの行と本文）。
//
// 包んでいる本家のファイル（upstream を取り込むときは、ここの差分の「キー・フォーカス・読み上げ」を読む）:
//  - src/vs/base/browser/ui/contextview/contextview.ts（位置・画面の端での折り返し・外を押したら閉じる・重なりの段 2575）
//  - src/vs/platform/contextview/browser/contextViewService.ts（1 つずつ出す。別のメニューが開いたら閉じる）
// Esc で閉じるのはここで足す（ContextView は Esc を見ない）。閉じたらフォーカスを開いたボタンへ戻す。
//
// 今ある fork の小窓（paradisAnchoredPopover.ts、--paradis-z-popover の段）は、index.html の 10〜12 番の PR で
// 1 つずつこちらへ移す。ここで新しく作る小窓はこれを使う。

import './media/paradisPopover.css';
import { $, addDisposableListener, append, EventType, getActiveElement, isHTMLElement } from '../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../base/common/keyCodes.js';
import { DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { IContextViewService } from '../../platform/contextview/browser/contextView.js';

export interface IParadisPopoverOptions {
	/** 開いたボタン。この下に出し、閉じたらフォーカスを戻す。 */
	readonly anchor: HTMLElement;
	/** 見出し（省くと見出しの行を出さない）。読み上げの名前にもなる。 */
	readonly title?: string;
	/** 見出しが無いときの読み上げの名前。 */
	readonly ariaLabel?: string;
	/** 本文を描く。`store` は閉じたときに捨てる。開いたときにフォーカスする要素を返す（返さないと箱そのもの）。 */
	readonly render: (body: HTMLElement, store: DisposableStore) => HTMLElement | void;
	readonly onHide?: () => void;
}

/** キットのポップアップを開く。返り値を捨てると閉じる。 */
export function showParadisPopover(contextViewService: IContextViewService, options: IParadisPopoverOptions): IDisposable {
	let open = true;
	/** 描いた箱（onHide でフォーカスが中にあるかを見る）。 */
	let renderedBox: HTMLElement | undefined;
	contextViewService.showContextView({
		getAnchor: () => options.anchor,
		render: container => {
			const store = new DisposableStore();
			const box = renderedBox = append(container, $('.paradis-popover.paradis-focus-none'));
			box.setAttribute('role', 'dialog');
			box.tabIndex = -1;
			if (options.title) {
				append(box, $('.paradis-popover-head')).textContent = options.title;
				box.setAttribute('aria-label', options.title);
			} else if (options.ariaLabel) {
				box.setAttribute('aria-label', options.ariaLabel);
			}
			const body = append(box, $('.paradis-popover-body'));
			const focusTarget = options.render(body, store);
			store.add(addDisposableListener(box, EventType.KEY_DOWN, e => {
				if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
					e.preventDefault();
					e.stopPropagation();
					contextViewService.hideContextView();
				}
			}));
			// 開いたら中へフォーカスを移す（Esc を受けるため）
			(focusTarget ?? box).focus();
			return store;
		},
		onHide: () => {
			open = false;
			// ContextView は onHide を箱を隠す前に呼ぶので、Esc や項目の選択で閉じたときはまだ箱の中にフォーカスがある。
			// 箱の中か body にあるときだけ戻す（外を押して閉じたときは、押した先のフォーカスを奪わない）。
			const active = getActiveElement();
			if (!active || !isHTMLElement(active) || active === active.ownerDocument.body || renderedBox?.contains(active)) {
				options.anchor.focus();
			}
			options.onHide?.();
		},
	});
	return toDisposable(() => {
		if (open) {
			contextViewService.hideContextView();
		}
	});
}
