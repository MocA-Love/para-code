/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { hasKey } from '../../../../../base/common/types.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IParadisEditorSplitTerminalService } from '../../../../../workbench/services/editor/common/paradisEditorSplitTerminalService.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import type { ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';

let ParadisEditorSplitTerminalService: typeof import('../../browser/paradisEditorSplitTerminalService.js').ParadisEditorSplitTerminalService;

suite('ParadisEditorSplitTerminalService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suiteSetup(async () => {
		(globalThis as typeof globalThis & { MouseEvent: typeof MouseEvent }).MouseEvent ??= class { } as unknown as typeof MouseEvent;
		({ ParadisEditorSplitTerminalService } = await import('../../browser/paradisEditorSplitTerminalService.js'));
	});

	test('setting OFF leaves the destination group empty', async () => {
		const harness = createHarness(false, undefined, store);

		await harness.service.openTerminalInGroup(harness.group);

		assert.strictEqual(harness.createOptions.length, 0);
		assert.strictEqual(harness.focused.length, 0);
		assert.strictEqual(harness.notifications.length, 0);
	});

	test('setting ON creates a fresh terminal in the exact destination group and focuses it', async () => {
		const harness = createHarness(true, undefined, store);

		await harness.service.openTerminalInGroup(harness.group);
		await harness.service.openTerminalInGroup(harness.group);

		assert.strictEqual(harness.createOptions.length, 2);
		for (const options of harness.createOptions) {
			assert.ok(options);
			assert.ok(options.location && typeof options.location === 'object' && hasKey(options.location, { viewColumn: true }));
			assert.strictEqual(options.location.viewColumn, harness.group.id);
			assert.strictEqual(options.paradisExactEditorGroup, harness.group);
			assert.strictEqual(options.skipContributedProfileCheck, true);
		}
		assert.notStrictEqual(harness.created[0], harness.created[1]);
		assert.deepStrictEqual(harness.focused, harness.created);
	});

	test('disposes a terminal created after the exact destination group was disposed', async () => {
		let resolveCreate!: (instance: ITerminalInstance) => void;
		const createPromise = new Promise<ITerminalInstance>(resolve => resolveCreate = resolve);
		const harness = createHarness(true, createPromise, store);

		const operation = harness.service.openTerminalInGroup(harness.group);
		harness.disposeGroup();
		const lateInstance = createInstance(99);
		resolveCreate(lateInstance);
		await operation;

		assert.strictEqual(lateInstance.isDisposed, true);
		assert.strictEqual(harness.focused.length, 0);
		assert.strictEqual(harness.notifications.length, 1);
	});

	test('reports terminal creation failure without removing the destination group', async () => {
		const harness = createHarness(true, Promise.reject(new Error('create failed')), store);

		await harness.service.openTerminalInGroup(harness.group);

		assert.strictEqual(harness.groupRemoved, false);
		assert.strictEqual(harness.notifications.length, 1);
	});
});

function createHarness(enabled: boolean, createResult: Promise<ITerminalInstance> | undefined, store: Pick<DisposableStore, 'add'>): {
	service: IParadisEditorSplitTerminalService;
	group: IEditorGroup;
	disposeGroup: () => void;
	readonly groupRemoved: boolean;
	createOptions: Parameters<ITerminalService['createTerminal']>[0][];
	created: ITerminalInstance[];
	focused: ITerminalInstance[];
	notifications: string[];
} {
	const onWillDispose = store.add(new Emitter<void>());
	let groupRemoved = false;
	const group = {
		id: 47,
		onWillDispose: onWillDispose.event,
	} as IEditorGroup;
	const createOptions: Parameters<ITerminalService['createTerminal']>[0][] = [];
	const created: ITerminalInstance[] = [];
	const focused: ITerminalInstance[] = [];
	let nextId = 1;
	const terminalService = {
		async createTerminal(options) {
			createOptions.push(options);
			if (createResult) {
				const instance = await createResult;
				created.push(instance);
				return instance;
			}
			const instance = createInstance(nextId++);
			created.push(instance);
			return instance;
		},
		async focusInstance(instance) {
			focused.push(instance);
		},
	} as Partial<ITerminalService> as ITerminalService;
	const configurationService = new TestConfigurationService({
		paradis: { editor: { openTerminalOnSplit: enabled } }
	});
	const notifications: string[] = [];
	const notificationService = {
		error: (message: string | Error) => {
			notifications.push(message instanceof Error ? message.message : message);
		}
	} as Partial<INotificationService> as INotificationService;
	const editorGroupsService = {
		getGroup: (id: number) => id === group.id && !groupRemoved ? group : undefined,
	} as Partial<IEditorGroupsService> as IEditorGroupsService;
	const service = store.add(new ParadisEditorSplitTerminalService(
		configurationService,
		terminalService,
		editorGroupsService,
		notificationService,
	));
	return {
		service,
		group,
		disposeGroup: () => {
			groupRemoved = true;
			onWillDispose.fire();
		},
		get groupRemoved() { return groupRemoved; },
		createOptions,
		created,
		focused,
		notifications,
	};
}

function createInstance(instanceId: number): ITerminalInstance {
	let disposed = false;
	return {
		instanceId,
		get isDisposed() { return disposed; },
		dispose() { disposed = true; },
	} as Partial<ITerminalInstance> as ITerminalInstance;
}
