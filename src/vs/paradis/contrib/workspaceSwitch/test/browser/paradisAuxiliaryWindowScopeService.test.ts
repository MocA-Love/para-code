/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { getActiveWindow } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IAuxiliaryEditorPart, IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { TestLifecycleService, TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ParadisAuxiliaryWindowScopeService } from '../../browser/paradisAuxiliaryWindowScopeService.js';

const STORAGE_KEY = 'paradis.workspaceSwitch.auxiliaryWindowScopes';

suite('ParadisAuxiliaryWindowScopeService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(storage: TestStorageService, mainWindowId = 1, auxiliaryWindowId = 2): {
		readonly service: ParadisAuxiliaryWindowScopeService;
		readonly part: IAuxiliaryEditorPart;
		readonly addPart: (windowId: number, groupId: number) => IAuxiliaryEditorPart;
	} {
		const createPart = (windowId: number, groupId: number): IAuxiliaryEditorPart => {
			const onWillClose = disposables.add(new Emitter<void>());
			return {
				windowId,
				groups: [{ id: groupId }],
				onWillClose: onWillClose.event,
				close: () => true
			} as unknown as IAuxiliaryEditorPart;
		};
		const onDidCreatePart = disposables.add(new Emitter<IAuxiliaryEditorPart>());
		const mainPart = { windowId: mainWindowId };
		const part = createPart(auxiliaryWindowId, 10);
		const parts = [mainPart, part];
		const editorGroupsService = {
			mainPart,
			parts,
			whenReady: Promise.resolve(),
			onDidCreateAuxiliaryEditorPart: onDidCreatePart.event,
			onDidAddGroup: Event.None,
			onDidRemoveGroup: Event.None,
		} as unknown as IEditorGroupsService;
		const service = disposables.add(new ParadisAuxiliaryWindowScopeService(
			editorGroupsService,
			storage,
			disposables.add(new TestLifecycleService())
		));
		return {
			service,
			part,
			addPart: (windowId, groupId) => {
				const added = createPart(windowId, groupId);
				parts.push(added);
				onDidCreatePart.fire(added);
				return added;
			}
		};
	}

	test('adopts restored legacy windows after the managed scope becomes available', async () => {
		const storage = disposables.add(new TestStorageService());
		const { service, part } = createService(storage);
		await service.initializationBarrier;

		service.setMainScope('scope:a', true, false);

		assert.deepStrictEqual(service.resolvePart(part), { kind: 'managed', stateKey: 'scope:a' });
		assert.ok(storage.get(STORAGE_KEY, StorageScope.WORKSPACE));
	});

	test('keeps restored windows pending when persisted ownership is corrupt', async () => {
		const storage = disposables.add(new TestStorageService());
		storage.store(STORAGE_KEY, '{broken', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const { service, part } = createService(storage);
		await service.initializationBarrier;

		service.setMainScope('scope:a', true, false);

		assert.deepStrictEqual(service.resolvePart(part), { kind: 'pending' });
	});

	test('inherits the owner of the auxiliary window that created a new window', async () => {
		const storage = disposables.add(new TestStorageService());
		const activeWindowId = getActiveWindow().vscodeWindowId;
		const { service, part, addPart } = createService(storage, activeWindowId + 1000, activeWindowId);
		await service.initializationBarrier;
		service.setMainScope('scope:a', true, false);
		service.setMainScope('scope:b', true, false);

		const childPart = addPart(activeWindowId + 1, 20);

		assert.deepStrictEqual({
			source: service.resolvePart(part),
			child: service.resolvePart(childPart)
		}, {
			source: { kind: 'managed', stateKey: 'scope:a' },
			child: { kind: 'managed', stateKey: 'scope:a' }
		});
	});

	test('makes a surviving auxiliary window unscoped when its scope is retired', async () => {
		const storage = disposables.add(new TestStorageService());
		const { service, part } = createService(storage);
		await service.initializationBarrier;
		service.setMainScope('scope:a', true, false);

		service.commitScopeRetirement('scope:a');

		assert.deepStrictEqual(service.resolvePart(part), { kind: 'unscoped' });
		assert.strictEqual(service.getPinnedParts('scope:a').length, 0);
	});
});
