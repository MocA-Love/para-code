/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアのコードのブロックの右上に出す「コピー」のボタン。
//
// ボタンはページの中のスクリプトで `pre > code` ごとに付ける（Mermaid の図は `pre` の中に `code` が無いので付かない。
// インラインのコードは `pre` の中に無いので付かない）。押すと中身をホストへ postMessage で渡し、ホストが
// IClipboardService で書いて結果を返す。ページは返事を待って「コピーしました」を短く出す。
//
// 色付けしたコードは `tokenizeToString` の形（div の中に span と、行の区切りの `<br>`）なので、`textContent` では
// 改行が消える。中身は文字の node をそのまま、`<br>` を改行として拾い、描画で足した末尾の改行を 1 つだけ外す
// （{@link PARADIS_CODE_BLOCK_TEXT_FUNCTION}。ページに埋める文字列そのものを単体テストで動かす）。
//
// ボタンは `pre` の外（`pre` を包む div の子）に置く。`pre` の中に置くと、長い行の横スクロールでボタンが流れる。
// 文字は `::after { content: attr(data-label) }` で出し、文書の文字にしない（本文を選んでコピーしたときに混ざらない）。

import { paradisScriptStringLiteral } from '../../../common/paradisScriptLiteral.js';
import { PARADIS_VIEWER_BODY_ROOT_ID } from './paradisViewerBodySwap.js';
import { PARADIS_WEBVIEW_HOST_MESSAGE_CHECK } from './paradisWebviewHostMessage.js';

/** ページからホストへ送る、コピーの頼みの印。 */
const COPY_REQUEST_KEY = '__paradisCopyCode';
/** ホストからページへ返す、コピーの結果の印。 */
const COPY_RESULT_KEY = '__paradisCodeCopied';

/** 1 回にコピーする文字数の上限（ページから届いた値をそのまま書かない）。 */
export const PARADIS_CODE_COPY_MAX_CHARS = 16 * 1024 * 1024;

/**
 * `code` 要素から、書いたままのコードを取り出す関数式（ページに埋める）。`<br>` は改行、それ以外の要素は中へ降りる。
 * 末尾の改行は 1 つだけ外す（`<pre><code>…\n</code></pre>` の形で描くため）。
 */
export const PARADIS_CODE_BLOCK_TEXT_FUNCTION = `(function(code){var out='';(function walk(node){for(var c=node.firstChild;c;c=c.nextSibling){if(c.nodeType===3){out+=c.data;}else if(c.nodeName==='BR'){out+='\\n';}else if(c.nodeType===1){walk(c);}}})(code);return out.replace(/\\n$/,'');})`;

/** ボタンの文言（ビューアの側で nls から作って渡す）。 */
export interface IParadisCodeCopyLabels {
	readonly copy: string;
	readonly copied: string;
	readonly copyFailed: string;
}

/** ページから届いたコピーの頼み。 */
export interface IParadisCodeCopyRequest {
	readonly id: number;
	readonly text: string;
}

/** webview から届いたメッセージがコピーの頼みなら取り出す。形が違う・大きすぎるものは捨てる。 */
export function paradisReadCodeCopyRequest(message: unknown): IParadisCodeCopyRequest | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}
	const text = (message as { [COPY_REQUEST_KEY]?: unknown })[COPY_REQUEST_KEY];
	const id = (message as { id?: unknown }).id;
	if (typeof text !== 'string' || text.length > PARADIS_CODE_COPY_MAX_CHARS || typeof id !== 'number' || !Number.isSafeInteger(id)) {
		return undefined;
	}
	return { id, text };
}

/** ページへ返す、コピーの結果。 */
export function paradisCodeCopiedMessage(id: number, ok: boolean): { readonly [COPY_RESULT_KEY]: number; readonly ok: boolean } {
	return { [COPY_RESULT_KEY]: id, ok };
}

/** ボタンの見た目。ページの中なので、色は webview に配られるテーマの色（`--vscode-*`）だけを使う。 */
export const PARADIS_CODE_COPY_STYLES = `
.paradis-code-block { position: relative; }
.paradis-code-copy {
	position: absolute; top: 6px; right: 6px; height: 24px; padding: 0 8px;
	display: inline-flex; align-items: center; box-sizing: border-box;
	border-radius: 6px; border: 1px solid var(--vscode-paradis-lineSubtle, var(--vscode-editorWidget-border, transparent));
	background: var(--vscode-paradis-popup, var(--vscode-editorWidget-background)); color: var(--vscode-paradis-textMuted, var(--vscode-foreground));
	font: inherit; font-size: 12px; line-height: 1; white-space: nowrap; cursor: pointer; opacity: 0; user-select: none;
}
.paradis-code-copy::after { content: attr(data-label); }
.paradis-code-block:hover .paradis-code-copy, .paradis-code-copy:focus-visible, .paradis-code-copy.paradis-code-copy-done { opacity: 1; }
.paradis-code-copy:hover { color: var(--vscode-paradis-textStrong, var(--vscode-foreground)); background: var(--vscode-paradis-fillHover, var(--vscode-toolbar-hoverBackground)); }
.paradis-code-copy:focus-visible { outline: 2px solid var(--vscode-paradis-focus, var(--vscode-focusBorder)); outline-offset: 2px; }
`;

/** 本文を差し替えた後に、新しい本文のコードのブロックへボタンを付ける。 */
export const PARADIS_CODE_COPY_RERUN_SCRIPT = `try{if(window.__paradisCodeCopy){window.__paradisCodeCopy.decorate();}}catch(err){}`;

/**
 * コードのブロックにボタンを付けるページ内スクリプト。webview の `acquireVsCodeApi` はページで 1 回しか呼べないので、
 * 読み込みのときに 1 回だけ呼んで持っておく。
 */
export function paradisCodeCopyScript(nonce: string, labels: IParadisCodeCopyLabels): string {
	const label = (value: string) => paradisScriptStringLiteral(value);
	return `<script nonce="${nonce}">(function(){try{var fromHost=${PARADIS_WEBVIEW_HOST_MESSAGE_CHECK};var textOf=${PARADIS_CODE_BLOCK_TEXT_FUNCTION};
var L={copy:${label(labels.copy)},copied:${label(labels.copied)},failed:${label(labels.copyFailed)}};
var api=window.__paradisVsCodeApi;if(!api&&typeof acquireVsCodeApi==='function'){api=window.__paradisVsCodeApi=acquireVsCodeApi();}
var seq=0;var pending={};
function show(b,text,done){b.setAttribute('data-label',text);b.setAttribute('aria-label',text);b.classList.toggle('paradis-code-copy-done',!!done);}
function say(b,text){show(b,text,true);clearTimeout(b.__paradisTimer);b.__paradisTimer=setTimeout(function(){show(b,L.copy,false);},1500);}
function copy(code,b){if(!api){say(b,L.failed);return;}var id=++seq;pending[id]=b;try{api.postMessage({${COPY_REQUEST_KEY}:textOf(code),id:id});}catch(err){delete pending[id];say(b,L.failed);}}
function decorate(){var root=document.getElementById('${PARADIS_VIEWER_BODY_ROOT_ID}')||document.body;var codes=root.querySelectorAll('pre > code');for(var i=0;i<codes.length;i++){(function(code){var pre=code.parentElement;if(!pre||!pre.parentNode||(pre.parentElement&&pre.parentElement.classList.contains('paradis-code-block'))){return;}var wrap=document.createElement('div');wrap.className='paradis-code-block';pre.parentNode.insertBefore(wrap,pre);wrap.appendChild(pre);var b=document.createElement('button');b.type='button';b.className='paradis-code-copy';b.title=L.copy;show(b,L.copy,false);b.addEventListener('click',function(){copy(code,b);});wrap.appendChild(b);})(codes[i]);}}
window.addEventListener('message',function(e){if(!fromHost(e)){return;}var d=e.data;if(!d||typeof d.${COPY_RESULT_KEY}!=='number'){return;}var b=pending[d.${COPY_RESULT_KEY}];delete pending[d.${COPY_RESULT_KEY}];if(b){say(b,d.ok?L.copied:L.failed);}});
window.__paradisCodeCopy={decorate:decorate};decorate();}catch(err){}})();</script>`;
}
