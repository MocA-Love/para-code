/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（SSH・WSL・コンテナ）のペインからの CDP で、手元のファイルに触れる操作だけを断る
// （NOTES.md「chrome-devtools-mcp のファイルのパスは手元のペインからだけ受け、roots で範囲を絞る」）。
//
// CDP ゲートウェイは手元の shared process にあり、戻り経路（ssh -R）を通って接続先からも `?pane=` で
// 届く。ブラウザも手元で動いているので、次の操作は手元のファイルを読む（または読める状態にする）:
//   - `DOM.setFileInputFiles`: 手元のパスのファイルを <input type=file> に入れる（ページの JS で読める）
//   - `Input.dispatchDragEvent` の `data.files`: 手元のパスのファイルをドロップする
//   - `Page.navigate` で `file:` の URL を開く（開いたページは take_snapshot 等で読める）
//   - `Page.handleFileChooser`（旧 API）の `files`、`DOM.getFileInfo`（ファイルの手元のパスを返す）
// 手元のペインは今までどおり通す。
//
// 塞いでいないもの（NOTES.md に記録）:
//   - `Page.navigateToHistoryEntry`: 戻る・進むに使うので断らない。タブの履歴に `file:` のページが
//     あるとき（利用者がそのタブで手元のファイルを開いていたとき）だけ、そこへ戻れてしまう
//   - `Runtime.evaluate` の `location = 'file:…'`: Chromium が web のページから `file:` への遷移を断る。
//     今のページが既に `file:` のときは効くが、そこへ来る経路は上で断っている

/** `file:` の URL か（`view-source:file:` を含む）。URL の解釈と同じく、前後の空白・制御文字とタブ・改行は無視する。 */
export function paradisIsLocalFileUrl(url: unknown): boolean {
	if (typeof url !== 'string') {
		return false;
	}
	// WHATWG URL は前後の C0 制御文字と空白を落とし、途中のタブ・改行を取り除いてから解釈する
	let normalized = trimC0AndSpace(url.replace(/[\t\n\r]/g, '')).toLowerCase();
	while (normalized.startsWith('view-source:')) {
		normalized = trimC0AndSpace(normalized.slice('view-source:'.length));
	}
	return normalized.startsWith('file:');
}

function trimC0AndSpace(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && value.charCodeAt(start) <= 0x20) {
		start++;
	}
	while (end > start && value.charCodeAt(end - 1) <= 0x20) {
		end--;
	}
	return value.slice(start, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REMOTE_REASON = 'this CDP connection comes from a terminal pane in a remote window (SSH, WSL, container), and the browser runs on the user\'s local machine, so it would reach the user\'s local files.';

/**
 * 接続先のペインからの CDP コマンドのうち、手元のファイルに触れるものを断るときの説明文。
 * 通してよいものは undefined。ペインが接続先かどうかは呼び出し側が決める（手元のペインには使わない）。
 */
export function paradisRemotePaneCdpDeniedMessage(method: string, params: Record<string, unknown> | undefined): string | undefined {
	switch (method) {
		case 'DOM.setFileInputFiles':
		case 'DOM.getFileInfo':
			return `${method} is not permitted: ${REMOTE_REASON} To give the page a file, use the upload_file_to_drop_zone tool with the file content.`;
		case 'Page.handleFileChooser':
			return `${method} is not permitted: ${REMOTE_REASON}`;
		case 'Input.dispatchDragEvent': {
			const data = isRecord(params) ? params.data : undefined;
			const files = isRecord(data) ? data.files : undefined;
			if (files === undefined || (Array.isArray(files) && files.length === 0)) {
				return undefined;
			}
			return `Input.dispatchDragEvent with data.files is not permitted: ${REMOTE_REASON} Use the upload_file_to_drop_zone tool with the file content instead.`;
		}
		case 'Page.navigate':
		case 'Target.createTarget':
			return isRecord(params) && paradisIsLocalFileUrl(params.url)
				? `${method} to a file: URL is not permitted: ${REMOTE_REASON}`
				: undefined;
		default:
			return undefined;
	}
}
