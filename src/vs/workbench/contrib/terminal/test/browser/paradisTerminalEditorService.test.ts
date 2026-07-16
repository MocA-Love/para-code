/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorCloseContext, type IEditorCloseEvent, type IEditorPane } from '../../../../common/editor.js';
import type { ITerminalEditorService, ITerminalInstance, ITerminalInstanceService } from '../../browser/terminal.js';
import type { TerminalEditorService } from '../../browser/terminalEditorService.js';
import type { TerminalEditorInput } from '../../browser/terminalEditorInput.js';
import type { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';

suite('Paradis TerminalEditorService exact group', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let TerminalEditorServiceCtor: typeof import('../../browser/terminalEditorService.js').TerminalEditorService;

	suiteSetup(async () => {
		(globalThis as typeof globalThis & { MouseEvent: typeof MouseEvent }).MouseEvent ??= class { } as unknown as typeof MouseEvent;
		({ TerminalEditorService: TerminalEditorServiceCtor } = await import('../../browser/terminalEditorService.js'));
	});

	test('rechecks exact group object identity after the editor open resolves', async () => {
		const group = { id: 11 } as IEditorGroup;
		const replacement = { id: 11 } as IEditorGroup;
		let liveGroup = group;
		let resolveOpen!: (pane: IEditorPane) => void;
		const openPromise = new Promise<IEditorPane>(resolve => resolveOpen = resolve);
		const service = createService(() => openPromise, () => liveGroup);
		const instance = createInstance(1);

		const operation = service.openEditor(instance, { viewColumn: group.id, paradisExactEditorGroup: group });
		liveGroup = replacement;
		resolveOpen({ group } as IEditorPane);

		await assert.rejects(operation, /destination editor group is no longer available/i);
		assert.strictEqual(getActiveRequest(service), undefined);
	});

	test('a rejected open request does not poison or overlap the next request', async () => {
		const group = { id: 12 } as IEditorGroup;
		let rejectFirst!: (error: Error) => void;
		const firstOpen = new Promise<IEditorPane>((_resolve, reject) => rejectFirst = reject);
		let openCount = 0;
		const service = createService(
			() => ++openCount === 1 ? firstOpen : Promise.resolve({ group } as IEditorPane),
			() => group,
		);

		const first = service.openEditor(createInstance(1), { viewColumn: group.id, paradisExactEditorGroup: group });
		const second = service.openEditor(createInstance(2), { viewColumn: group.id, paradisExactEditorGroup: group });
		assert.strictEqual(openCount, 1);
		rejectFirst(new Error('first failed'));

		await assert.rejects(first, /first failed/);
		await second;
		assert.strictEqual(openCount, 2);
		assert.strictEqual(getActiveRequest(service), undefined);
	});

	test('passes the exact group object to the editor service without numeric-id fallback', async () => {
		const group = { id: 13 } as IEditorGroup;
		let preferredGroup: unknown;
		const service = createService(
			(_editor, groupArg) => {
				preferredGroup = groupArg;
				return Promise.resolve({ group } as IEditorPane);
			},
			() => group,
		);

		await service.openEditor(createInstance(3), { viewColumn: group.id, paradisExactEditorGroup: group });

		assert.strictEqual(preferredGroup, group);
	});

	function createService(
		openEditor: (...args: unknown[]) => Promise<IEditorPane | undefined>,
		getGroup: () => IEditorGroup | undefined,
	): ITerminalEditorService {
		const editorService = {
			activeEditor: undefined,
			activeEditorPane: undefined,
			visibleEditors: [],
			onDidActiveEditorChange: Event.None,
			onDidVisibleEditorsChange: Event.None,
			onDidCloseEditor: Event.None,
			openEditor: openEditor as IEditorService['openEditor'],
		} as Partial<IEditorService> as IEditorService;
		const editorGroupsService = {
			getGroup: () => getGroup(),
		} as Partial<IEditorGroupsService> as IEditorGroupsService;
		const service = store.add(new TerminalEditorServiceCtor(
			editorService,
			editorGroupsService,
			{} as ITerminalInstanceService,
			{} as IInstantiationService,
			{ onWillShutdown: Event.None } as ILifecycleService,
			{
				createKey: () => ({ set() { }, reset() { }, get: () => false }),
			} as Partial<IContextKeyService> as IContextKeyService,
		));
		service.resolveResource = instance => instance.resource;
		return service;
	}
});

suite('Paradis TerminalEditorService move bookkeeping', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let TerminalEditorServiceCtor: typeof import('../../browser/terminalEditorService.js').TerminalEditorService;
	let TerminalEditorInputCtor: typeof import('../../browser/terminalEditorInput.js').TerminalEditorInput;

	suiteSetup(async () => {
		(globalThis as typeof globalThis & { MouseEvent: typeof MouseEvent }).MouseEvent ??= class { } as unknown as typeof MouseEvent;
		({ TerminalEditorService: TerminalEditorServiceCtor } = await import('../../browser/terminalEditorService.js'));
		({ TerminalEditorInput: TerminalEditorInputCtor } = await import('../../browser/terminalEditorInput.js'));
	});

	test('keeps the instance on a MOVE close while the editor is still open in another group', () => {
		const { service, onDidCloseEditor, groups } = createMoveService();
		const instance = createListenerInstance(1);
		const input = createInput(instance);
		service.instances.push(instance);
		groups.push({ contains: candidate => candidate === input } as Partial<IEditorGroup> as IEditorGroup);

		onDidCloseEditor.fire({ editor: input, context: EditorCloseContext.MOVE, groupId: 0, index: 0, sticky: false });

		assert.deepStrictEqual(service.instances.map(i => i.instanceId), [1]);
	});

	test('still removes the instance on a MOVE close when the editor is open nowhere', () => {
		const { service, onDidCloseEditor, groups } = createMoveService();
		const instance = createListenerInstance(2);
		const input = createInput(instance);
		service.instances.push(instance);
		groups.push({ contains: () => false } as Partial<IEditorGroup> as IEditorGroup);

		onDidCloseEditor.fire({ editor: input, context: EditorCloseContext.MOVE, groupId: 0, index: 0, sticky: false });

		assert.deepStrictEqual(service.instances, []);
	});

	test('removes the instance on a regular close even when the editor would match a group', () => {
		const { service, onDidCloseEditor, groups } = createMoveService();
		const instance = createListenerInstance(3);
		const input = createInput(instance);
		service.instances.push(instance);
		groups.push({ contains: candidate => candidate === input } as Partial<IEditorGroup> as IEditorGroup);

		onDidCloseEditor.fire({ editor: input, context: EditorCloseContext.UNKNOWN, groupId: 0, index: 0, sticky: false });

		assert.deepStrictEqual(service.instances, []);
	});

	function createMoveService(): { service: TerminalEditorService; onDidCloseEditor: Emitter<IEditorCloseEvent>; groups: IEditorGroup[] } {
		const onDidCloseEditor = store.add(new Emitter<IEditorCloseEvent>());
		const groups: IEditorGroup[] = [];
		const editorService = {
			activeEditor: undefined,
			activeEditorPane: undefined,
			visibleEditors: [],
			onDidActiveEditorChange: Event.None,
			onDidVisibleEditorsChange: Event.None,
			onDidCloseEditor: onDidCloseEditor.event,
		} as Partial<IEditorService> as IEditorService;
		const editorGroupsService = {
			get groups() { return groups; },
		} as Partial<IEditorGroupsService> as IEditorGroupsService;
		const service = store.add(new TerminalEditorServiceCtor(
			editorService,
			editorGroupsService,
			{} as ITerminalInstanceService,
			{} as IInstantiationService,
			{ onWillShutdown: Event.None } as ILifecycleService,
			contextKeyService(),
		));
		return { service, onDidCloseEditor, groups };
	}

	function createInput(instance: ITerminalInstance): TerminalEditorInput {
		const input = store.add(new TerminalEditorInputCtor(
			instance.resource,
			instance,
			{} as IThemeService,
			{} as ITerminalInstanceService,
			{} as IInstantiationService,
			{} as IConfigurationService,
			{ onWillShutdown: Event.None } as ILifecycleService,
			contextKeyService(),
			{} as IDialogService,
		));
		return input;
	}

	function contextKeyService(): IContextKeyService {
		return {
			createKey: () => ({ set() { }, reset() { }, get: () => false }),
		} as Partial<IContextKeyService> as IContextKeyService;
	}

	function createListenerInstance(instanceId: number): ITerminalInstance {
		return {
			instanceId,
			resource: URI.parse(`vscode-terminal:/test/${instanceId}`),
			description: undefined,
			shellLaunchConfig: {},
			onDidFocus: Event.None,
			onDidBlur: Event.None,
			onExit: Event.None,
			onDisposed: Event.None,
			onTitleChanged: Event.None,
			onIconChanged: Event.None,
			statusList: { onDidChangePrimaryStatus: Event.None },
			dispose: () => { },
			resetFocusContextKey: () => { },
		} as Partial<ITerminalInstance> as ITerminalInstance;
	}
});

function createInstance(instanceId: number): ITerminalInstance {
	return {
		instanceId,
		resource: URI.parse(`vscode-terminal:/test/${instanceId}`),
		description: undefined,
		shellLaunchConfig: {},
	} as Partial<ITerminalInstance> as ITerminalInstance;
}

function getActiveRequest(service: ITerminalEditorService): unknown {
	return (service as TerminalEditorService as unknown as { _activeOpenEditorRequest?: unknown })._activeOpenEditorRequest;
}
