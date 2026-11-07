/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 既定の拡張機能のうち、このウィンドウで「入れ済み」と数えてよいもの。
 *
 * SSH のウィンドウでは、拡張機能の一覧に手元と接続先の両方が入る。接続先で動く拡張機能（git-graph など）が
 * 手元にしか無いのに入れ済みとすると、接続先へ入れないまま完了の台帳（接続先ごと）に載り、以後も入らない。
 * 接続先に入っているもの、または手元で動く（UI の）拡張機能だけを数える。
 */
export function paradisInstalledForThisWindow<T>(installed: readonly T[], isRemoteWindow: boolean, isOnRemote: (extension: T) => boolean, runsOnUI: (extension: T) => boolean): T[] {
	return isRemoteWindow ? installed.filter(extension => isOnRemote(extension) || runsOnUI(extension)) : [...installed];
}
