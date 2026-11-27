/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タブを閉じても終わらせず、隠すだけにするターミナル（今は Bot の会話のペイン。bots/browser/paradisBotPaneHide.ts）の台帳。
// upstream の `terminalEditorInput.ts` の `confirm()` の PARA-PATCH が {@link paradisTerminalEditorsHideOnClose} で読む
// （ターミナルのファイルから読める層に置く）。`showConfirm()` は変えない。スペースの切り替えが「確認の要る入力＝生かして
// おく入力」の判定に使っているため。

import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';

/** 閉じても隠すターミナル（instanceId。番号は使い回されないので、終わったものは残っても害が無い）。 */
const hideOnClose = new Set<number>();

/** 閉じても隠すターミナルとして控える。 */
export function paradisAddTerminalHiddenOnClose(instanceId: number): void {
	hideOnClose.add(instanceId);
}

export function paradisIsTerminalHiddenOnClose(instanceId: number): boolean {
	return hideOnClose.has(instanceId);
}

/**
 * 閉じるエディタが全部「閉じても隠す」ターミナルなら true（終了の確認を出さない）。1 つでもほかのエディタが混ざって
 * いれば false（upstream の確認を出す）。
 */
export function paradisTerminalEditorsHideOnClose(editors: readonly { readonly terminalInstance?: ITerminalInstance }[]): boolean {
	return editors.length > 0 && editors.every(editor => {
		const instance = editor.terminalInstance;
		return instance !== undefined && !instance.isDisposed && hideOnClose.has(instance.instanceId);
	});
}

/** テスト用に台帳を空にする。 */
export function paradisResetTerminalHiddenOnCloseForTest(): void {
	hideOnClose.clear();
}
