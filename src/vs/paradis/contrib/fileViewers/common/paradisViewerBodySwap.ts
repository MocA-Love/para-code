/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 描画済みのビューア（Markdown）の 2 回目以降の描き直しで、HTML 全体を送り直さず本文だけを差し替える。
// HTML 全体を送ると webview の iframe が作り直され、CSP・スタイル・スクリプト（Mermaid は約 3.5MB）を
// 読み込み直して、スクロール位置もスクリプトで戻すことになる。本文の入れ物の中身だけを書き換えればそれが要らない。

/** 差し替える本文の入れ物の id。 */
export const PARADIS_VIEWER_BODY_ROOT_ID = 'paradis-viewer-body';

const BODY_MESSAGE_KEY = 'paradisViewerBody';

/** 描画の結果。`swap` があれば、2 回目以降は条件が合えば本文だけを送る。 */
export interface IParadisRenderedDocument {
	/** 初回（と、本文だけでは済まないとき）に送る HTML 全体。 */
	readonly html: string;
	readonly swap?: {
		/**
		 * 本文の外側（CSP・nonce・スタイル・スクリプト）を表す鍵。前に送った HTML 全体と同じなら、
		 * 本文だけを差し替えてよい。
		 */
		readonly key: string;
		/** 入れ物（{@link PARADIS_VIEWER_BODY_ROOT_ID}）の中身。 */
		readonly body: string;
	};
}

/** いま webview に出ている、本文を差し替えられる HTML 全体。 */
export interface IParadisSwappableBody<TWebview, TResource> {
	readonly webview: TWebview;
	readonly resource: TResource;
	readonly key: string;
	/** HTML 全体を送った後、ページが内容を書き終えた合図が来たか（来るまでは差し替え先が無いかもしれない）。 */
	confirmed: boolean;
	/** HTML 全体を送ってから本文を差し替えたか（webview が HTML を貼り直すと、差し替える前の本文に戻る）。 */
	swapped: boolean;
}

/** 本文だけを送ってよいか。同じ webview・同じファイル・同じ外側で、前の HTML 全体が表示されたと確かめられたとき。 */
export function paradisCanSwapViewerBody<TWebview, TResource>(
	shown: IParadisSwappableBody<TWebview, TResource> | undefined,
	webview: TWebview,
	resource: TResource,
	key: string,
	sameResource: (left: TResource, right: TResource) => boolean,
): boolean {
	return !!shown && shown.confirmed && shown.webview === webview && sameResource(shown.resource, resource) && shown.key === key;
}

/**
 * webview を claim し直したとき、同じ内容でも HTML 全体を送り直すか。本文を差し替えた後は、webview が覚えている
 * HTML 全体が差し替える前の本文のままで、claim で webview が作り直されるとそれが貼り直されるため。
 */
export function paradisMustResendViewerHtmlOnClaim<TWebview, TResource>(shown: IParadisSwappableBody<TWebview, TResource> | undefined): boolean {
	return !!shown?.swapped;
}

/** ページへ送る、本文を差し替えるメッセージ。 */
export function paradisViewerBodyMessage(body: string): { readonly [BODY_MESSAGE_KEY]: string } {
	return { [BODY_MESSAGE_KEY]: body };
}

/**
 * 本文を差し替えるメッセージを受けるスクリプト（文書の末尾に入れる）。`afterSwap` は差し替えた後に動かす
 * JavaScript（Mermaid の図を描き直すなど）。差し替える本文はビューアが消毒したもので、入れ物へ `innerHTML`
 * で入れた `<script>` は動かない（CSP の nonce も付かない）。webview の基盤（親のフレーム）から届いたメッセージだけを受ける。
 */
export function paradisViewerBodySwapScript(nonce: string, afterSwap = ''): string {
	return `<script nonce="${nonce}">(function(){try{window.addEventListener('message',function(e){if(e.source!==window.parent){return;}var d=e.data;if(!d||typeof d.${BODY_MESSAGE_KEY}!=='string'){return;}var root=document.getElementById('${PARADIS_VIEWER_BODY_ROOT_ID}');if(!root){return;}root.innerHTML=d.${BODY_MESSAGE_KEY};${afterSwap}});}catch(err){}})();</script>`;
}
