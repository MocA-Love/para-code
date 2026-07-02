/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの各セクションは `settingsService.onDidChange` を購読して自身のコンテナを
// dom.clearNode() で丸ごと再構築する。この再構築中に直前までフォーカスされていた要素
// （チェックボックス・セレクト等）がDOMから外れると、ブラウザがフォーカスを document.body へ
// 戻す副作用で祖先のスクロール可能要素（.pns-body）が先頭までスクロールされてしまう。
// 再描画の前後で該当スクロール位置を保存・復元することで、この意図しないジャンプを防ぐ。

/** `container` の祖先から最初に見つかったスクロール可能要素（.pns-bodyを想定）を返す。 */
function findScrollHost(container: HTMLElement): HTMLElement | null {
	return container.closest<HTMLElement>('.pns-body');
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
