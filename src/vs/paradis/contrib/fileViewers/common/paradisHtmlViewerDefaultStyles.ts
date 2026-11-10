/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML ビューアがページの <head> に足す既定のスタイルと、白い地の敷き方。
//
// webview の基盤（src/vs/workbench/contrib/webview/browser/pre/index.html の `@layer vscode-default`）は、body の文字を
// テーマの文字色（ダークでは明るい灰色）、リンクをテーマのリンク色（ダークでは水色）、インラインのコード・キー・引用を
// テーマの色にし、背景は透明にする。ビューアはエディタの背景が透けないよう、ブラウザと同じ白を敷いているので、色を
// 決めていないページの文字が白地の上で読めなくなる。そこで、白地に合わせた標準のブラウザの既定（文字は黒、リンクは青・
// 訪問済みは紫、コードは文字を受け継いで地なしの等幅）を、基盤の層より後の層で入れる。層の中の指定は、ページ自身の
// （層に入っていない）CSS に必ず負けるので、ページが決めた色はそのまま使われる。
//
// 白い地は `html` に敷く。ただしブラウザは、`html` の背景が透明なとき `body` の背景を画面全体に広げるので、`html` に
// 白があると `body` だけに背景を付けたページの本文より下が白くなる。ページが背景色を付けているときは、読み込んだ後に
// 白を外す（{@link paradisHtmlViewerCanvasScript}）。スクリプトを動かさない制限モードでは白のまま。

/** ビューアの既定の層の名前。基盤の `vscode-default` より後に並べる。 */
const LAYER = 'paradis-html-viewer-default';

/** 白い地の <style> の id（スクリプトが付け外しする）。 */
const CANVAS_STYLE_ID = 'paradis-html-viewer-canvas';

/**
 * ページの <head> に足す <style>。`zoom` は描画のときの倍率（ボタンの操作ではページの中で替える）。
 * `revert` は層の中ではブラウザの既定（user agent の指定）に戻す。
 */
export function paradisHtmlViewerHeadStyle(zoom: number): string {
	return `<style>@layer vscode-default, ${LAYER};`
		+ `@layer ${LAYER}{`
		+ `body{color:#000000;}a:link{color:#0000ee;}a:visited{color:#551a8b;}`
		+ `code,kbd{font-family:revert;color:revert;background-color:revert;padding:revert;border-radius:revert;}`
		+ `a code{color:revert;text-decoration:revert;}`
		+ `kbd{border:revert;box-shadow:revert;vertical-align:revert;}`
		+ `blockquote{background:revert;border-color:revert;}`
		+ `}`
		+ `html{zoom:${zoom};}</style>`
		+ `<style id="${CANVAS_STYLE_ID}">html{background-color:#ffffff;}</style>`;
}

/** 読み込んだ後に、ページが後から背景色を付けるのを待つ時間（SPA が描き終えるまで）。 */
export const PARADIS_HTML_VIEWER_CANVAS_WATCH_MS = 10_000;

/**
 * 白い地を、ページが `html` か `body` に背景色を付けているときに外すスクリプト（文書の末尾に入れる）。
 *
 * 見るのは背景色だけ。背景の画像だけのページで外すと、画像の外側にエディタの地が透け、黒い文字が読めなくなる。
 * 外部の CSS が後から効くこともあるので `load` でもう一度見る。SPA が後から背景を付けることもあるので、`load` の後
 * しばらく（{@link PARADIS_HTML_VIEWER_CANVAS_WATCH_MS}）`html`・`body` の style・class の変化を見て、背景色が付いたら
 * 外す。外したら、または時間が過ぎたら見るのをやめる。
 */
export function paradisHtmlViewerCanvasScript(): string {
	return `<script>(function(){try{var s=document.getElementById('${CANVAS_STYLE_ID}');if(!s){return;}`
		+ `function colored(e){return !/^(transparent|rgba\\(0, 0, 0, 0\\))$/.test(getComputedStyle(e).backgroundColor);}`
		+ `function check(){if(!s.parentNode||!document.body){return true;}s.disabled=true;var off=colored(document.documentElement)||colored(document.body);s.disabled=off;return off;}`
		+ `function watch(){if(check()||typeof MutationObserver!=='function'){return;}`
		+ `var o=new MutationObserver(function(){if(check()){o.disconnect();}});var opts={attributes:true,attributeFilter:['style','class']};`
		+ `o.observe(document.documentElement,opts);o.observe(document.body,opts);setTimeout(function(){o.disconnect();},${PARADIS_HTML_VIEWER_CANVAS_WATCH_MS});}`
		+ `check();if(document.readyState==='complete'){watch();}else{window.addEventListener('load',watch);}}catch(err){}})();</script>`;
}
