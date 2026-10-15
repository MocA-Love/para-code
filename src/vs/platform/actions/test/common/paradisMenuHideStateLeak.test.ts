/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import sinon from 'sinon';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../base/common/errors.js';
import { setGlobalLeakWarningThreshold } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { MenuId } from '../../common/actions.js';
import { MenuService } from '../../common/menuService.js';
import { NullCommandService } from '../../../commands/test/common/nullCommandService.js';
import { MockContextKeyService, MockKeybindingService } from '../../../keybinding/test/common/mockKeybindingService.js';
import { InMemoryStorageService } from '../../../storage/common/storage.js';

suite('Para Code menu hide state listeners', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		sinon.restore();
	});

	test('hundreds of listened menus stay below the leak warning, a runaway count is still reported', () => {
		sinon.stub(console, 'warn');
		const origErrorHandler = errorHandler.getUnexpectedErrorHandler();
		const errors: string[] = [];
		setUnexpectedErrorHandler(error => errors.push(error.message));
		// The workbench sets 175 before the menu service exists, so its emitters capture it.
		const restoreThreshold = setGlobalLeakWarningThreshold(175);
		try {
			const menuService = disposables.add(new MenuService(NullCommandService, new MockKeybindingService(), disposables.add(new InMemoryStorageService())));
			const contextKeyService = new MockContextKeyService();
			const menus = disposables.add(new DisposableStore());
			const listenMenus = (count: number) => {
				for (let i = 0; i < count; i++) {
					const menu = menus.add(menuService.createMenu(new MenuId(`paradisLeak/${generateUuid()}`), contextKeyService));
					menus.add(menu.onDidChange(() => { }));
				}
			};

			// Every MenuImpl with a listener subscribes once to the shared hide state.
			listenMenus(300);
			const errorsAtLargeWindow = [...errors];
			listenMenus(250);

			assert.deepStrictEqual({ errorsAtLargeWindow, errorsAtRunaway: errors }, {
				errorsAtLargeWindow: [],
				errorsAtRunaway: ['[PersistedMenuHideState._onDidChange] potential listener LEAK detected, popular'],
			});
		} finally {
			restoreThreshold.dispose();
			setUnexpectedErrorHandler(origErrorHandler);
		}
	});
});
