/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの右クリックのメニュー（upstream の browserViewMainService.ts の showContextMenu）に、Chrome 拡張機能
// （試験的）の項目を差し込む口。upstream の側は PARA-PATCH の 1 行でこれを呼ぶだけ。中身（どの項目を出すか）は
// 拡張機能の管理が paradisBrowserExtensionMenuRegistry.ts に登録する（ここから管理を読むと、browserViewMainService.ts → 管理 → … と読み込みが輪になるため）。
// エージェントの右クリックは、upstream の側でこれより前にメニューごと止めている（paradisConsumeAgentContextMenuSuppression）。

import { MenuItem, type ContextMenuParams, type Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { paradisBrowserExtensionMenuProvider } from './paradisBrowserExtensionMenuRegistry.js';

/** 内蔵ブラウザの右クリックのメニューの、「検証」の前に拡張機能の項目を足す（無ければ何もしない）。 */
export function paradisAppendBrowserExtensionMenuItems(menu: Menu, contents: WebContents, params: ContextMenuParams): void {
	let items: MenuItemConstructorOptions[] = [];
	try {
		items = paradisBrowserExtensionMenuProvider()?.(contents, params) ?? [];
	} catch (error) {
		// 拡張機能の項目が作れなくても、ブラウザの右クリックは出す
		console.error('[paradis] could not build the browser extension menu items', error);
	}
	if (items.length === 0) {
		return;
	}
	menu.append(new MenuItem({ type: 'separator' }));
	for (const item of items) {
		menu.append(new MenuItem(item));
	}
}
