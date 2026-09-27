/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのターミナルタブの左のアイコンを、エージェントの状態で差し替えるための口（Q52 案B）。
//
// upstream の `TerminalEditorInput.getIcon()` / `getLabelExtraClasses()` がここを引き、提供元が
// 答えたときだけ upstream のアイコンの代わりに使う。提供元は `terminalTabStatus` の
// contribution が1つ登録する。`instance.changeIcon()` で差し替えないのは、ユーザーが選んだ
// アイコンとして pty host に保存され、再起動後にも残ってしまうため。
//
// 置き場所が workspaceSwitch なのは、upstream のターミナルから fork を import してよい先として
// eslint（`code-import-patterns`）が既に許しているため（エージェントの状態の台帳もここにある）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

/** 差し替えるアイコン。 */
export interface IParadisTerminalTabIcon {
	/** タブ左に出す codicon。回転・ロゴは `extraClasses` の CSS が描き替える。 */
	readonly icon: ThemeIcon;
	/** ラベルへ足すクラス（色・回転・ロゴ）。 */
	readonly extraClasses: readonly string[];
}

export interface IParadisTerminalTabIconProvider {
	/** アイコンが変わったターミナル（instanceId）。 */
	readonly onDidChange: Event<number>;
	getTabIcon(instance: { readonly instanceId: number }): IParadisTerminalTabIcon | undefined;
}

let currentProvider: IParadisTerminalTabIconProvider | undefined;
let currentProviderListener: IDisposable | undefined;
const onDidChangeEmitter = new Emitter<number>();

/** アイコンが変わったターミナルの instanceId。`TerminalEditorInput` がラベルを描き直す。 */
export const paradisOnDidChangeTerminalTabIcon: Event<number> = onDidChangeEmitter.event;

/** 提供元は1つだけ。後から登録した方が勝つ。 */
export function paradisRegisterTerminalTabIconProvider(provider: IParadisTerminalTabIconProvider): IDisposable {
	currentProviderListener?.dispose();
	currentProvider = provider;
	currentProviderListener = provider.onDidChange(instanceId => onDidChangeEmitter.fire(instanceId));
	return toDisposable(() => {
		if (currentProvider === provider) {
			currentProviderListener?.dispose();
			currentProviderListener = undefined;
			currentProvider = undefined;
		}
	});
}

/** 差し替えるアイコン。提供元が無い・答えない（ふつうのシェル）なら undefined。 */
export function paradisGetTerminalTabIcon(instance: { readonly instanceId: number } | undefined): IParadisTerminalTabIcon | undefined {
	if (instance === undefined || currentProvider === undefined) {
		return undefined;
	}
	try {
		return currentProvider.getTabIcon(instance);
	} catch {
		// タブの描画を止めない。upstream のアイコンに戻るだけにする。
		return undefined;
	}
}
