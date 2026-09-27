/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの右クリックで、Para Code の OS の右クリックメニューを出さない。
//
// CDP で右ボタンを押すと、ページに `contextmenu` イベントが届き、ページが取り消さなければ
// webContents の `context-menu` になって upstream の browserViewMainService.ts が OS のメニューを出す。
// これは背景のタブでも利用者の画面に出て、「外部ブラウザで開く」などを誤って押せてしまう。
// エージェントの入力の通り道（paradisCdpTargetService.ts）が右ボタンを送る直前に印を付け、
// browserViewMainService.ts の PARA-PATCH 1 行がその印を見てメニューを出さない。ページ自身の
// 右クリックメニュー（`contextmenu` を取り消して自前で描くもの）はそのまま動く。
//
// Electron に依存しない（テストから素のオブジェクトで使える）。

/** 印を有効にしておく時間。`context-menu` は押下（macOS）か離し（Windows）の直後に来る。 */
const SUPPRESSION_WINDOW_MS = 2_000;

const suppressedUntil = new WeakMap<object, number>();

/** このタブで次に来る OS の右クリックメニューを出さないと印を付ける。 */
export function paradisSuppressNextContextMenu(webContents: object, now: number = Date.now()): void {
	suppressedUntil.set(webContents, now + SUPPRESSION_WINDOW_MS);
}

/**
 * このタブの OS の右クリックメニューを出さないか。印があれば消費して true を返す
 * （印は1回のメニューにだけ効く）。
 */
export function paradisConsumeAgentContextMenuSuppression(webContents: object, now: number = Date.now()): boolean {
	const until = suppressedUntil.get(webContents);
	if (until === undefined) {
		return false;
	}
	suppressedUntil.delete(webContents);
	return now <= until;
}

/** CDP の入力が OS の右クリックメニューを開きうるか（右ボタンの押下・離し、ContextMenu キー）。 */
export function paradisIsContextMenuInput(method: string, params: Readonly<Record<string, unknown>>): boolean {
	if (method === 'Input.dispatchMouseEvent') {
		return params.button === 'right' && (params.type === 'mousePressed' || params.type === 'mouseReleased');
	}
	if (method === 'Input.dispatchKeyEvent') {
		return params.key === 'ContextMenu' || params.code === 'ContextMenu' || (params.key === 'F10' && typeof params.modifiers === 'number' && (params.modifiers & 8) !== 0);
	}
	return false;
}
