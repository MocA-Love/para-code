/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { type DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { type IShellLaunchConfig, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import type { IPaneCompositePartService } from '../../../../../workbench/services/panecomposite/browser/panecomposite.js';
import type { IWorkbenchLayoutService } from '../../../../../workbench/services/layout/browser/layoutService.js';
import type { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { Direction, type ITerminalConfigurationService, type ITerminalEditorService, type ITerminalGroup, type ITerminalGroupService, type ITerminalInstance, type ITerminalInstanceService, type ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { SessionTerminalGridGroup } from '../../browser/sessionTerminalGridGroup.js';

interface ITestTerminalInstance {
	readonly instance: ITerminalInstance;
	readonly focusCalls: Array<boolean | undefined>;
	readonly listenerCounts: {
		readonly capabilities: number;
		readonly disposed: number;
		readonly focus: number;
	};
	fireCapabilities(): void;
	fireDisposed(): void;
	fireFocus(): void;
}

interface ITestTerminalOptions {
	readonly hadFocusOnExit?: boolean;
	readonly persistentProcessId?: number;
	readonly shouldPersist?: boolean;
	readonly target?: TerminalLocation;
}

interface ITestHarness {
	readonly createdInstances: ITestTerminalInstance[];
	readonly detachedInstances: ITerminalInstance[];
	readonly detachRecords: Array<{ readonly instanceId: number; readonly wasInGridAtDetach: boolean }>;
	readonly liveInstances: ITerminalInstance[];
	readonly sourceGroups: Map<ITerminalInstance, ITerminalGroup>;
	createGroup(initial?: ITerminalInstance): SessionTerminalGridGroup;
	createTerminal(options?: ITestTerminalOptions): ITestTerminalInstance;
}

function createTestHarness(disposables: Pick<DisposableStore, 'add'>): ITestHarness {
	let nextInstanceId = 1;
	const createdInstances: ITestTerminalInstance[] = [];
	const detachedInstances: ITerminalInstance[] = [];
	const detachRecords: Array<{ readonly instanceId: number; readonly wasInGridAtDetach: boolean }> = [];
	const liveInstances: ITerminalInstance[] = [];
	const testInstances: ITestTerminalInstance[] = [];
	const sourceGroups = new Map<ITerminalInstance, ITerminalGroup>();
	const groups: SessionTerminalGridGroup[] = [];

	const createTerminal = (options: ITestTerminalOptions = {}): ITestTerminalInstance => {
		const instanceId = nextInstanceId++;
		const listenerCounts = {
			capabilities: 0,
			disposed: 0,
			focus: 0,
		};
		const onDisposed = disposables.add(new Emitter<ITerminalInstance>({
			onDidAddListener: () => listenerCounts.disposed++,
			onWillRemoveListener: () => listenerCounts.disposed--,
		}));
		const onDidFocus = disposables.add(new Emitter<ITerminalInstance>({
			onDidAddListener: () => listenerCounts.focus++,
			onWillRemoveListener: () => listenerCounts.focus--,
		}));
		const onDidChangeCapabilities = disposables.add(new Emitter<void>({
			onDidAddListener: () => listenerCounts.capabilities++,
			onWillRemoveListener: () => listenerCounts.capabilities--,
		}));
		const focusCalls: Array<boolean | undefined> = [];

		const instance = {
			instanceId,
			resource: URI.parse(`vscode-terminal:/test/${instanceId}`),
			title: `terminal ${instanceId}`,
			description: undefined,
			statusList: { statuses: [] } as Partial<ITerminalInstance['statusList']> as ITerminalInstance['statusList'],
			persistentProcessId: options.persistentProcessId,
			shouldPersist: options.shouldPersist ?? false,
			hadFocusOnExit: options.hadFocusOnExit ?? false,
			target: options.target ?? TerminalLocation.Panel,
			onDisposed: onDisposed.event,
			onDidFocus: onDidFocus.event,
			capabilities: {
				onDidChangeCapabilities: onDidChangeCapabilities.event,
			} as Partial<ITerminalInstance['capabilities']> as ITerminalInstance['capabilities'],
			focus: (force?: boolean) => focusCalls.push(force),
			attachToElement: () => { },
			detachFromElement: () => { },
			layout: () => { },
			setVisible: () => { },
		} as Partial<ITerminalInstance> as ITerminalInstance;

		const testInstance: ITestTerminalInstance = {
			instance,
			focusCalls,
			listenerCounts,
			fireCapabilities: () => onDidChangeCapabilities.fire(),
			fireDisposed: () => onDisposed.fire(instance),
			fireFocus: () => onDidFocus.fire(instance),
		};
		liveInstances.push(instance);
		testInstances.push(testInstance);
		return testInstance;
	};

	const terminalInstanceService = {
		createInstance: (_shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation) => {
			const terminal = createTerminal({ target });
			createdInstances.push(terminal);
			return terminal.instance;
		},
	} as Partial<ITerminalInstanceService> as ITerminalInstanceService;
	const terminalGroupService = {
		getGroupForInstance: (instance: ITerminalInstance) => sourceGroups.get(instance),
	} as Partial<ITerminalGroupService> as ITerminalGroupService;
	const terminalService = {
		get instances() { return liveInstances; },
	} as Partial<ITerminalService> as ITerminalService;
	const terminalEditorService = {
		detachInstance: (instance: ITerminalInstance) => {
			detachedInstances.push(instance);
			detachRecords.push({
				instanceId: instance.instanceId,
				wasInGridAtDetach: groups.some(group => group.terminalInstances.includes(instance)),
			});
		},
	} as Partial<ITerminalEditorService> as ITerminalEditorService;

	disposables.add(toDisposable(() => {
		for (const testInstance of testInstances) {
			if (testInstance.listenerCounts.disposed > 0) {
				testInstance.fireDisposed();
			}
		}
	}));

	return {
		createdInstances,
		detachedInstances,
		detachRecords,
		liveInstances,
		sourceGroups,
		createTerminal,
		createGroup: initial => {
			const group = disposables.add(new SessionTerminalGridGroup(
				undefined,
				initial,
				{} as ITerminalConfigurationService,
				terminalInstanceService,
				{} as IPaneCompositePartService,
				{} as IWorkbenchLayoutService,
				{} as IViewDescriptorService,
				{} as IInstantiationService,
				terminalGroupService,
				terminalService,
				terminalEditorService,
			));
			groups.push(group);
			return group;
		},
	};
}

suite('SessionTerminalGridGroup', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('adds an instance after its requested parent without changing the active instance', () => {
		const harness = createTestHarness(disposables);
		const first = harness.createTerminal();
		const second = harness.createTerminal();
		const third = harness.createTerminal();
		const group = harness.createGroup(first.instance);

		group.addInstance(second.instance);
		group.addInstance(third.instance, first.instance.instanceId);

		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstanceId: group.activeInstance?.instanceId,
			},
			{
				instanceIds: [first.instance.instanceId, third.instance.instanceId, second.instance.instanceId],
				activeInstanceId: first.instance.instanceId,
			},
		);
	});

	test('splits after the reference instance and makes the new instance active', () => {
		const harness = createTestHarness(disposables);
		const first = harness.createTerminal();
		const second = harness.createTerminal();
		const group = harness.createGroup(first.instance);
		group.addInstance(second.instance);

		group.splitInDirection(first.instance, Direction.Down);

		const created = harness.createdInstances[0].instance;
		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstanceId: group.activeInstance?.instanceId,
			},
			{
				instanceIds: [first.instance.instanceId, created.instanceId, second.instance.instanceId],
				activeInstanceId: created.instanceId,
			},
		);
	});

	test('ignores a split whose reference instance is not in the group', () => {
		const harness = createTestHarness(disposables);
		const first = harness.createTerminal();
		const unknown = harness.createTerminal();
		const group = harness.createGroup(first.instance);

		group.splitInDirection(unknown.instance, Direction.Right);

		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstanceId: group.activeInstance?.instanceId,
				createdInstanceCount: harness.createdInstances.length,
			},
			{
				instanceIds: [first.instance.instanceId],
				activeInstanceId: first.instance.instanceId,
				createdInstanceCount: 0,
			},
		);
	});

	test('wraps previous and next pane focus at both ends', () => {
		const harness = createTestHarness(disposables);
		const first = harness.createTerminal();
		const second = harness.createTerminal();
		const third = harness.createTerminal();
		const group = harness.createGroup(first.instance);
		group.addInstance(second.instance);
		group.addInstance(third.instance);

		group.focusPreviousPane();
		const previousFromFirst = group.activeInstance;
		group.focusNextPane();
		const nextFromLast = group.activeInstance;

		assert.deepStrictEqual(
			[previousFromFirst?.instanceId, nextFromLast?.instanceId],
			[second.instance.instanceId, first.instance.instanceId],
		);
	});

	test('removing the active instance activates and focuses the pane that takes its place', () => {
		const harness = createTestHarness(disposables);
		const first = harness.createTerminal();
		const second = harness.createTerminal();
		const third = harness.createTerminal();
		const group = harness.createGroup(first.instance);
		group.addInstance(second.instance);
		group.addInstance(third.instance);
		group.setActiveInstanceByIndex(2);

		group.removeInstance(second.instance);

		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstanceId: group.activeInstance?.instanceId,
				focusCalls: third.focusCalls,
			},
			{
				instanceIds: [first.instance.instanceId, third.instance.instanceId],
				activeInstanceId: third.instance.instanceId,
				focusCalls: [true],
			},
		);
	});

	test('removing the final instance preserves its focus state and disposes the group', () => {
		const harness = createTestHarness(disposables);
		const terminal = harness.createTerminal({ hadFocusOnExit: true });
		const group = harness.createGroup(terminal.instance);
		const disposedGroups: ITerminalGroup[] = [];
		disposables.add(group.onDisposed(disposedGroup => disposedGroups.push(disposedGroup)));

		group.removeInstance(terminal.instance);

		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstance: group.activeInstance,
				hadFocusOnExit: group.hadFocusOnExit,
				disposedGroups,
			},
			{
				instanceIds: [],
				activeInstance: undefined,
				hadFocusOnExit: true,
				disposedGroups: [group],
			},
		);
	});

	test('removing an instance releases its event listeners', () => {
		const harness = createTestHarness(disposables);
		const first = harness.createTerminal();
		const second = harness.createTerminal();
		const group = harness.createGroup(first.instance);
		group.addInstance(second.instance);
		const disposedInstances: ITerminalInstance[] = [];
		disposables.add(group.onDidDisposeInstance(instance => disposedInstances.push(instance)));
		const listenerCountsAfterAdd = { ...first.listenerCounts };

		group.removeInstance(first.instance);

		assert.doesNotThrow(() => first.fireFocus());
		first.fireDisposed();
		assert.deepStrictEqual(
			{
				activeInstanceId: group.activeInstance?.instanceId,
				disposedInstances,
				listenerCountsAfterAdd,
				listenerCountsAfterRemove: first.listenerCounts,
			},
			{
				activeInstanceId: second.instance.instanceId,
				disposedInstances: [],
				listenerCountsAfterAdd: {
					capabilities: 1,
					disposed: 1,
					focus: 1,
				},
				listenerCountsAfterRemove: {
					capabilities: 0,
					disposed: 0,
					focus: 0,
				},
			},
		);
	});

	test('disposing the final instance releases its event listeners', () => {
		const harness = createTestHarness(disposables);
		const terminal = harness.createTerminal();
		const group = harness.createGroup(terminal.instance);
		const listenerCountsAfterAdd = { ...terminal.listenerCounts };

		terminal.fireDisposed();
		const listenerCountsAfterDispose = { ...terminal.listenerCounts };

		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstance: group.activeInstance,
				listenerCountsAfterAdd,
				listenerCountsAfterDispose,
			},
			{
				instanceIds: [],
				activeInstance: undefined,
				listenerCountsAfterAdd: {
					capabilities: 1,
					disposed: 1,
					focus: 1,
				},
				listenerCountsAfterDispose: {
					capabilities: 0,
					disposed: 0,
					focus: 0,
				},
			},
		);
	});

	test('ignores a move whose source and reference are the same instance', () => {
		const harness = createTestHarness(disposables);
		const reference = harness.createTerminal();
		const group = harness.createGroup(reference.instance);

		group.moveInstanceInDirection(reference.instance, reference.instance, Direction.Left);

		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstanceId: group.activeInstance?.instanceId,
			},
			{
				instanceIds: [reference.instance.instanceId],
				activeInstanceId: reference.instance.instanceId,
			},
		);
	});

	test('ignores a move to a reference that is not in the group', () => {
		const harness = createTestHarness(disposables);
		const reference = harness.createTerminal();
		const unknownReference = harness.createTerminal();
		const liveSource = harness.createTerminal();
		const group = harness.createGroup(reference.instance);

		group.moveInstanceInDirection(liveSource.instance, unknownReference.instance, Direction.Right);

		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstanceId: group.activeInstance?.instanceId,
			},
			{
				instanceIds: [reference.instance.instanceId],
				activeInstanceId: reference.instance.instanceId,
			},
		);
	});

	test('ignores a stale source when the reference is valid', () => {
		const harness = createTestHarness(disposables);
		const reference = harness.createTerminal();
		const staleSource = harness.createTerminal();
		const group = harness.createGroup(reference.instance);
		harness.liveInstances.splice(harness.liveInstances.indexOf(staleSource.instance), 1);

		group.moveInstanceInDirection(staleSource.instance, reference.instance, Direction.Down);

		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstanceId: group.activeInstance?.instanceId,
			},
			{
				instanceIds: [reference.instance.instanceId],
				activeInstanceId: reference.instance.instanceId,
			},
		);
	});

	test('moving an editor terminal detaches it before adding it to the grid', () => {
		const harness = createTestHarness(disposables);
		const reference = harness.createTerminal();
		const source = harness.createTerminal({ target: TerminalLocation.Editor });
		const group = harness.createGroup(reference.instance);

		group.moveInstanceInDirection(source.instance, reference.instance, Direction.Right);

		assert.deepStrictEqual(
			{
				instanceIds: group.terminalInstances.map(instance => instance.instanceId),
				activeInstanceId: group.activeInstance?.instanceId,
				sourceTarget: source.instance.target,
				detachedInstanceIds: harness.detachedInstances.map(instance => instance.instanceId),
				detachRecords: harness.detachRecords,
			},
			{
				instanceIds: [reference.instance.instanceId, source.instance.instanceId],
				activeInstanceId: source.instance.instanceId,
				sourceTarget: TerminalLocation.Panel,
				detachedInstanceIds: [source.instance.instanceId],
				detachRecords: [{
					instanceId: source.instance.instanceId,
					wasInGridAtDetach: false,
				}],
			},
		);
	});
});
