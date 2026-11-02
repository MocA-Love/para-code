/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// electron は名前空間で読む（app は main のプロセスにしか無く、名前で読むと renderer で動くテストの読み込みが止まる）
import * as electron from 'electron';
import type { WebContents } from 'electron';

/**
 * 既にあるものとこれから作られるもの、すべての WebContents に `attach` を呼ぶ（preload からの同期の問いの受け手を立てる）。
 *
 * app の受け手は外さない（プロセスが終わるまで残す）。同期の IPC は受け手が無いと renderer が止まるので、拡張機能の仕組みを
 * 片付けた後に作られた WebContents にも受け手が要る（片付けた後の答えは、それぞれの `attach` が立てた受け手が返す）。
 * 同じ WebContents に二度立てないための印は、テストからも直接呼ぶ `attach` の側が持つ。
 */
export function paradisAttachToEveryWebContents(attach: (contents: WebContents) => void): void {
	const app = electron.app;
	if (!app) {
		return;
	}
	app.on('web-contents-created', (_event, contents) => attach(contents));
	for (const contents of electron.webContents?.getAllWebContents() ?? []) {
		attach(contents);
	}
}
