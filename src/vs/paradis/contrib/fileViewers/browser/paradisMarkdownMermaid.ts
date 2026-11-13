/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアの Mermaid 対応。```mermaid``` コードブロックを `<pre class="mermaid">`（生テキスト、
// HTML エスケープ済み）に変換する marked 拡張と、vendored mermaid.js（media/mermaid/mermaid.min.js、
// MIT）を webview へ読み込むためのヘルパーをまとめる。実際の SVG 描画は webview 内で mermaid.js 自身が
// 行う（`paradisMarkdownFileEditor.ts` が `allowScripts` を有効にして呼び出す）。

import * as marked from '../../../../base/common/marked/marked.js';
import { escape } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/** vendored mermaid.js の配置ディレクトリ。 */
const MERMAID_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/browser/media/mermaid' as const;

/** ```mermaid``` コードブロックを図として描画し直すための marked 拡張。 */
export function markedMermaidExtension(): marked.MarkedExtension {
	return {
		renderer: {
			code({ text, lang, escaped }) {
				if (lang?.trim().toLowerCase() !== 'mermaid') {
					// フォールバック（既存のシンタックスハイライト用 renderer）に処理を譲る。
					return false;
				}
				// `markdownDocumentRenderer.ts` 側で mermaid ブロックはハイライトをスキップし生テキストを
				// 返すため、通常は `escaped` は false（未エスケープ）。念のためどちらの経路でも安全に扱う。
				const raw = escaped ? text : escape(text);
				return `<pre class="paradis-mermaid mermaid">${raw}</pre>`;
			},
		},
	};
}

/** レンダリング済み HTML に mermaid ブロックが含まれるか（含まれない文書で mermaid.js を読み込む無駄を避ける）。 */
export function containsParadisMermaidBlock(html: string): boolean {
	return html.includes('class="paradis-mermaid mermaid"');
}

/** 本文を差し替えた後に、新しい本文の Mermaid の図を描く（ページの mermaid は初回の読み込みで初期化済み）。 */
// 描き終えたら（一部の図が失敗しても）、描けた図に「拡大」のボタンを付ける（paradisMermaidZoomScript）。
// 本文を差し替えたので、前の本文の図を出している拡大の窓は閉じる。
export const PARADIS_MERMAID_RERUN_SCRIPT = `try{if(window.__paradisMermaidZoom){window.__paradisMermaidZoom.close();}if(window.mermaid){var run=mermaid.run({querySelector:'.paradis-mermaid'});var done=function(){if(window.__paradisMermaidZoom){window.__paradisMermaidZoom.decorate();}};if(run&&run.then){run.then(done,function(err){console.error('[paradis] mermaid render failed',err);done();});}else{done();}}}catch(err){console.error('[paradis] mermaid render failed',err);}`;

/** 拡大の窓の文言（ビューアの側で nls から作って渡す）。 */
export interface IParadisMermaidZoomLabels {
	readonly expand: string;
	readonly dialog: string;
	readonly zoomOut: string;
	readonly zoomIn: string;
	readonly fit: string;
	readonly copy: string;
	readonly close: string;
	readonly copied: string;
	readonly copyFailed: string;
}

/** 図の「拡大」のボタンと拡大の窓の見た目（ビューアの `<style>` に入れる）。 */
export const PARADIS_MERMAID_ZOOM_STYLES = `
.paradis-mermaid.mermaid { position: relative; }
.paradis-mermaid-expand {
	position: absolute; top: 4px; right: 6px; width: 24px; height: 24px; padding: 0;
	display: flex; align-items: center; justify-content: center;
	border-radius: 6px; border: 1px solid var(--vscode-editorWidget-border, transparent);
	background: var(--vscode-editorWidget-background); color: var(--vscode-icon-foreground);
	cursor: pointer; opacity: 0;
}
.paradis-mermaid.mermaid:hover .paradis-mermaid-expand, .paradis-mermaid-expand:focus-visible { opacity: 1; }
.paradis-mermaid-expand:hover { background: var(--vscode-toolbar-hoverBackground); }
.paradis-mermaid-expand:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.paradis-mermaid-expand svg, .paradis-mermaid-zoom-tool svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.paradis-mermaid-zoom {
	position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0;
	border: none; overflow: hidden; background: transparent; color: inherit;
}
.paradis-mermaid-zoom::backdrop { background: var(--vscode-widget-shadow, rgba(0, 0, 0, 0.45)); }
.paradis-mermaid-zoom-panel {
	position: absolute; left: 5vw; top: 5vh; width: 90vw; height: 90vh; overflow: hidden; outline: none;
	border-radius: 6px; border: 1px solid var(--vscode-editorWidget-border, transparent);
	background: var(--vscode-editor-background); box-shadow: 0 0 8px 2px var(--vscode-widget-shadow, transparent);
}
.paradis-mermaid-zoom-stage { position: absolute; inset: 0; cursor: grab; touch-action: none; }
.paradis-mermaid-zoom-stage.dragging { cursor: grabbing; }
.paradis-mermaid-zoom-content { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.paradis-mermaid-zoom-content svg { display: block; max-width: none; }
.paradis-mermaid-zoom-tools {
	position: absolute; top: 8px; right: 8px; display: inline-flex; align-items: center; gap: 2px; padding: 2px;
	border-radius: 8px; border: 1px solid var(--vscode-editorWidget-border, transparent); background: var(--vscode-editor-background);
}
.paradis-mermaid-zoom-tool {
	display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 24px;
	white-space: nowrap; padding: 0 8px; font: inherit; font-size: 12px; border-radius: 6px; border: none;
	background: none; color: var(--vscode-foreground); cursor: pointer;
}
.paradis-mermaid-zoom-tool:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
.paradis-mermaid-zoom-tool:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.paradis-mermaid-zoom-tool:disabled { opacity: 0.5; cursor: default; }
.paradis-mermaid-zoom-status { padding: 0 6px; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.paradis-mermaid-zoom-status:empty { display: none; }
`;

/**
 * 図ごとの拡大の窓（Orca の `PanZoomImageDialog` と同じ操作: 縮小・拡大・画面に合わせる・PNG でコピー・閉じる、
 * ドラッグで移動、ホイールで拡大縮小）。窓はこのページの中に `<dialog>` で作って `showModal()` で開く（本文は inert になり、
 * Esc はブラウザが閉じる。閉じたら押したボタンへフォーカスを戻す）。webview の iframe の中のモーダルは Tab で外へ
 * 抜けうるので、Tab のフォーカスは窓のボタンの間で回す。
 *
 * ページの `html` には文書ごとの倍率（CSS zoom）が掛かっているので、窓にはその逆数を掛けて等倍で出す。
 * 写しの図は id を消さない（mermaid の図の中の `<style>` と矢印の印は、その id を起点に書かれている）。
 * PNG は SVG を data: URI の画像にして canvas に描く（blob: の URL から描くと、HTML のラベルを含む図で
 * canvas が汚染されて書き出せない）。画像の中ではページの CSS が効かず、ラベルの字の大きさが変わって枠からはみ出すので、
 * ラベルの HTML にはページで計算された字の形を書き写す。背景はエディタの色で塗る（暗いテーマの図を貼ったときに読めるように）。
 */
export function paradisMermaidZoomScript(nonce: string, labels: IParadisMermaidZoomLabels): string {
	const text = JSON.stringify(labels).replace(/</g, '\\u003c');
	return `<script nonce="${nonce}">(function(){try{
var L=${text};var NS='http://www.w3.org/2000/svg';
var EXPAND='<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/>';
function icon(paths){var s=document.createElementNS(NS,'svg');s.setAttribute('viewBox','0 0 16 16');s.setAttribute('aria-hidden','true');s.innerHTML=paths;return s;}
function pageZoom(){var z=parseFloat(getComputedStyle(document.documentElement).zoom);return z>0?z:1;}
function sizeOf(svg){var vb=svg.viewBox&&svg.viewBox.baseVal;if(vb&&vb.width>0&&vb.height>0){return{w:vb.width,h:vb.height};}var r=svg.getBoundingClientRect();var z=pageZoom();return{w:Math.max(1,r.width/z),h:Math.max(1,r.height/z)};}
var open=null;
function close(){if(!open){return;}var o=open;open=null;document.removeEventListener('keydown',o.onKey,true);if(o.root.open){o.root.close();}o.root.remove();if(o.opener&&o.opener.isConnected){o.opener.focus({preventScroll:true});}}
function show(svg,opener){close();var size=sizeOf(svg);
var root=document.createElement('dialog');root.className='paradis-mermaid-zoom';root.setAttribute('aria-label',L.dialog);root.style.zoom=String(1/pageZoom());
var panel=document.createElement('div');panel.className='paradis-mermaid-zoom-panel';panel.tabIndex=-1;
var stage=document.createElement('div');stage.className='paradis-mermaid-zoom-stage';
var content=document.createElement('div');content.className='paradis-mermaid-zoom-content';
var clone=svg.cloneNode(true);clone.setAttribute('width',String(size.w));clone.setAttribute('height',String(size.h));clone.style.maxWidth='none';
content.appendChild(clone);stage.appendChild(content);panel.appendChild(stage);
var tools=document.createElement('div');tools.className='paradis-mermaid-zoom-tools';
var status=document.createElement('span');status.className='paradis-mermaid-zoom-status';status.setAttribute('role','status');
function tool(label,run){var b=document.createElement('button');b.type='button';b.className='paradis-mermaid-zoom-tool';b.textContent=label;b.addEventListener('click',function(e){e.stopPropagation();run();});tools.appendChild(b);return b;}
var MIN=0.05,MAX=20,STEP=1.25;var s=1,x=0,y=0,fitted=true;
var outB,inB,fitB;
function apply(){content.style.transform='translate('+x+'px,'+y+'px) scale('+s+')';outB.disabled=s<=MIN*1.0001;inB.disabled=s>=MAX/1.0001;fitB.disabled=fitted;}
function fit(){var r=stage.getBoundingClientRect();if(!(r.width>0&&r.height>0)){return;}s=Math.min(MAX,Math.max(MIN,Math.min(r.width/size.w,r.height/size.h)*0.95));x=(r.width-size.w*s)/2;y=(r.height-size.h*s)/2;fitted=true;apply();}
function zoomAt(f,cx,cy){var n=Math.min(MAX,Math.max(MIN,s*f));if(n===s){return;}x=cx-(cx-x)*(n/s);y=cy-(cy-y)*(n/s);s=n;fitted=false;apply();}
function zoomCenter(f){var r=stage.getBoundingClientRect();zoomAt(f,r.width/2,r.height/2);}
outB=tool(L.zoomOut,function(){zoomCenter(1/STEP);});inB=tool(L.zoomIn,function(){zoomCenter(STEP);});fitB=tool(L.fit,fit);
var copyB=tool(L.copy,function(){copyPng(clone,size,status,copyB);});tools.appendChild(status);tool(L.close,close);
panel.appendChild(tools);root.appendChild(panel);
root.addEventListener('mousedown',function(e){if(e.target===root){close();}});root.addEventListener('close',function(){if(open&&open.root===root){close();}});
stage.addEventListener('wheel',function(e){e.preventDefault();var r=stage.getBoundingClientRect();zoomAt(Math.exp(-e.deltaY*0.0015),e.clientX-r.left,e.clientY-r.top);},{passive:false});
var drag=null;
stage.addEventListener('pointerdown',function(e){if(e.button!==0){return;}drag={id:e.pointerId,px:e.clientX,py:e.clientY,x:x,y:y};stage.setPointerCapture(e.pointerId);stage.classList.add('dragging');e.preventDefault();});
stage.addEventListener('pointermove',function(e){if(!drag||drag.id!==e.pointerId){return;}x=drag.x+e.clientX-drag.px;y=drag.y+e.clientY-drag.py;fitted=false;apply();});
function endDrag(e){if(drag&&drag.id===e.pointerId){drag=null;stage.classList.remove('dragging');}}
stage.addEventListener('pointerup',endDrag);stage.addEventListener('pointercancel',endDrag);
var onKey=function(e){if(e.key==='Tab'){var f=[].slice.call(tools.querySelectorAll('button:not(:disabled)'));if(f.length===0){e.preventDefault();return;}var i=f.indexOf(document.activeElement);e.preventDefault();var n=i<0?(e.shiftKey?f.length-1:0):(i+(e.shiftKey?f.length-1:1))%f.length;f[n].focus();}else if(e.key==='Escape'){e.stopPropagation();}else if((e.key==='+'||e.key==='=')&&!e.metaKey&&!e.ctrlKey){e.preventDefault();zoomCenter(STEP);}else if(e.key==='-'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();zoomCenter(1/STEP);}else if(e.key==='0'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();fit();}};
document.addEventListener('keydown',onKey,true);
document.body.appendChild(root);root.showModal();open={root:root,opener:opener,onKey:onKey,refit:function(){root.style.zoom=String(1/pageZoom());if(fitted){fit();}}};
apply();fit();panel.focus({preventScroll:true});}
function copyPng(svg,size,status,button){button.disabled=true;var say=function(t){status.textContent=t;setTimeout(function(){if(status.textContent===t){status.textContent='';}},2000);button.disabled=false;};
try{var copy=svg.cloneNode(true);copy.setAttribute('xmlns',NS);var live=svg.querySelectorAll('foreignObject *'),out=copy.querySelectorAll('foreignObject *');for(var k=0;k<live.length&&k<out.length;k++){var cs=getComputedStyle(live[k]);['font-family','font-size','font-weight','font-style','line-height','margin','color','white-space'].forEach(function(n){out[k].style.setProperty(n,cs.getPropertyValue(n));});}var markup=new XMLSerializer().serializeToString(copy);
var ratio=Math.min(2,Math.sqrt(32000000/(size.w*size.h)),16384/Math.max(size.w,size.h));var w=Math.max(1,Math.floor(size.w*ratio)),h=Math.max(1,Math.floor(size.h*ratio));
var img=new Image();img.onload=function(){try{var c=document.createElement('canvas');c.width=w;c.height=h;var g=c.getContext('2d');g.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim()||getComputedStyle(document.body).backgroundColor;g.fillRect(0,0,w,h);g.drawImage(img,0,0,w,h);
c.toBlob(function(blob){if(!blob||!navigator.clipboard||typeof ClipboardItem==='undefined'){say(L.copyFailed);return;}navigator.clipboard.write([new ClipboardItem({'image/png':blob})]).then(function(){say(L.copied);},function(err){console.error('[paradis] copying the diagram failed',err);say(L.copyFailed);});},'image/png');}catch(err){console.error('[paradis] copying the diagram failed',err);say(L.copyFailed);}};
img.onerror=function(){say(L.copyFailed);};img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(markup);}catch(err){console.error('[paradis] copying the diagram failed',err);say(L.copyFailed);}}
function decorate(){var blocks=document.querySelectorAll('.paradis-mermaid');for(var i=0;i<blocks.length;i++){(function(block){var svg=block.querySelector(':scope > svg');if(!svg||block.querySelector(':scope > .paradis-mermaid-expand')){return;}
var b=document.createElement('button');b.type='button';b.className='paradis-mermaid-expand';b.title=L.expand;b.setAttribute('aria-label',L.expand);b.appendChild(icon(EXPAND));
b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();show(svg,b);});block.appendChild(b);})(blocks[i]);}}
window.addEventListener('resize',function(){if(open){open.refit();}});
window.addEventListener('message',function(){if(open){setTimeout(function(){if(open){open.refit();}},0);}});
window.__paradisMermaidZoom={decorate:decorate,close:close};
}catch(err){console.error('[paradis] mermaid zoom failed',err);}})();</script>`;
}

let cachedMermaidScript: Promise<string | undefined> | undefined;

/**
 * vendored mermaid.js 本体のソースを読む。webview は Markdown ビューアの方針上ネットワーク／
 * service worker を使わないため、`<script>` タグの内容として直接埋め込む（`src` 参照にしない）。
 * サイズが大きい（約3.5MB）ので、プロセス内で一度読めたら使い回す。読めなかったことは覚えない（次の描画で読み直す）。
 */
export async function loadParadisMermaidScriptSource(fileService: IFileService): Promise<string | undefined> {
	const loading = cachedMermaidScript ??= (async () => {
		try {
			const uri: URI = FileAccess.asFileUri(`${MERMAID_MEDIA_ROOT}/mermaid.min.js`);
			const content = await fileService.readFile(uri);
			// このソースは <script> の本文としてそのまま埋め込む。中に "</script" という文字列（コメント・
			// 文字列リテラル等）が出てくると、そこで HTML パーサーがタグを閉じてしまい後続が壊れるため無害化する
			// （実行結果は変わらない。JS の文字列/正規表現リテラル内でも `\/` は単なる `/` として解釈される）。
			return content.value.toString().replace(/<\/script/gi, '<\\/script');
		} catch {
			// 読めなくても Markdown 自体の表示は継続できる（mermaid ブロックだけコードとして残る）。
			return undefined;
		}
	})();
	const source = await loading;
	if (source === undefined && cachedMermaidScript === loading) {
		cachedMermaidScript = undefined;
	}
	return source;
}
