/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { mock } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IMenuWorkbenchToolBarOptions, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { MobileChangesView } from '../../browser/parts/mobile/contributions/mobileChangesView.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { IActiveSession } from '../../services/sessions/common/sessionsManagement.js';

suite('MobileChangesView', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('renders AgentsChangesToolbar as overflow with the active session resource', () => {
		const resource = URI.parse('test-session:/active');
		const session = {
			resource,
			changes: constObservable([]),
		} as unknown as IActiveSession;
		let toolbarArgs: unknown[] | undefined;
		const toolbar = new class extends mock<MenuWorkbenchToolBar>() {
			override dispose(): void { }
		};
		const instantiationService = {
			createInstance(ctor: unknown, ...args: unknown[]) {
				assert.strictEqual(ctor, MenuWorkbenchToolBar);
				toolbarArgs = args;
				return toolbar;
			},
		} as unknown as IInstantiationService;
		const sessionsService = {
			activeSession: constObservable(session),
		} as unknown as ISessionsService;
		const container = document.createElement('div');

		store.add(new MobileChangesView(container, () => { }, instantiationService, sessionsService));

		assert.ok(toolbarArgs);
		const options = toolbarArgs[2] as IMenuWorkbenchToolBarOptions;
		const primaryGroup = options.toolbarOptions?.primaryGroup;
		const header = container.querySelector('.mobile-overlay-header');
		assert.ok(header);
		assert.deepStrictEqual({
			menuId: toolbarArgs[1] === MenuId.AgentsChangesToolbar,
			argument: (options.menuOptions?.arg as URI | undefined)?.toString(),
			navigationIsPrimary: typeof primaryGroup === 'function' ? primaryGroup('navigation') : undefined,
			headerChildren: Array.from(header.children, child => child.className),
		}, {
			menuId: true,
			argument: resource.toString(),
			navigationIsPrimary: false,
			headerChildren: ['mobile-overlay-back-btn', 'mobile-overlay-header-info', 'mobile-changes-toolbar'],
		});
	});
});
