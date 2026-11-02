/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PDF と Word のビューアは中身を webview の中で描くので、読み込み中と表示できないときの表示も webview の中に置く。
// 見た目はペインの側の表示（browser/paradisViewerState.ts）に合わせる: 読み込み中は上端の 2px の線だけ
// （文は読み上げにだけ使う）、表示できないときは中央に 14px の文（幅 450px まで）。

import { escape } from '../../../../base/common/strings.js';
import { localize } from '../../../../nls.js';

/** 読み込み中の読み上げの文。 */
export function paradisViewerWebviewLoadingLabel(): string {
	return localize('paradis.viewer.loading', "読み込み中…");
}

/** 状態の表示の CSS（`#status` に当てる）。webview の `<style>` の中にそのまま入れる。 */
export const PARADIS_VIEWER_WEBVIEW_STATE_STYLE = `
		#status { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; padding: 0 16px; pointer-events: none; }
		#status.loading { align-items: flex-start; }
		#status.loading::before { content: ''; position: absolute; top: 0; left: 0; width: 40%; height: 2px; background: var(--vscode-progressBar-background, #0e70c0); animation: paradis-viewer-progress 1.2s linear infinite; animation-delay: 150ms; opacity: 0; }
		@keyframes paradis-viewer-progress { from { transform: translateX(-100%); opacity: 1; } to { transform: translateX(250%); opacity: 1; } }
		#status.loading > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
		#status.failed { font-size: 14px; color: var(--vscode-foreground); }
		#status.failed > span { max-width: 450px; text-align: center; word-break: break-word; user-select: text; pointer-events: auto; }`;

/** 読み込み中の `#status` の要素。描けたらページのスクリプトが外し、失敗したら {@link paradisViewerWebviewFailureScript} で文に替える。 */
export function paradisViewerWebviewStatusHtml(): string {
	return `<div id="status" class="loading" role="status"><span>${escape(paradisViewerWebviewLoadingLabel())}</span></div>`;
}

/**
 * ページのスクリプトに埋め込む、失敗を `#status` に出す式。`statusEl` と `err` が見えている所に置く。
 * `failedTemplate` は `{0}` に理由が入る文（localize したもの）。
 */
export function paradisViewerWebviewFailureScript(failedTemplate: string): string {
	return `statusEl.className = 'failed'; statusEl.setAttribute('role', 'alert'); { const s = document.createElement('span'); s.textContent = ${JSON.stringify(failedTemplate)}.replace('{0}', String(err && err.message ? err.message : err)); statusEl.replaceChildren(s); }`;
}

/** 中身を読めなかった（空・壊れている）ときに webview へ渡す HTML。 */
export function paradisViewerWebviewFailureHtml(message: string): string {
	return `<!DOCTYPE html><html><head><style>html, body { margin: 0; height: 100%; } body { background-color: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }${PARADIS_VIEWER_WEBVIEW_STATE_STYLE}</style></head><body><div id="status" class="failed" role="alert"><span>${escape(message)}</span></div></body></html>`;
}
