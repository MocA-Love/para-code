/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IKeybindings, KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import {
	IParadisAgentLiveWindowService,
	PARADIS_AGENT_LIVE_BLOCK_EDITOR_SHORTCUT_COMMAND_ID,
	PARADIS_AGENT_LIVE_CLOSE_COMMAND_ID,
	ParadisAgentLiveWindowFocusContext,
} from '../common/paradisAgentLiveWindow.js';

/**
 * ライブウィンドウの中で押されたショートカットのうち、メインウィンドウのエディタを閉じてしまうもの。
 *
 * ライブウィンドウは editor part を持たない補助ウィンドウで、エディタ系コマンドの対象
 * (IEditorGroupsService.activeGroup) はメインウィンドウ側のグループのまま動かない。
 * `workbench.action.closeActiveEditor` などは when 句を持たないため、ここで押しても
 * そのまま解決され、メインのアクティブなエディタ (エディタ領域のターミナルならシェルごと) を閉じる。
 *
 * upstream の既定より 1 つ上の weight で、ライブウィンドウにいるときだけ先に受ける。
 * ユーザーが keybindings.json で同じキーを割り当てた場合はそちらが優先される。
 */
const WEIGHT = KeybindingWeight.WorkbenchContrib + 1;

/**
 * ライブウィンドウ自体を閉じるキー。
 *
 * 1 つ目は upstream の `workbench.action.closeActiveEditor` と同じキー (editorCommands.ts)。
 * macOS の一般的なアプリと同じく、タブを持たないウィンドウでの Cmd+W はウィンドウを閉じる。
 *
 * 2 つ目は upstream の `workbench.action.closeWindow` と同じキー (windowActions.ts)。
 * upstream の実装は getActiveWindow() (document.hasFocus() で判定) が返したウィンドウを閉じる
 * ため、フォーカスの判定がずれるとメインウィンドウを閉じてしまう。ライブウィンドウに
 * いるときは判定を挟まずにライブウィンドウを閉じる。
 */
const PARADIS_AGENT_LIVE_CLOSE_KEYBINDINGS: readonly IKeybindings[] = [
	{
		primary: KeyMod.CtrlCmd | KeyCode.KeyW,
		win: { primary: KeyMod.CtrlCmd | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyCode.KeyW] },
	},
	{
		mac: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW },
		linux: { primary: KeyMod.Alt | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW] },
		win: { primary: KeyMod.Alt | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW] },
	},
];

/**
 * 何もしないで握りつぶすキー。いずれも upstream の既定で when 句を持たず、ライブウィンドウから
 * 押すとメインウィンドウのエディタをまとめて閉じる。
 */
const PARADIS_AGENT_LIVE_BLOCKED_KEYBINDINGS: readonly IKeybindings[] = [
	// workbench.action.closeEditorsInGroup (editorCommands.ts)
	{ primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyW) },
	// workbench.action.closeAllEditors (editorActions.ts)
	{ primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyW) },
	// workbench.action.closeAllGroups (editorActions.ts)
	{ primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW) },
	// workbench.action.closeUnmodifiedEditors (editorCommands.ts)
	{ primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyU) },
	// workbench.action.closeOtherEditors (editorCommands.ts, macOS のみ)
	{ mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyT } },
];

CommandsRegistry.registerCommand(PARADIS_AGENT_LIVE_CLOSE_COMMAND_ID, accessor => accessor.get(IParadisAgentLiveWindowService).close());

for (const keybinding of PARADIS_AGENT_LIVE_CLOSE_KEYBINDINGS) {
	KeybindingsRegistry.registerKeybindingRule({
		id: PARADIS_AGENT_LIVE_CLOSE_COMMAND_ID,
		weight: WEIGHT,
		when: ParadisAgentLiveWindowFocusContext,
		...keybinding,
	});
}

// 空のコマンド ID で打ち消すと、単発キーでは preventDefault されずに macOS のメニューの
// アクセラレータへ流れる (メニュー経由でメインのエディタが閉じる)。実体のあるコマンドで受ける。
CommandsRegistry.registerCommand(PARADIS_AGENT_LIVE_BLOCK_EDITOR_SHORTCUT_COMMAND_ID, () => { });

for (const keybinding of PARADIS_AGENT_LIVE_BLOCKED_KEYBINDINGS) {
	KeybindingsRegistry.registerKeybindingRule({
		id: PARADIS_AGENT_LIVE_BLOCK_EDITOR_SHORTCUT_COMMAND_ID,
		weight: WEIGHT,
		when: ParadisAgentLiveWindowFocusContext,
		...keybinding,
	});
}
