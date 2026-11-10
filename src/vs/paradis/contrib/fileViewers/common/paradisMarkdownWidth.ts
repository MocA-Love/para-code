/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアの本文の幅（読みやすい 882 / 広い 1280 / 全幅）。
//
// 882 は本家の Markdown プレビューの CSS（markdownDocumentRenderer.ts の `body { max-width: 882px }`）から来ている。
// 本家の CSS はそのまま読み込み、ページの `<html>` に付けたクラスで `body` の max-width を上書きする（本家のファイルは触らない）。
// 描くときはクラスを HTML に焼き込み、帯で替えたときはズームと同じ postMessage でページのクラスを付け替える。
// 付け替えると本文の高さが変わるので、ページの中で見ていた要素（見出し・段落など）の位置を保つ。

import { PARADIS_VIEWER_BODY_ROOT_ID } from './paradisViewerBodySwap.js';
import { PARADIS_WEBVIEW_HOST_MESSAGE_CHECK } from './paradisWebviewHostMessage.js';

export type ParadisMarkdownWidth = 'readable' | 'wide' | 'full';

/** 帯とメニューに並べる順。 */
export const PARADIS_MARKDOWN_WIDTHS: readonly ParadisMarkdownWidth[] = ['readable', 'wide', 'full'];

/** 既定の幅の設定。 */
export const PARADIS_MARKDOWN_WIDTH_SETTING = 'paradis.markdownViewer.width';

/** 設定が無い・壊れているときの幅（本家と同じ 882）。 */
export const PARADIS_MARKDOWN_DEFAULT_WIDTH: ParadisMarkdownWidth = 'readable';

/** 文字の列の最大幅（px）。全幅は上限なし。 */
export const PARADIS_MARKDOWN_WIDTH_PX: { readonly [K in ParadisMarkdownWidth]: number | undefined } = {
	readable: 882,
	wide: 1280,
	full: undefined,
};

/** 幅として使える値か確かめる（保存した値・設定の値は古い版や手で書いた値の可能性がある）。 */
export function paradisNormalizeMarkdownWidth(value: unknown): ParadisMarkdownWidth | undefined {
	return typeof value === 'string' && (PARADIS_MARKDOWN_WIDTHS as readonly string[]).includes(value) ? value as ParadisMarkdownWidth : undefined;
}

/** いま使う幅。帯でこのファイルに選んだ幅 → 設定の既定 → 882 の順。 */
export function paradisResolveMarkdownWidth(chosen: unknown, setting: unknown): ParadisMarkdownWidth {
	return paradisNormalizeMarkdownWidth(chosen) ?? paradisNormalizeMarkdownWidth(setting) ?? PARADIS_MARKDOWN_DEFAULT_WIDTH;
}

/** ページの `<html>` に付けるクラス。 */
export function paradisMarkdownWidthClass(width: ParadisMarkdownWidth): string {
	return `paradis-md-width-${width}`;
}

/**
 * 本家の `body { max-width: 882px }` を上書きする CSS。`html.<クラス> body` は `body` だけの指定より強いので、
 * 本家の CSS との並び順に左右されない。
 */
export const PARADIS_MARKDOWN_WIDTH_STYLES = PARADIS_MARKDOWN_WIDTHS.map(width => {
	const px = PARADIS_MARKDOWN_WIDTH_PX[width];
	return `html.${paradisMarkdownWidthClass(width)} body { max-width: ${px === undefined ? 'none' : `${px}px`}; }`;
}).join('\n');

const WIDTH_MESSAGE_KEY = '__paradisMarkdownWidth';

/** ページへ送る、幅を替えるメッセージ。 */
export function paradisMarkdownWidthMessage(width: ParadisMarkdownWidth): { readonly [WIDTH_MESSAGE_KEY]: ParadisMarkdownWidth } {
	return { [WIDTH_MESSAGE_KEY]: width };
}

/**
 * 幅のメッセージを受けてクラスを付け替えるページ内スクリプト。
 *
 * 付け替える前に、画面の中で一番上から始まる要素（見出し・段落など。画面の上端をまたぐ大きな要素しか無ければ
 * それ）の上端の位置を測り、付け替えた後に同じ位置へ戻す。`html` に CSS の zoom が掛かっていると要素の位置とスクロールの量の単位がずれることがあるので、
 * 1 回目のスクロールで動いた量から比を求めてもう 1 回だけ合わせる。一番上にいるときは何もしない。
 * 付け替えた直後の数フレームは Chromium のスクロールの固定（overflow-anchor）を止める。止めないと、Chromium が
 * 自分で選んだ別の要素に合わせてもう一度動かし、zoom が掛かっているときに見ていた位置がずれる。
 */
export function paradisMarkdownWidthScript(nonce: string): string {
	const classes = PARADIS_MARKDOWN_WIDTHS.map(width => `'${width}':'${paradisMarkdownWidthClass(width)}'`).join(',');
	return `<script nonce="${nonce}">(function(){try{var fromHost=${PARADIS_WEBVIEW_HOST_MESSAGE_CHECK};var classes={${classes}};var BLOCKS='h1,h2,h3,h4,h5,h6,p,li,pre,tr,blockquote,img,hr,dt,dd,summary,.paradis-mermaid';
function anchor(){if(window.scrollY<=0){return null;}var root=document.getElementById('${PARADIS_VIEWER_BODY_ROOT_ID}');if(!root){return null;}var list=root.querySelectorAll(BLOCKS);var cross=null;for(var i=0;i<list.length;i++){var el=list[i];var r=el.getBoundingClientRect();if(r.bottom<=0){continue;}if(r.top>=0){return r.top<window.innerHeight||!cross?el:cross;}if(!cross||cross.contains(el)){cross=el;}}return cross;}
function apply(width){var name=classes[width];if(!name){return;}var html=document.documentElement;var el=anchor();var before=el?el.getBoundingClientRect().top:0;html.style.overflowAnchor='none';requestAnimationFrame(function(){requestAnimationFrame(function(){html.style.overflowAnchor='';});});for(var k in classes){html.classList.remove(classes[k]);}html.classList.add(name);if(!el){return;}var d=el.getBoundingClientRect().top-before;if(Math.abs(d)<0.5){return;}window.scrollBy(0,d);var d2=el.getBoundingClientRect().top-before;if(Math.abs(d2)>=0.5&&d!==d2){window.scrollBy(0,d2*d/(d-d2));}}
window.addEventListener('message',function(e){if(!fromHost(e)){return;}var d=e.data;if(d&&typeof d.${WIDTH_MESSAGE_KEY}==='string'){apply(d.${WIDTH_MESSAGE_KEY});}});}catch(err){}})();</script>`;
}
