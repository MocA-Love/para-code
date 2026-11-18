/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML のプレビュー差分の外枠の文書。左右なら 2 つ、1 列なら 1 つの iframe（srcdoc）にページを入れる。iframe の
// sandbox には `allow-scripts` を付けない（資料のコメントの外枠で、信頼していないワークスペースのページに付けるものと
// 同じ。paradisDocCommentFrameSandbox）。ページのスクリプトはどのワークスペースでも動かない。動くのは外枠の
// スクリプトだけで、iframe の中の文書に手を伸ばして、左右のスクロール合わせ・変更への移動・拡大・リンクとキーの
// 受け渡しをする（`allow-same-origin` なので外枠から中の文書を触れる）。
//
// 外枠には CSP を置かない。srcdoc の iframe は親の CSP を受け継ぐので、置くとページの `<style>` や配信サーバの
// CSS・画像まで止まる。

import { paradisDocCommentFrameSandbox } from '../../agentDocs/common/paradisDocCommentLayer.js';

/** 外枠からワークベンチへのメッセージの鍵（値は `link`・`key`）。 */
export const PARADIS_HTML_RENDERED_DIFF_MESSAGE_KEY = 'paradisHtmlRenderedDiff';

/** 外枠から届くキーの中身（webview の基盤が送るものと同じ形）。 */
export interface IParadisHtmlRenderedDiffKey {
	readonly type: string;
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly repeat: boolean;
}

/** 外枠から届くメッセージ。 */
export type ParadisHtmlRenderedDiffMessage =
	| { readonly type: 'link'; readonly href: string }
	| { readonly type: 'key'; readonly event: IParadisHtmlRenderedDiffKey };

export interface IParadisHtmlRenderedDiffFrameOptions {
	/** 左右のときの変更前のページ（1 列なら `undefined`）。 */
	readonly originalHtml: string | undefined;
	/** 変更後のページ（1 列なら印を重ねたページ）。 */
	readonly modifiedHtml: string;
	/** 左右の列の見出し。 */
	readonly labels: { readonly original: string; readonly modified: string };
	/** ワークベンチへのメッセージに付ける印。 */
	readonly token: string;
	/** 最初の拡大率。 */
	readonly zoom: number;
	/** `fromHost` の判定の関数式（paradisWebviewHostMessage.ts）。 */
	readonly fromHost: string;
	/** 変わった所の印の属性・左右の対応の印の属性。 */
	readonly changeAttribute: string;
	readonly anchorAttribute: string;
}

function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&  ]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** 外枠から届いたメッセージを読む（印が違うもの・形の違うものは `undefined`）。 */
export function paradisReadHtmlRenderedDiffMessage(message: unknown, token: string): ParadisHtmlRenderedDiffMessage | undefined {
	if (!message || typeof message !== 'object') {
		return undefined;
	}
	const data = message as { readonly token?: unknown; readonly [PARADIS_HTML_RENDERED_DIFF_MESSAGE_KEY]?: unknown; readonly href?: unknown; readonly event?: unknown };
	if (data.token !== token) {
		return undefined;
	}
	const type = data[PARADIS_HTML_RENDERED_DIFF_MESSAGE_KEY];
	if (type === 'link' && typeof data.href === 'string') {
		return { type, href: data.href };
	}
	if (type === 'key' && data.event && typeof data.event === 'object') {
		const event = data.event as Partial<IParadisHtmlRenderedDiffKey>;
		if (typeof event.type === 'string' && (event.type === 'keydown' || event.type === 'keyup') && typeof event.key === 'string' && typeof event.code === 'string' && typeof event.keyCode === 'number') {
			return {
				type, event: {
					type: event.type, key: event.key, code: event.code, keyCode: event.keyCode,
					shiftKey: !!event.shiftKey, altKey: !!event.altKey, ctrlKey: !!event.ctrlKey, metaKey: !!event.metaKey, repeat: !!event.repeat,
				}
			};
		}
	}
	return undefined;
}

/** 外枠の文書。 */
export function paradisHtmlRenderedDiffFrameDocument(options: IParadisHtmlRenderedDiffFrameOptions): string {
	const split = options.originalHtml !== undefined;
	const config = {
		sandbox: paradisDocCommentFrameSandbox(false),
		pages: split ? [options.originalHtml, options.modifiedHtml] : [options.modifiedHtml],
		zoom: options.zoom,
		change: options.changeAttribute,
		anchor: options.anchorAttribute,
	};
	const captions = split
		? `<div class="cap">${escapeHtml(options.labels.original)}</div><div class="cap cap-r">${escapeHtml(options.labels.modified)}</div>`
		: '';
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; }
#stage { display: grid; width: 100%; height: 100%; grid-template-columns: ${split ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)'}; grid-template-rows: ${split ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)'}; }
#stage > iframe { width: 100%; height: 100%; border: 0; background: transparent; visibility: hidden; }
#stage > iframe.r { box-shadow: inset 1px 0 0 var(--vscode-editorGroup-border); }
.cap { padding: 3px 12px; font: 11px/18px var(--vscode-font-family); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); box-shadow: 0 1px 0 var(--vscode-editorGroup-border); }
.cap-r { box-shadow: inset 1px 0 0 var(--vscode-editorGroup-border), 0 1px 0 var(--vscode-editorGroup-border); }
</style>
<script>(function(){try{
var T=${scriptJson(options.token)};
var self=document.currentScript;if(self&&self.parentNode){self.parentNode.removeChild(self);}
var api=typeof acquireVsCodeApi==='function'?acquireVsCodeApi():null;
var fromHost=${options.fromHost};
var O=${scriptJson(config)};
var K=${scriptJson(PARADIS_HTML_RENDERED_DIFF_MESSAGE_KEY)};
var frames=[],zoom=O.zoom,anchors=null,anchorsAt=0,syncing=null;
var nativeFind=window.find,nativeSelection=window.getSelection.bind(window);
function post(m){m.token=T;try{if(api){api.postMessage(m);}}catch(e){}}
function idoc(f){try{return f.contentDocument;}catch(e){return null;}}
function iwin(f){try{return f.contentWindow;}catch(e){return null;}}
// 検索と選択は変更後の側（1 列ならその 1 つ）へ向ける
function main(){return frames[frames.length-1];}
window.find=function(){var w=main()&&iwin(main());return w?w.find.apply(w,arguments):false;};
window.getSelection=function(){var w=main()&&iwin(main());return w?w.getSelection():nativeSelection();};
function copyVars(f){var d=idoc(f);if(!d||!d.documentElement){return;}var s=document.documentElement.style;for(var i=0;i<s.length;i++){var n=s[i];if(n.indexOf('--')===0){d.documentElement.style.setProperty(n,s.getPropertyValue(n));}}d.documentElement.style.zoom=String(zoom);}
function copyAll(){for(var i=0;i<frames.length;i++){copyVars(frames[i]);}anchors=null;}
try{new MutationObserver(copyAll).observe(document.documentElement,{attributes:true,attributeFilter:['style']});}catch(e){}
// 左右の対応の印の位置（文書の上からの位置）。画像の読み込みで動くので、古くなったら測り直す
function measure(){
var now=Date.now();if(anchors&&now-anchorsAt<500){return anchors;}
var left=positions(frames[0]),right=positions(frames[1]),list=[[0,0]];
for(var id in left){if(Object.prototype.hasOwnProperty.call(right,id)){list.push([left[id],right[id]]);}}
list.sort(function(a,b){return a[0]-b[0];});
var clean=[list[0]];for(var i=1;i<list.length;i++){var p=clean[clean.length-1];if(list[i][0]>=p[0]&&list[i][1]>=p[1]){clean.push(list[i]);}}
anchors=clean;anchorsAt=now;return clean;
}
function positions(f){var d=f&&idoc(f),w=f&&iwin(f),r={};if(!d||!w){return r;}var l=d.querySelectorAll('['+O.anchor+']');for(var i=0;i<l.length;i++){var id=l[i].getAttribute(O.anchor);if(!(id in r)){r[id]=l[i].getBoundingClientRect().top+w.scrollY;}}return r;}
// 片側のスクロール位置を、前後の対応の印の間の割合でもう片側へ写す
function map(y,from){
var list=measure(),a=from===0?0:1,b=1-a,lo=list[0],hi=null;
for(var i=0;i<list.length;i++){if(list[i][a]<=y){lo=list[i];}else{hi=list[i];break;}}
if(!hi){return lo[b]+(y-lo[a]);}
var span=hi[a]-lo[a];return span>0?lo[b]+(y-lo[a])*(hi[b]-lo[b])/span:lo[b];
}
function onScroll(index){return function(){
if(frames.length<2){return;}
if(syncing===index){syncing=null;return;}
var w=iwin(frames[index]),o=iwin(frames[1-index]);if(!w||!o){return;}
var y=map(w.scrollY,index);if(Math.abs(o.scrollY-y)<1){return;}
syncing=1-index;o.scrollTo(o.scrollX,y);
};}
function isMeta(e){return e.ctrlKey||e.metaKey;}
function onKey(e){if(!e.isTrusted){return;}if(e.type==='keydown'&&isMeta(e)&&[70,80,83,90,89].indexOf(e.keyCode)!==-1){e.preventDefault();}var m={event:{type:e.type,key:e.key,code:e.code,keyCode:e.keyCode,shiftKey:e.shiftKey,altKey:e.altKey,ctrlKey:e.ctrlKey,metaKey:e.metaKey,repeat:e.repeat}};m[K]='key';post(m);}
function onClick(f){return function(e){
if(!e.isTrusted||e.button!==0){return;}var d=idoc(f),w=iwin(f);if(!d||!w){return;}
var path=e.composedPath?e.composedPath():[];
for(var i=0;i<path.length;i++){var n=path[i];if(n&&n.tagName&&n.tagName.toLowerCase()==='a'&&n.href){
var raw=n.getAttribute('href')||'';e.preventDefault();
if(raw.charAt(0)==='#'){var t=d.getElementById(raw.slice(1));if(t){t.scrollIntoView();}else{w.scrollTo(0,0);}return;}
var m={href:String(n.href.baseVal||n.href)};m[K]='link';post(m);return;}}
// フォームの送信とボタンでページが移らないようにする
};}
function onSubmit(e){e.preventDefault();}
function bind(f,index){var w=iwin(f),d=idoc(f);if(!w||!d){return;}
w.addEventListener('scroll',onScroll(index),{passive:true});w.addEventListener('keydown',onKey);w.addEventListener('keyup',onKey);
w.addEventListener('click',onClick(f),true);d.addEventListener('submit',onSubmit,true);
w.addEventListener('resize',function(){anchors=null;});
}
function go(n){
var hit=null;
for(var i=0;i<frames.length;i++){var d=idoc(frames[i]);if(!d){continue;}
var old=d.querySelectorAll('.paradis-rdiff-current');for(var j=0;j<old.length;j++){old[j].classList.remove('paradis-rdiff-current');}
var t=d.querySelectorAll('['+O.change+'="'+n+'"]');for(var k=0;k<t.length;k++){t[k].classList.add('paradis-rdiff-current');}
if(t.length){t[0].scrollIntoView({block:'center'});if(hit===null){hit=i;}}}
// 片側にしか無い変更は、もう片側をスクロール合わせで追わせる
var other=hit!==null&&frames.length===2?idoc(frames[1-hit]):null;
if(other&&!other.querySelector('['+O.change+'="'+n+'"]')){syncing=null;onScroll(hit)();}
}
window.addEventListener('message',function(e){
if(!fromHost(e)){return;}var d=e.data;if(!d){return;}
if(typeof d.__paradisZoom==='number'){zoom=d.__paradisZoom;copyAll();return;}
if(typeof d.paradisRenderedDiffGo==='number'){go(d.paradisRenderedDiffGo);return;}
});
function start(){
var stage=document.getElementById('stage'),loaded=0;
O.pages.forEach(function(html,index){
var f=document.createElement('iframe');f.setAttribute('sandbox',O.sandbox);f.setAttribute('title','');
if(index===1){f.className='r';}
f.addEventListener('load',function(){copyVars(f);bind(f,index);f.style.visibility='visible';loaded++;anchors=null;},{once:true});
f.srcdoc=html;frames.push(f);stage.appendChild(f);
});
}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',start);}else{start();}
}catch(err){console.error('[paradis] html rendered diff frame failed',err);}})();</script>
</head>
<body>
<div id="stage">${captions}</div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}
