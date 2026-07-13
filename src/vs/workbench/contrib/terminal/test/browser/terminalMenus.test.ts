/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains the PARA-CODE ownership marker)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { TerminalCommandId } from '../../common/terminal.js';
import { setupTerminalMenus } from '../../browser/terminalMenus.js';

function ensureTerminalMenusSetup(disposables: Pick<DisposableStore, 'add'>): void {
	if (!getMenuCommandIds(MenuId.TerminalTabEmptyAreaContext).includes(TerminalCommandId.New)) {
		setupTerminalMenus(disposables);
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
		const createItems = MenuRegistry.getMenuItems(MenuId.TerminalTabEmptyAreaContext)
			.filter(isIMenuItem)
			.filter(item => item.group === '1_create');

		deepStrictEqual(
			createItems.map(item => [item.command.id, item.order]),
			[
				[TerminalCommandId.SplitOrCreate, 1],
				[TerminalCommandId.NewWithProfile, 2],
				[TerminalCommandId.New, 3],
			],
		);
	});

	test('terminal instance context exposes create actions for empty terminal bodies', () => {
		const createItems = MenuRegistry.getMenuItems(MenuId.TerminalInstanceContext)
			.filter(isIMenuItem)
			.filter(item => item.group === '1_create');

		deepStrictEqual(createItems.map(item => [item.command.id, item.order]), [
			[TerminalCommandId.SplitOrCreate, 1],
			[TerminalCommandId.New, 2],
		]);
	});
});
