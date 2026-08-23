/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../../../base/common/observable.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuWorkbenchToolBar, IMenuWorkbenchToolBarOptions } from '../../../../../platform/actions/browser/toolbar.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { MOBILE_OPEN_CHANGES_VIEW_COMMAND_ID } from '../../../../browser/parts/mobile/contributions/mobileChangesView.js';
import { MOBILE_OPEN_DIFF_VIEW_COMMAND_ID } from '../../../../browser/parts/mobile/contributions/mobileDiffView.js';
import '../../browser/mobile/mobileOverlayContribution.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';

suite('Mobile changes overlay contribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens the single-file diff with the active session changes toolbar in overflow', async () => {
		const resource = URI.parse('test-session:/single');
		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add(toDisposable(() => container.remove()));
		const toolbarCalls: unknown[][] = [];
		const commandCalls: unknown[][] = [];
		const accessor = createAccessor(container, resource, [createChange(0)], toolbarCalls, commandCalls);
		const action = registerRepresentativePullRequestAction(store);

		await CommandsRegistry.getCommand(MOBILE_OPEN_CHANGES_VIEW_COMMAND_ID)!.handler(accessor);

		assertToolbarContract(container, toolbarCalls, resource, '.mobile-overlay-header');
		assert.deepStrictEqual({
			command: commandCalls[0]?.[0],
			resource: ((commandCalls[0]?.[1] as { sessionResource?: URI } | undefined)?.sessionResource)?.toString(),
			actionIsContributed: hasContributedAction(action),
		}, {
			command: MOBILE_OPEN_DIFF_VIEW_COMMAND_ID,
			resource: resource.toString(),
			actionIsContributed: true,
		});

		(container.querySelector('.mobile-overlay-back-btn') as HTMLButtonElement).click();
	});

	test('opens the multi-file diff with the active session changes toolbar in overflow', async () => {
		const resource = URI.parse('test-session:/multi');
		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add(toDisposable(() => container.remove()));
		const toolbarCalls: unknown[][] = [];
		const commandCalls: unknown[][] = [];
		const accessor = createAccessor(container, resource, [createChange(0), createChange(1)], toolbarCalls, commandCalls);
		const action = registerRepresentativePullRequestAction(store);

		await CommandsRegistry.getCommand(MOBILE_OPEN_CHANGES_VIEW_COMMAND_ID)!.handler(accessor);

		assertToolbarContract(container, toolbarCalls, resource, '.mobile-multi-diff-topbar');
		assert.deepStrictEqual({
			commandCount: commandCalls.length,
			actionIsContributed: hasContributedAction(action),
		}, {
			commandCount: 0,
			actionIsContributed: true,
		});

		(container.querySelector('.mobile-overlay-back-btn') as HTMLButtonElement).click();
	});
});

function createAccessor(container: HTMLElement, resource: URI, changes: readonly unknown[], toolbarCalls: unknown[][], commandCalls: unknown[][]): ServicesAccessor {
	const instantiationService = {
		createInstance(ctor: unknown, ...args: unknown[]) {
			assert.strictEqual(ctor, MenuWorkbenchToolBar);
			toolbarCalls.push(args);
			return toDisposable(() => { });
		},
	} as unknown as IInstantiationService;
	const commandService = {
		executeCommand(command: string, ...args: unknown[]) {
			commandCalls.push([command, ...args]);
			return CommandsRegistry.getCommand(command)!.handler(accessor, ...args);
		},
	} as unknown as ICommandService;
	const session = { resource, changes: constObservable(changes) } as unknown as IActiveSession;
	const services = new Map<unknown, unknown>([
		[ILayoutService, { mainContainer: container }],
		[ITextFileService, { read: () => Promise.resolve({ value: '' }) } as unknown as ITextFileService],
		[IFileService, {} as IFileService],
		[ILanguageService, { guessLanguageIdByFilepathOrFirstLine: () => 'plaintext' } as unknown as ILanguageService],
		[INotificationService, { info: () => assert.fail('changes should be available') } as unknown as INotificationService],
		[ISessionsService, { activeSession: constObservable(session) } as unknown as ISessionsService],
		[IInstantiationService, instantiationService],
		[ICommandService, commandService],
	]);
	const accessor = { get: id => services.get(id) } as ServicesAccessor;
	return accessor;
}

function createChange(index: number): unknown {
	return {
		originalUri: URI.parse(`test-session:/original-${index}`),
		modifiedUri: URI.parse(`test-session:/modified-${index}`),
		insertions: 1,
		deletions: 1,
	};
}

function registerRepresentativePullRequestAction(store: { add<T extends { dispose(): unknown }>(o: T): T }): string {
	const id = 'test.mobile.createPullRequest';
	store.add(MenuRegistry.appendMenuItem(MenuId.AgentsChangesToolbar, {
		command: { id, title: 'Create Pull Request' },
		group: 'test',
	}));
	return id;
}

function hasContributedAction(id: string): boolean {
	return MenuRegistry.getMenuItems(MenuId.AgentsChangesToolbar)
		.some(item => isIMenuItem(item) && item.command.id === id);
}

function assertToolbarContract(container: HTMLElement, toolbarCalls: unknown[][], resource: URI, headerSelector: string): void {
	const toolbar = container.querySelector(`${headerSelector} > .mobile-changes-toolbar`);
	assert.ok(toolbar, 'the active overlay should render its changes toolbar');
	const options = toolbarCalls[0]?.[2] as IMenuWorkbenchToolBarOptions | undefined;
	const primaryGroup = options?.toolbarOptions?.primaryGroup;
	assert.deepStrictEqual({
		menuId: toolbarCalls[0]?.[1] === MenuId.AgentsChangesToolbar,
		argument: (options?.menuOptions?.arg as URI | undefined)?.toString(),
		navigationIsPrimary: typeof primaryGroup === 'function' ? primaryGroup('navigation') : undefined,
		testIsPrimary: typeof primaryGroup === 'function' ? primaryGroup('test') : undefined,
	}, {
		menuId: true,
		argument: resource.toString(),
		navigationIsPrimary: false,
		testIsPrimary: false,
	});
}
