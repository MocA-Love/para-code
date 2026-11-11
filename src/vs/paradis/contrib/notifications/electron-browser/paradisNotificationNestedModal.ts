/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の画面（ハブ）の中から開く入れ子の箱（辞書の新規作成・編集、着信音の取り込み）を、UI キットのダイアログの器で組む。
// 箱は paradisModal.ts の段（S・M）と見出しの帯・本文・下の帯。幕には入れ子の重なりの段（paradis-modal-backdrop-nested）を付ける。
// フォーカスの閉じ込めと Esc は各箱が ParadisModalFocus（nested: true）で持つ（閉じてよい条件が箱ごとに違うため）。

import './media/paradisNotificationNestedModal.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ParadisButtonKind, paradisButtonClasses } from '../../../browser/paradisButton.js';
import { IParadisModalHead, PARADIS_MODAL_BACKDROP_CLASS, PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';

const $ = dom.$;

const STR_CLOSE = localize('paradis.notif.nested.close', "閉じる");

let nextTitleId = 0;

export interface IParadisNotifNestedModal {
	/** 幕。開くときに layoutService.activeContainer へ足し、閉じるときに外す。 */
	readonly backdrop: HTMLElement;
	/** 箱（`.paradis-notif-nested-dialog`）。ParadisModalFocus に渡す。 */
	readonly modal: HTMLElement;
	readonly head: IParadisModalHead;
	/** 見出しの帯の閉じるボタン（押したときの処理は箱が付ける）。 */
	readonly close: HTMLButtonElement;
	/** スクロールする本文。 */
	readonly body: HTMLElement;
	/** 下の帯（取消・保存などのボタン）。 */
	readonly foot: HTMLElement;
}

/** 入れ子の箱の器を作る。中身は body と foot に置く。 */
export function paradisNotifNestedModal(size: ParadisModalSize, title: string, className?: string): IParadisNotifNestedModal {
	const backdrop = $(`.paradis-notif-nested-backdrop.${PARADIS_MODAL_BACKDROP_CLASS}.paradis-modal-backdrop-nested`);
	const modal = dom.append(backdrop, $('.paradis-notif-nested-dialog'));
	modal.classList.add(...paradisModalClasses(size));
	if (className) {
		modal.classList.add(className);
	}
	modal.tabIndex = -1;
	modal.setAttribute('role', 'dialog');
	modal.setAttribute('aria-modal', 'true');
	const head = renderParadisModalHead(modal, title);
	head.title.id = `paradis-notif-nested-title-${++nextTitleId}`;
	modal.setAttribute('aria-labelledby', head.title.id);
	// アイコンは中の span に置く（ボタンの要素に codicon を付けると、キットのボタンの font-family が字形を消す）
	const close = dom.append(head.actions, $<HTMLButtonElement>('button'));
	close.type = 'button';
	close.classList.add(...paradisButtonClasses('icon'));
	close.title = STR_CLOSE;
	close.setAttribute('aria-label', STR_CLOSE);
	dom.append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
	const body = dom.append(modal, $(`.${PARADIS_MODAL_BODY_CLASS}`));
	const foot = dom.append(modal, $(`.${PARADIS_MODAL_FOOT_CLASS}`));
	return { backdrop, modal, head, close, body, foot };
}

/**
 * 箱の中のキットの見た目のボタン（要素は素の `<button>`）。読み込みの間に押せる・押せない（`disabled`）と文言を
 * 替える場所で使う（後始末の要らない要素のまま）。押せない見た目は通知の CSS が `:disabled` で出す。
 */
export function paradisNotifNestedButton(parent: HTMLElement, kind: ParadisButtonKind, label: string): HTMLButtonElement {
	const button = dom.append(parent, $<HTMLButtonElement>('button'));
	button.type = 'button';
	button.classList.add(...paradisButtonClasses(kind));
	button.textContent = label;
	return button;
}
