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

/** 拡張機能の窓・パネルのナビゲーション（will-navigate・will-redirect の event のうち、判定に使うもの）。 */
export interface IParadisExtensionPageNavigation {
	readonly url: string;
	readonly isMainFrame: boolean;
	preventDefault(): void;
}

/**
 * 拡張機能の窓・パネルの一番外の文書が、許したページの外へ移るのを止める。子フレームのナビゲーションは止めない
 * （ChatGPT のサイドパネルのように、拡張機能のページが iframe で埋めたウェブのページは、サーバーのリダイレクトで
 * 進む。Electron の will-redirect は子フレームでも出るので、止めると iframe の中が途中で止まる）。
 */
export function paradisStopLeavingExtensionPage(event: IParadisExtensionPageNavigation, allowed: (url: string) => boolean): void {
	if (!event.isMainFrame) {
		return;
	}
	if (!allowed(event.url)) {
		event.preventDefault();
	}
}

/** 拡張機能の窓・パネルを、許したページ（拡張機能自身のページ）の間だけ移れるようにする。 */
export function paradisKeepOnExtensionPages(contents: WebContents, allowed: (url: string) => boolean): void {
	contents.on('will-navigate', event => paradisStopLeavingExtensionPage(event, allowed));
	contents.on('will-redirect', event => paradisStopLeavingExtensionPage(event, allowed));
}

/** 拡張機能自身のページへの、利用者の本物の入力を受け取るもの（拡張機能の管理が登録する）。 */
let inputListener: ((contents: WebContents, extensionId: string) => void) | undefined;

/** 拡張機能自身のページへの利用者の入力を受け取るものを登録する（permissions の「利用者の操作」の記録）。 */
export function paradisSetBrowserExtensionInputListener(listener: ((contents: WebContents, extensionId: string) => void) | undefined): void {
	inputListener = listener;
}

/** Chrome が利用者の操作（user activation）とみなす入力。 */
const ACTIVATING_INPUTS: ReadonlySet<string> = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'touchStart', 'touchEnd', 'gestureTap']);

/**
 * その入力が、拡張機能自身のページ（一番外の文書が chrome-extension://<id>/）への利用者の操作なら、その拡張機能の id。
 * ウェブのページの中の拡張機能の iframe への入力は数えない（その WebContents の URL はウェブのページ）。
 */
export function paradisGestureExtensionId(topUrl: string, inputType: string): string | undefined {
	if (!ACTIVATING_INPUTS.has(inputType)) {
		return undefined;
	}
	return /^chrome-extension:\/\/(?<id>[a-p]{32})\//.exec(topUrl)?.groups?.id;
}

function answer(contents: WebContents): void {
	contents.ipc.on(PARADIS_BROWSER_EXTENSION_WINDOW_CHANNEL, event => {
		event.returnValue = extensionWindows.has(contents);
	});
	// 拡張機能自身のページへの本物の入力を記録する（エージェントは P1・P2 の守りで拡張機能のページへ入力できない）
	contents.on('input-event', (_event, input) => {
		if (!inputListener) {
			return;
		}
		let url = '';
		try {
			url = contents.getURL();
		} catch {
			return;
		}
		const extensionId = paradisGestureExtensionId(url, input.type);
		if (extensionId !== undefined) {
			inputListener(contents, extensionId);
		}
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
