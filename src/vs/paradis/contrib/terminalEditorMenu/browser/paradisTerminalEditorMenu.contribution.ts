/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタエリアのターミナルの右クリックメニューに「エディタグループを最大化」を出す（Q41 / TM3）。
//
// 実体は upstream の `workbench.action.toggleMaximizeEditorGroup`（⌘K ⌘M）をそのまま呼ぶだけ。
// メニューの引数（ターミナルの InstanceContext）はエディタのコンテキストとして解釈されないため、
// コマンドは「アクティブなエディタグループ」を対象にする。右クリックした時点で xterm がテキストエリアへ
// フォーカスを移し（xterm の rightClickHandler）、そのグループがアクティブになるので、右クリックした
// ターミナルのグループが最大化される。
//
// `TerminalInstanceContext` はパネルのターミナルとエディタのターミナルで共用のメニュー。
// `EditorPartMultipleEditorGroupsContext` / `EditorPartMaximizedEditorGroupContext` はエディタパートの
// スコープ付きコンテキストにしか無いため、パネル側（エディタパートの外）ではこの項目は出ない。
// さらに `activeEditor == terminalEditor`（グループのスコープで評価される）で、エディタエリアの
// ターミナルに限定する。

import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { TOGGLE_MAXIMIZE_EDITOR_GROUP } from '../../../../workbench/browser/parts/editor/editorCommands.js';
import { ActiveEditorContext, EditorPartMaximizedEditorGroupContext, EditorPartMultipleEditorGroupsContext } from '../../../../workbench/common/contextkeys.js';
import { terminalEditorId } from '../../../../workbench/contrib/terminal/browser/terminal.js';

/** upstream の TerminalContextMenuGroup.Kill ('7_kill') と Config ('9_config') の間に置く。 */
const PARADIS_TERMINAL_EDITOR_GROUP_MENU_GROUP = '8_paradisEditorGroup';

const inTerminalEditor = ActiveEditorContext.isEqualTo(terminalEditorId);

MenuRegistry.appendMenuItems([
	{
		id: MenuId.TerminalInstanceContext,
		item: {
			command: {
				id: TOGGLE_MAXIMIZE_EDITOR_GROUP,
				title: localize('paradis.terminal.maximizeEditorGroup', "エディタグループを最大化"),
			},
			group: PARADIS_TERMINAL_EDITOR_GROUP_MENU_GROUP,
			order: 1,
			when: ContextKeyExpr.and(inTerminalEditor, EditorPartMultipleEditorGroupsContext, EditorPartMaximizedEditorGroupContext.negate()),
		}
	},
	{
		id: MenuId.TerminalInstanceContext,
		item: {
			command: {
				id: TOGGLE_MAXIMIZE_EDITOR_GROUP,
				title: localize('paradis.terminal.unmaximizeEditorGroup', "エディタグループの最大化を解除"),
			},
			group: PARADIS_TERMINAL_EDITOR_GROUP_MENU_GROUP,
			order: 1,
			when: ContextKeyExpr.and(inTerminalEditor, EditorPartMaximizedEditorGroupContext),
		}
	},
]);
