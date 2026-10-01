/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown / HTML ビューアの Rendered 表示で、スクロール位置を覚えて戻すための定義と、
// 文書の末尾に入れる補助スクリプト（スクロールの復元、検索で見つかった語の色）。
//
// 位置は webview 基盤（src/vs/workbench/contrib/webview/browser/pre/index.html）が `did-scroll` で
// 知らせてくる `scrollY / body.clientHeight` をそのまま使う。基盤が新しい webview の初回表示で
// 当てる `initialScrollProgress` と同じ単位なので、ここで別の物差しを作らない。
// 基盤が位置を当てるのは webview の初回表示だけで、同じ webview に別の文書を書き込んだときは
// 前の文書の位置を引き継いでしまう。そのため文書の末尾にスクロールを戻すスクリプトを入れる。

/** ビューアの view state（EditorMemento に保存する形）。 */
export interface IParadisViewerScrollState {
	/** `window.scrollY / document.body.clientHeight`。 */
	readonly scrollProgress: number;
}

/** 位置として使える値か確かめる（保存済みの値は古い版や壊れた値の可能性がある）。 */
export function paradisNormalizeScrollProgress(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	return Math.max(0, value);
}

/** EditorMemento やグループ間移動の options から受け取った view state を読む。 */
export function paradisReadViewerScrollState(value: unknown): IParadisViewerScrollState | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const scrollProgress = paradisNormalizeScrollProgress((value as { scrollProgress?: unknown }).scrollProgress);
	return scrollProgress === undefined ? undefined : { scrollProgress };
}

/**
 * 文書の末尾に入れる、スクロール位置を戻すスクリプト。
 *
 * 2 回当てる。1 回目は本文を読み終えた時点（スクリプトは末尾にあるので本文は組み上がっている）。
 * 2 回目は `load` の後で、画像が読み込まれて高さが変わった分と、基盤が `load` で前の文書の位置を
 * 引き継ぐ処理（index.html の `setInitialScrollPosition`）を上書きするため。基盤の `load` の処理は
 * このスクリプトより後に登録されるので、`setTimeout` で後ろへ回す。
 * それまでにユーザーが自分で動かしていたら 2 回目は当てない。
 */
export function paradisScrollRestoreScript(progress: number, nonce?: string): string {
	const target = paradisNormalizeScrollProgress(progress) ?? 0;
	const nonceAttribute = nonce ? ` nonce="${nonce}"` : '';
	return `<script${nonceAttribute}>(function(){try{var p=${target};var moved=false;function apply(){if(moved||!document.body){return;}window.scrollTo(window.scrollX,p*document.body.clientHeight);}['wheel','keydown','mousedown','touchstart'].forEach(function(t){window.addEventListener(t,function(){moved=true;},{capture:true,passive:true});});apply();window.addEventListener('load',function(){setTimeout(apply,0);});}catch(err){}})();</script>`;
}

/**
 * ページにフォーカスが無い間だけ、選択範囲を検索結果の色で描くスクリプト（文書の末尾に入れる）。
 *
 * 検索欄で探すと、見つかった語は webview の中で選択される（`window.find`。上流の webview と同じ）。
 * ところがフォーカスは検索欄にあるので、選択は Chromium の「非アクティブな選択」の薄い灰色で
 * 描かれ、白い背景の HTML ではほとんど見えない（見つかっていないように見える）。CSS だけでは
 * フォーカスの有無で選択の色を分けられないため、スクリプトで切り替える。ページにフォーカスが
 * あるとき（ユーザー自身が選んでいるとき）はページ本来の色のまま。
 *
 * `style-src` を nonce で絞っている文書（Markdown）では、作った `<style>` にも nonce が要る。
 */
export function paradisFindHighlightScript(nonce?: string): string {
	const nonceAttribute = nonce ? ` nonce="${nonce}"` : '';
	const styleNonce = nonce ? `s.setAttribute('nonce',${JSON.stringify(nonce)});` : '';
	return `<script${nonceAttribute}>(function(){try{var s=document.createElement('style');${styleNonce}s.textContent='::selection{background-color:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33))!important;}';function update(){if(document.hasFocus()){if(s.parentNode){s.parentNode.removeChild(s);}}else if(!s.parentNode){(document.head||document.documentElement).appendChild(s);}}window.addEventListener('focus',update);window.addEventListener('blur',update);update();}catch(err){}})();</script>`;
}
