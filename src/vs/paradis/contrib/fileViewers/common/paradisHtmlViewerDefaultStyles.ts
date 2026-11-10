/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML ビューアがページの <head> に足す既定のスタイル。
//
// webview の基盤（src/vs/workbench/contrib/webview/browser/pre/index.html の `@layer vscode-default`）は、body の文字を
// テーマの文字色（ダークでは明るい灰色）、リンクをテーマのリンク色（ダークでは水色）にし、背景は透明にする。ビューアは
// エディタの背景が透けないよう、ブラウザと同じ白を敷いているので、色を決めていないページの文字が白地の上で読めなくなる。
// そこで、白地に合わせた標準のブラウザの既定（文字は黒、リンクは青・訪問済みは紫）を、基盤の層より後の層で入れる。
// 層の中の指定は、ページ自身の（層に入っていない）CSS に必ず負けるので、ページが決めた色はそのまま使われる。

/** ビューアの既定の層の名前。基盤の `vscode-default` より後に並べる。 */
const LAYER = 'paradis-html-viewer-default';

/**
 * ページの <head> に足す <style>。`zoom` は描画のときの倍率（ボタンの操作ではページの中で替える）。
 * 背景の白は今までどおり `html` に敷く（ページが背景を決めていればそちらが上に描かれる）。
 */
export function paradisHtmlViewerHeadStyle(zoom: number): string {
	return `<style>@layer vscode-default, ${LAYER};`
		+ `@layer ${LAYER}{body{color:#000000;}a:link{color:#0000ee;}a:visited{color:#551a8b;}}`
		+ `html{zoom:${zoom};background-color:#ffffff;}</style>`;
}
