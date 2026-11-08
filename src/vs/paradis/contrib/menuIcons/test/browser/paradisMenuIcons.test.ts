/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Action, IAction, Separator, SubmenuAction } from '../../../../../base/common/actions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalCommandId } from '../../../../../workbench/contrib/terminal/common/terminal.js';
import { paradisDecorateMenuActions } from '../../browser/paradisMenuIcons.js';
import { PARADIS_TERMINAL_TAB_COLOR_SUBMENU_ID, paradisTerminalTabColorCommandId } from '../../../terminalEditorMenu/common/paradisTerminalContextMenu.js';

suite('Paradis menu icons', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('adds icon and danger classes to listed commands without changing the original actions', () => {
		const runs: string[] = [];
		const make = (id: string, cls?: string) => store.add(new Action(id, id, cls, true, async () => { runs.push(id); }));
		const copy = make(TerminalCommandId.CopySelection);
		const kill = make(TerminalCommandId.Kill);
		const unknown = make('some.other.command');
		const forkOwn = make('fork.own', 'paradis-menu-icon codicon codicon-add');
		const submenu = new SubmenuAction('sub', 'Sub', [make(TerminalCommandId.Paste)]);

		const decorated = paradisDecorateMenuActions([copy, new Separator(), kill, unknown, forkOwn, submenu]);
		decorated[0].run();
		const describe = (action: IAction): unknown => action instanceof SubmenuAction
			? { id: action.id, children: action.actions.map(describe) }
			: { id: action.id, class: action.class, enabled: action.enabled };

		assert.deepStrictEqual({
			decorated: decorated.map(describe),
			separatorKept: decorated[1] instanceof Separator,
			sameUnknown: decorated[3] === unknown && decorated[4] === forkOwn,
			originalClass: copy.class,
			runs,
		}, {
			decorated: [
				{ id: TerminalCommandId.CopySelection, class: 'paradis-menu-icon codicon-copy', enabled: true },
				{ id: Separator.ID, class: 'separator', enabled: false },
				{ id: TerminalCommandId.Kill, class: 'paradis-menu-icon codicon-trash paradis-menu-danger', enabled: true },
				{ id: 'some.other.command', class: '', enabled: true },
				{ id: 'fork.own', class: 'paradis-menu-icon codicon codicon-add', enabled: true },
				{ id: 'sub', children: [{ id: TerminalCommandId.Paste, class: 'paradis-menu-icon codicon-clippy', enabled: true }] },
			],
			separatorKept: true,
			sameUnknown: true,
			originalClass: '',
			runs: [TerminalCommandId.CopySelection],
		});
	});

	test('opens the terminal tab color submenu inline as a row of swatches', () => {
		const make = (key: string) => store.add(new Action(paradisTerminalTabColorCommandId(key), key, undefined, true));
		const colors = new SubmenuAction(`submenuitem.${PARADIS_TERMINAL_TAB_COLOR_SUBMENU_ID}`, 'Tab Color', [make('red'), new Separator(), make('none')]);
		const decorated = paradisDecorateMenuActions([new Separator(), colors, new Separator()]);

		assert.deepStrictEqual(decorated.map(action => ({ id: action.id, class: action.class, tooltip: action.tooltip })), [
			{ id: Separator.ID, class: 'separator', tooltip: '' },
			{ id: 'paradis.terminal.tabColor.red', class: 'paradis-menu-icon paradis-menu-color paradis-menu-swatch paradis-terminal-color-red', tooltip: 'red' },
			{ id: 'paradis.terminal.tabColor.none', class: 'paradis-menu-icon paradis-menu-color paradis-menu-swatch paradis-color-default', tooltip: 'none' },
			{ id: Separator.ID, class: 'separator', tooltip: '' },
		]);
	});
});
