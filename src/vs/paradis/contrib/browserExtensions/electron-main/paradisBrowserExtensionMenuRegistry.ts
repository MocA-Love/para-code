/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの右クリックに Chrome 拡張機能（試験的）の項目を足すものの登録先。拡張機能の管理が登録し、
// paradisBrowserExtensionMenuHook.ts が読む。electron の値を読まない（テストから管理を読めるように）。

import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/** 右クリックの項目を作る（無ければ空）。 */
export type ParadisBrowserExtensionMenuProvider = (contents: WebContents, params: ContextMenuParams) => MenuItemConstructorOptions[];

let provider: ParadisBrowserExtensionMenuProvider | undefined;

/** 項目を作るものを登録する（拡張機能の管理が、試験的な設定がオンのときだけ）。 */
export function paradisSetBrowserExtensionMenuProvider(next: ParadisBrowserExtensionMenuProvider): IDisposable {
	provider = next;
	return toDisposable(() => {
		if (provider === next) {
			provider = undefined;
		}
	});
}

/** 登録した、項目を作るもの。 */
export function paradisBrowserExtensionMenuProvider(): ParadisBrowserExtensionMenuProvider | undefined {
	return provider;
}
