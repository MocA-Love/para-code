/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, ok } from 'assert';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { TerminalCommandId } from '../../common/terminal.js';
import { setupTerminalMenus } from '../../browser/terminalMenus.js';

function ensureTerminalMenusSetup(disposables: Pick<{ add(disposable: IDisposable): IDisposable }, 'add'>): void {
	if (!getMenuCommandIds(MenuId.TerminalTabEmptyAreaContext).includes(TerminalCommandId.New)) {
		disposables.add(setupTerminalMenus());
	}
}

function getMenuCommandIds(menuId: MenuId): string[] {
	const commandIds: string[] = [];
	for (const item of MenuRegistry.getMenuItems(menuId)) {
		if (isIMenuItem(item)) {
			commandIds.push(item.command.id);
		}
	}
	return commandIds;
}

suite('terminalMenus', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => {
		ensureTerminalMenusSetup(disposables);
	});

	test('empty terminal tab area exposes create and split actions', () => {
		const commandIds = getMenuCommandIds(MenuId.TerminalTabEmptyAreaContext);

		deepStrictEqual(
			[
				commandIds.includes(TerminalCommandId.NewWithProfile),
				commandIds.includes(TerminalCommandId.New),
				commandIds.includes(TerminalCommandId.SplitOrCreate)
			],
			[true, true, true]
		);
	});

	test('terminal instance context exposes create actions for empty terminal bodies', () => {
		const commandIds = getMenuCommandIds(MenuId.TerminalInstanceContext);

		ok(commandIds.includes(TerminalCommandId.New));
		ok(commandIds.includes(TerminalCommandId.SplitOrCreate));
	});
});
