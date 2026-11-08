/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisMenuIcons.css';
import { IAction, Separator, SubmenuAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { TerminalCommandId } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { CLOSE_EDITOR_COMMAND_ID, CLOSE_EDITORS_IN_GROUP_COMMAND_ID, CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID, CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID, CLOSE_SAVED_EDITORS_COMMAND_ID, COPY_EDITOR_INTO_NEW_WINDOW_COMMAND_ID, MOVE_EDITOR_INTO_NEW_WINDOW_COMMAND_ID, PIN_EDITOR_COMMAND_ID, SPLIT_EDITOR, SPLIT_EDITOR_DOWN, SPLIT_EDITOR_LEFT, SPLIT_EDITOR_RIGHT, SPLIT_EDITOR_UP, UNPIN_EDITOR_COMMAND_ID } from '../../../../workbench/browser/parts/editor/editorCommands.js';
import { COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID } from '../../../../workbench/contrib/files/browser/fileConstants.js';
import { PARADIS_TERMINAL_TAB_COLORS, PARADIS_TERMINAL_TAB_COLOR_SUBMENU_ID, paradisTerminalTabColorClass, paradisTerminalTabColorCommandId } from '../../terminalEditorMenu/common/paradisTerminalContextMenu.js';

/**
 * The marker class the fork's PARA-PATCH in `src/vs/base/browser/ui/menu/menu.ts` looks for. Only menu
 * items whose action class contains it get their class rendered (and therefore an icon).
 */
export const PARADIS_MENU_ICON_CLASS = 'paradis-menu-icon';

/** Marks an item that closes, kills or removes something. Drawn in the error color. */
export const PARADIS_MENU_DANGER_CLASS = 'paradis-menu-danger';

interface IParadisMenuIcon {
	readonly icon: ThemeIcon;
	readonly danger?: boolean;
}

/**
 * Icons for upstream commands in the context menus users meet most (terminal, editor tab, editor text).
 * Commands that are not listed keep their plain label; menus with at least one icon indent the others
 * so labels still line up (paradisMenuIcons.css). If upstream renames a command, its item silently
 * loses the icon, nothing else breaks.
 */
const ICONS: ReadonlyMap<string, IParadisMenuIcon> = new Map<string, IParadisMenuIcon>([
	// terminal
	[TerminalCommandId.CopySelection, { icon: Codicon.copy }],
	[TerminalCommandId.CopySelectionAsHtml, { icon: Codicon.code }],
	[TerminalCommandId.Paste, { icon: Codicon.clippy }],
	[TerminalCommandId.SelectAll, { icon: Codicon.selection }],
	[TerminalCommandId.New, { icon: Codicon.add }],
	[TerminalCommandId.Split, { icon: Codicon.splitHorizontal }],
	[TerminalCommandId.SplitOrCreate, { icon: Codicon.splitHorizontal }],
	[TerminalCommandId.Clear, { icon: Codicon.clearAll }],
	[TerminalCommandId.Rename, { icon: Codicon.edit }],
	[TerminalCommandId.ChangeIcon, { icon: Codicon.symbolMisc }],
	[TerminalCommandId.ChangeColor, { icon: Codicon.symbolColor }],
	[TerminalCommandId.SizeToContentWidth, { icon: Codicon.wordWrap }],
	[TerminalCommandId.MoveToEditor, { icon: Codicon.layoutSidebarRightOff }],
	[TerminalCommandId.MoveToTerminalPanel, { icon: Codicon.layoutPanel }],
	[TerminalCommandId.Kill, { icon: Codicon.trash, danger: true }],
	[TerminalCommandId.KillEditor, { icon: Codicon.trash, danger: true }],
	[TerminalCommandId.KillViewOrEditor, { icon: Codicon.trash, danger: true }],
	// editor tab
	[CLOSE_EDITOR_COMMAND_ID, { icon: Codicon.close, danger: true }],
	[CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID, { icon: Codicon.closeAll }],
	[CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID, { icon: Codicon.closeAll }],
	[CLOSE_SAVED_EDITORS_COMMAND_ID, { icon: Codicon.closeAll }],
	[CLOSE_EDITORS_IN_GROUP_COMMAND_ID, { icon: Codicon.closeAll }],
	[COPY_PATH_COMMAND_ID, { icon: Codicon.link }],
	[COPY_RELATIVE_PATH_COMMAND_ID, { icon: Codicon.link }],
	[PIN_EDITOR_COMMAND_ID, { icon: Codicon.pin }],
	[UNPIN_EDITOR_COMMAND_ID, { icon: Codicon.pinned }],
	[SPLIT_EDITOR, { icon: Codicon.splitHorizontal }],
	[SPLIT_EDITOR_RIGHT, { icon: Codicon.splitHorizontal }],
	[SPLIT_EDITOR_LEFT, { icon: Codicon.splitHorizontal }],
	[SPLIT_EDITOR_UP, { icon: Codicon.splitVertical }],
	[SPLIT_EDITOR_DOWN, { icon: Codicon.splitVertical }],
	[MOVE_EDITOR_INTO_NEW_WINDOW_COMMAND_ID, { icon: Codicon.emptyWindow }],
	[COPY_EDITOR_INTO_NEW_WINDOW_COMMAND_ID, { icon: Codicon.emptyWindow }],
	// terminal (fork, Q592)
	['paradis.terminal.splitEditorRight', { icon: Codicon.splitHorizontal }],
	['paradis.terminal.splitEditorDown', { icon: Codicon.splitVertical }],
	['paradis.terminal.resetInputModes', { icon: Codicon.discard }],
	['paradis.terminal.copyContext', { icon: Codicon.copy }],
	['paradis.terminal.sendSelectionToAgent', { icon: Codicon.send }],
	['paradis.agentChat.toggle', { icon: Codicon.commentDiscussion }],
	['paradis.editor.copyTabId', { icon: Codicon.symbolKey }],
	// editor text
	['editor.action.clipboardCopyAction', { icon: Codicon.copy }],
	['editor.action.clipboardPasteAction', { icon: Codicon.clippy }],
]);

/**
 * Submenus that HTML menus open inline as a row of color swatches (the native menu keeps the submenu with
 * the color names, as it cannot draw them). Maps the submenu item id to the swatch class of each command.
 */
const SWATCH_SUBMENUS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
	[`submenuitem.${PARADIS_TERMINAL_TAB_COLOR_SUBMENU_ID}`, new Map(
		[...PARADIS_TERMINAL_TAB_COLORS.map(color => color.key), 'none'].map(key => [paradisTerminalTabColorCommandId(key), paradisTerminalTabColorClass(key)])
	)],
]);

/** The icon and danger state for a command, or undefined when the fork has none for it. */
export function paradisMenuIconFor(commandId: string): IParadisMenuIcon | undefined {
	return ICONS.get(commandId);
}

/**
 * Returns the actions with the fork's icon classes added for the commands in the table. Actions are
 * wrapped (prototype-linked) rather than changed, so `run`, `enabled` and `checked` still come from the
 * original action and the menu's own action objects are never mutated. Actions that already carry the
 * marker class (fork menus that set their own icons) are returned as they are.
 */
export function paradisDecorateMenuActions(actions: readonly IAction[]): IAction[] {
	return actions.flatMap(action => {
		if (action instanceof Separator) {
			return action;
		}
		const swatches = action instanceof SubmenuAction ? SWATCH_SUBMENUS.get(action.id) : undefined;
		if (swatches !== undefined) {
			return paradisSwatchActions((action as SubmenuAction).actions, swatches);
		}
		if (action instanceof SubmenuAction) {
			const children = paradisDecorateMenuActions(action.actions);
			return Object.create(action, { actions: { value: children } }) as SubmenuAction;
		}
		if (action.class?.includes(PARADIS_MENU_ICON_CLASS)) {
			return action;
		}
		const entry = ICONS.get(action.id);
		if (!entry) {
			return action;
		}
		const classes = [PARADIS_MENU_ICON_CLASS, ...ThemeIcon.asClassNameArray(entry.icon).filter(name => name !== 'codicon')];
		if (entry.danger) {
			classes.push(PARADIS_MENU_DANGER_CLASS);
		}
		return Object.create(action, { class: { value: classes.join(' ') } }) as IAction;
	});
}

/** Opens a swatch submenu inline: its commands become a row of color dots (paradisMenuIcons.css), in order. */
function paradisSwatchActions(children: readonly IAction[], swatches: ReadonlyMap<string, string>): IAction[] {
	return children.flatMap(child => {
		const swatch = swatches.get(child.id);
		if (child instanceof Separator || swatch === undefined) {
			return [];
		}
		const classes = [PARADIS_MENU_ICON_CLASS, 'paradis-menu-color', 'paradis-menu-swatch', swatch];
		// The dot hides the label, so keep the color name as the tooltip.
		return [Object.create(child, { class: { value: classes.join(' ') }, tooltip: { value: child.tooltip || child.label } }) as IAction];
	});
}
