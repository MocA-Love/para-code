/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの各セクションは `settingsService.onDidChange` を購読して自身のコンテナを
// dom.clearNode() で丸ごと再構築する。この再構築中に直前までフォーカスされていた要素
// （チェックボックス・セレクト等）がDOMから外れると、ブラウザがフォーカスを document.body へ
// 戻す副作用で祖先のスクロール可能要素（.pns-content）が先頭までスクロールされてしまう。
// 再描画の前後で該当スクロール位置を保存・復元することで、この意図しないジャンプを防ぐ。

import * as dom from '../../../../base/browser/dom.js';

/** `container` の祖先から最初に見つかったスクロール可能要素（.pns-contentを想定）を返す。 */
function findScrollHost(container: HTMLElement): HTMLElement | null {
	return container.closest<HTMLElement>('.pns-content');
}

/**
 * `render` の実行前後で `container` を含むスクロール可能な祖先の scrollTop を保存・復元する。
 */
export function paradisPreserveScroll(container: HTMLElement, render: () => void): void {
	const scrollHost = findScrollHost(container);
	const scrollTop = scrollHost?.scrollTop;
	render();
	if (scrollHost && scrollTop !== undefined) {
		scrollHost.scrollTop = scrollTop;
	}
}

/** {@link ParadisSectionFocusCarrier} が描き直しの後に同じ役目の要素を見つけるための印（`data-paradis-focus-key`）。 */
export function paradisSetFocusKey(element: HTMLElement, key: string): void {
	element.dataset.paradisFocusKey = key;
}

/**
 * 節を描き直す間、節の中にあったフォーカスを引き継ぐ。入れ子の箱（辞書の編集など）を閉じるとフォーカスは箱を開いた
 * ボタンへ戻るが、保存のあとの描き直しでそのボタンが作り直されると、フォーカスが body に落ちる。
 *
 * 描き直しの前に {@link capture}、描き終えたら {@link restore} を呼ぶ。一覧を後から（取得の後に）足す節は、
 * 同期の部分の後に `restore(false)`、一覧を足した後に `restore(true)` を呼ぶ。同じ印の要素へ戻し、
 * 最後まで見つからなければ節の最初のフォーカスできる要素（見出しの行のボタン）へ戻す。
 */
export class ParadisSectionFocusCarrier {

	private pendingKey: string | undefined;

	constructor(private readonly container: HTMLElement) { }

	/** フォーカスが節の中にあれば、その要素の印を覚える（印が無ければ節の中にあったことだけを覚える）。 */
	capture(): void {
		const active = dom.getActiveElement();
		if (dom.isHTMLElement(active) && this.container.contains(active)) {
			this.pendingKey = active.dataset.paradisFocusKey ?? '';
		}
	}

	/** 覚えた要素へフォーカスを戻す。`final` が false のときは、見つからなければ次の呼び出しまで待つ。 */
	restore(final: boolean): void {
		const key = this.pendingKey;
		if (key === undefined) {
			return;
		}
		const doc = this.container.ownerDocument;
		const active = doc.activeElement;
		// 描き直しの間に利用者がほかの場所へ移したフォーカスと、描き直しで消えなかった要素のフォーカスは、そのまま残す
		if (active && active !== doc.body && active.isConnected) {
			this.pendingKey = undefined;
			return;
		}
		const match = key ? [...this.container.querySelectorAll<HTMLElement>('[data-paradis-focus-key]')].find(element => element.dataset.paradisFocusKey === key) : undefined;
		if (match) {
			this.pendingKey = undefined;
			match.focus();
			return;
		}
		if (!final) {
			return;
		}
		this.pendingKey = undefined;
		const first = this.container.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"], input:not(:disabled)');
		first?.focus();
	}
}
