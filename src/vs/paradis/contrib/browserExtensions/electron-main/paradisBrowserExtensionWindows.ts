/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能が出す窓（ツールバーのボタンのポップアップ、windows.create の小さな窓）の台帳と、内蔵ブラウザの preload からの
// 「この窓は拡張機能の窓か」への答え。窓（WebContents）ごとに答える（同じ拡張機能のページは 1 つのプロセスにまとまるので、
// プロセスの印では、開いた順番で答えが逆になる）。

// electron は名前空間で読む（app は main のプロセスにしか無く、名前で読むと renderer で動くテストの読み込みが止まる）
import * as electron from 'electron';
import type { WebContents } from 'electron';
import { PARADIS_BROWSER_EXTENSION_WINDOW_CHANNEL } from '../../../../platform/browserView/common/paradisBrowserExtensionWindow.js';

const extensionWindows = new WeakSet<WebContents>();
let listening = false;

/** 拡張機能の窓として覚える（読み込む前に。preload は最初の文書から尋ねる）。 */
export function paradisMarkBrowserExtensionWindow(contents: WebContents): void {
	extensionWindows.add(contents);
}

function answer(contents: WebContents): void {
	contents.ipc.on(PARADIS_BROWSER_EXTENSION_WINDOW_CHANNEL, event => {
		event.returnValue = extensionWindows.has(contents);
	});
}

/**
 * preload の問いに答える受け手を、これから作られるすべての WebContents に立てる（1 回だけ）。内蔵ブラウザのセッションを
 * 作るときに呼ぶ（内蔵ブラウザのタブも拡張機能の窓も、その後に作られる）。同期の IPC は受け手が無いと renderer が止まるので、
 * 拡張機能の設定がオフでも必ず立てる。upstream の検証つきの ipcMain（validatedIpcMain）は Para Code のウィンドウからしか
 * 受けないので、WebContents ごとの ipc で受ける。
 */
export function paradisListenForBrowserExtensionWindowQueries(): void {
	const app = electron.app;
	if (listening || !app) {
		return;
	}
	listening = true;
	app.on('web-contents-created', (_event, contents) => answer(contents));
	// 既にある WebContents（内蔵ブラウザのタブはまだ無いはず。念のため）
	for (const contents of electron.webContents?.getAllWebContents() ?? []) {
		answer(contents);
	}
}
