/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorExtensions, EditorInputCapabilities, IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import { SideBySideEditorInput } from '../../../../../workbench/common/editor/sideBySideEditorInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { ConfirmResult, IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IWorkingCopyBackupService } from '../../../../../workbench/services/workingCopy/common/workingCopyBackup.js';
import { IWorkingCopyBackupRestoreRouter, WorkingCopyBackupRestoreDecision, WorkingCopyBackupRestoreRouter } from '../../../../../workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.js';
import { IWorkingCopy, IWorkingCopyIdentifier } from '../../../../../workbench/services/workingCopy/common/workingCopy.js';
import { IWorkingCopyEditorService } from '../../../../../workbench/services/workingCopy/common/workingCopyEditorService.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { createEditorParts, registerTestEditor, TestFileDialogService, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestWorkingCopy } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { paradisEditorRequiresScopedLiveState, ParadisEditorScopeService } from '../../browser/paradisEditorScopeService.js';
import { ParadisWorkingCopyOwnerLedger } from '../../common/paradisEditorScope.js';
import { IParadisAuxiliaryWindowScopeService } from '../../common/paradisWorkspaceSwitch.js';

suite('ParadisEditorScopeService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function input(name: string): TestFileEditorInput {
		return disposables.add(new TestFileEditorInput(URI.file(`/workspace/${name}`), 'test'));
	}

	test('classifies modified, untitled, scratchpad, and Working Copy-backed editors as live', () => {
		const clean = input('clean');
		const modified = input('modified');
		modified.modified = true;
		const untitled = input('untitled');
		untitled.capabilities = EditorInputCapabilities.Untitled;
		const scratchpad = input('scratchpad');
		scratchpad.capabilities = EditorInputCapabilities.Scratchpad;
		const workingCopyBacked = input('working-copy');

		assert.deepStrictEqual([
			paradisEditorRequiresScopedLiveState(clean, new Set()),
			paradisEditorRequiresScopedLiveState(modified, new Set()),
			paradisEditorRequiresScopedLiveState(untitled, new Set()),
			paradisEditorRequiresScopedLiveState(scratchpad, new Set()),
			paradisEditorRequiresScopedLiveState(workingCopyBacked, new Set([workingCopyBacked]))
		], [false, true, true, true, true]);
	});

	test('classifies a compound editor when either nested input is live', () => {
		const clean = input('clean-side');
		const dirty = input('dirty-side');
		dirty.modified = true;
		const compound = disposables.add(new SideBySideEditorInput(undefined, undefined, clean, dirty, {} as IEditorService));

		assert.strictEqual(paradisEditorRequiresScopedLiveState(compound, new Set()), true);
	});

	test('captures only live inputs and restores the same instance without disposal', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const editorId = 'paradisScopedEditorTest';
		const typeId = 'paradisScopedEditorInputTest';
		testDisposables.add(registerTestEditor(editorId, [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		instantiationService.stub(ILogService, new NullLogService());
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));

		const clean = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/clean.txt'), typeId));
		const live = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/live.txt'), typeId));
		live.modified = true;
		await parts.activeGroup.openEditor(clean, { pinned: true });
		await parts.activeGroup.openEditor(live, { pinned: true });

		let excluded: readonly TestFileEditorInput[] = [];
		service.captureScope('space-a', editors => excluded = editors as readonly TestFileEditorInput[]);

		assert.deepStrictEqual({
			excluded: excluded.map(editor => editor.resource.path),
			cleanVisible: parts.activeGroup.contains(clean),
			liveVisible: parts.activeGroup.contains(live),
			liveDisposed: live.isDisposed()
		}, {
			excluded: ['/workspace/live.txt'],
			cleanVisible: true,
			liveVisible: false,
			liveDisposed: false
		});

		await service.restoreScope('space-a');
		assert.strictEqual(parts.activeGroup.contains(live), true);
		assert.strictEqual(live.isDisposed(), false);

		live.modified = undefined;
		live.dirty = true;
		service.captureScope('space-a', () => { });
		const fileDialogService = instantiationService.get(IFileDialogService) as TestFileDialogService;
		fileDialogService.setConfirmResult(ConfirmResult.CANCEL);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), false);
		assert.strictEqual(service.hasLiveState('space-a'), true);

		fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), true);
		assert.strictEqual(live.gotReverted, false);
		assert.strictEqual(await service.retireScope('space-a'), true);
		assert.strictEqual(live.gotReverted, true);
		assert.strictEqual(live.isDisposed(), true);
	});

	test('preflights visible dirty editors when retiring the active scope', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const editorId = 'paradisActiveRetirementEditorTest';
		const typeId = 'paradisActiveRetirementEditorInputTest';
		testDisposables.add(registerTestEditor(editorId, [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		instantiationService.stub(ILogService, new NullLogService());
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));

		const live = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/active-live.txt'), typeId));
		live.dirty = true;
		await parts.activeGroup.openEditor(live, { pinned: true });

		const fileDialogService = instantiationService.get(IFileDialogService) as TestFileDialogService;
		fileDialogService.setConfirmResult(ConfirmResult.CANCEL);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), false);
		assert.strictEqual(parts.activeGroup.contains(live), true);

		fileDialogService.setConfirmResult(ConfirmResult.DONT_SAVE);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), true);
		assert.strictEqual(live.gotReverted, false);
		assert.strictEqual(parts.activeGroup.contains(live), false);

		await service.cancelScopeRetirement('space-a');
		assert.strictEqual(live.gotReverted, false);
		assert.strictEqual(parts.activeGroup.contains(live), true);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), true);
		assert.strictEqual(await service.retireScope('space-a'), true);
		assert.strictEqual(live.gotReverted, true);
	});

	test('keeps cancelled retirement editors hidden when the main scope already switched', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const typeId = 'paradisCancelledRetirementAfterSwitchEditorInputTest';
		testDisposables.add(registerTestEditor('paradisCancelledRetirementAfterSwitchEditorTest', [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		let activeStateKey = 'space-a';
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: activeStateKey }),
			resolveGroup: () => ({ kind: 'managed', stateKey: activeStateKey }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace-a'));

		const editor = testDisposables.add(new TestFileEditorInput(URI.file('/workspace-a/unsaved.txt'), typeId));
		editor.dirty = true;
		await parts.activeGroup.openEditor(editor, { pinned: true });
		(instantiationService.get(IFileDialogService) as TestFileDialogService).setConfirmResult(ConfirmResult.DONT_SAVE);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), true);
		assert.strictEqual(parts.activeGroup.contains(editor), false);

		activeStateKey = 'space-b';
		await service.commitSwitch('space-b', URI.file('/workspace-b'));
		await service.cancelScopeRetirement('space-a');
		assert.strictEqual(parts.activeGroup.contains(editor), false);
		assert.strictEqual(service.hasLiveState('space-a'), true);

		activeStateKey = 'space-a';
		await service.commitSwitch('space-a', URI.file('/workspace-a'));
		await service.restoreScope('space-a');
		assert.strictEqual(parts.activeGroup.contains(editor), true);
	});

	test('finishes a confirmed retirement after one EditorInput cannot revert', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const typeId = 'paradisFailurelessRetirementEditorInputTest';
		testDisposables.add(registerTestEditor('paradisFailurelessRetirementEditorTest', [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		instantiationService.stub(ILogService, new NullLogService());
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));

		const first = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/first.txt'), typeId));
		first.dirty = true;
		const second = testDisposables.add(new class extends TestFileEditorInput {
			override async revert(): Promise<void> {
				throw new Error('revert failed');
			}
		}(URI.file('/workspace/second.txt'), typeId));
		second.dirty = true;
		await parts.activeGroup.openEditor(first, { pinned: true });
		await parts.activeGroup.openEditor(second, { pinned: true });
		(instantiationService.get(IFileDialogService) as TestFileDialogService).setConfirmResult(ConfirmResult.DONT_SAVE);

		assert.strictEqual(await service.prepareScopeRetirement('space-a'), true);
		assert.deepStrictEqual([
			parts.activeGroup.contains(first),
			parts.activeGroup.contains(second),
		], [false, false]);
		assert.strictEqual(await service.retireScope('space-a'), true);
		assert.deepStrictEqual({
			firstReverted: first.gotReverted,
			firstDisposed: first.isDisposed(),
			secondDisposed: second.isDisposed(),
		}, {
			firstReverted: true,
			firstDisposed: true,
			secondDisposed: true,
		});
	});

	test('commits the retirement and retries a backup discard that fails after another backup was removed', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IDialogService, new class extends TestDialogService {
			override async confirm(): Promise<{ confirmed: boolean }> {
				return { confirmed: true };
			}
		}());
		const first = { resource: URI.parse('untitled:/first'), typeId: 'untitled' };
		const second = { resource: URI.parse('untitled:/second'), typeId: 'untitled' };
		const remaining = new Map([[first.resource.toString(), first], [second.resource.toString(), second]]);
		let secondAttempts = 0;
		const secondDiscarded = new DeferredPromise<void>();
		instantiationService.stub(IWorkingCopyBackupService, {
			getBackups: async () => [...remaining.values()],
			discardBackup: async (identifier: IWorkingCopyIdentifier) => {
				if (identifier.resource.toString() === second.resource.toString() && secondAttempts++ === 0) {
					throw new Error('temporary backup deletion failure');
				}
				remaining.delete(identifier.resource.toString());
				if (identifier.resource.toString() === second.resource.toString()) {
					secondDiscarded.complete();
				}
			},
			resolve: async (identifier: IWorkingCopyIdentifier) => remaining.has(identifier.resource.toString()) ? {} : undefined,
		} as never);
		const ledger = ParadisWorkingCopyOwnerLedger.load(undefined).ledger;
		ledger.assign(first, 'space-a');
		ledger.assign(second, 'space-a');
		const storageService = instantiationService.get(IStorageService);
		storageService.store('paradis.workspaceSwitch.workingCopyOwners', ledger.serialize(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));

		assert.strictEqual(await service.prepareScopeRetirement('space-a'), true);
		assert.strictEqual(await service.retireScope('space-a'), true);
		await secondDiscarded.p;
		await timeout(0);
		const savedLedger = ParadisWorkingCopyOwnerLedger.load(storageService.get('paradis.workspaceSwitch.workingCopyOwners', StorageScope.WORKSPACE)).ledger;
		assert.deepStrictEqual([savedLedger.ownerOf(first), savedLedger.ownerOf(second)], [undefined, undefined]);
	});

	test('resumes a committed backup discard after renderer restart', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-b' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-b' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		instantiationService.stub(ILogService, new NullLogService());
		const identifier = { resource: URI.parse('untitled:/restart-cleanup'), typeId: 'untitled' };
		let discarded = false;
		let discardCalls = 0;
		const cleanupCompleted = new DeferredPromise<void>();
		instantiationService.stub(IWorkingCopyBackupService, {
			getBackups: async () => discarded ? [] : [identifier],
			discardBackup: async () => { discardCalls++; discarded = true; cleanupCompleted.complete(); },
			resolve: async () => discarded ? undefined : {},
		} as never);
		const ledger = ParadisWorkingCopyOwnerLedger.load(undefined).ledger;
		ledger.assign(identifier, 'space-a');
		const storageService = instantiationService.get(IStorageService);
		storageService.store('paradis.workspaceSwitch.workingCopyOwners', ledger.serialize(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		storageService.store('paradis.workspaceSwitch.pendingBackupDiscards', JSON.stringify([{
			resource: identifier.resource.toString(),
			typeId: identifier.typeId,
			stateKey: 'space-a'
		}]), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await cleanupCompleted.p;
		await timeout(0);

		const savedLedger = ParadisWorkingCopyOwnerLedger.load(storageService.get('paradis.workspaceSwitch.workingCopyOwners', StorageScope.WORKSPACE)).ledger;
		assert.deepStrictEqual({ discardCalls, owner: savedLedger.ownerOf(identifier) }, { discardCalls: 1, owner: undefined });
		assert.strictEqual(storageService.get('paradis.workspaceSwitch.pendingBackupDiscards', StorageScope.WORKSPACE), undefined);
	});

	test('never applies stale backup cleanup intent to a newer scope owner', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-b' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-b' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		instantiationService.stub(ILogService, new NullLogService());
		const identifier = { resource: URI.parse('untitled:/reused-identifier'), typeId: 'untitled' };
		let discardCalls = 0;
		instantiationService.stub(IWorkingCopyBackupService, {
			getBackups: async () => [identifier],
			discardBackup: async () => { discardCalls++; },
			resolve: async () => ({}),
		} as never);
		const ledger = ParadisWorkingCopyOwnerLedger.load(undefined).ledger;
		ledger.assign(identifier, 'space-b');
		const storageService = instantiationService.get(IStorageService);
		storageService.store('paradis.workspaceSwitch.workingCopyOwners', ledger.serialize(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		storageService.store('paradis.workspaceSwitch.pendingBackupDiscards', JSON.stringify([{
			resource: identifier.resource.toString(),
			typeId: identifier.typeId,
			stateKey: 'space-a'
		}]), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await timeout(100);

		assert.strictEqual(discardCalls, 0);
		const savedLedger = ParadisWorkingCopyOwnerLedger.load(storageService.get('paradis.workspaceSwitch.workingCopyOwners', StorageScope.WORKSPACE)).ledger;
		assert.strictEqual(savedLedger.ownerOf(identifier), 'space-b');
		assert.strictEqual(storageService.get('paradis.workspaceSwitch.pendingBackupDiscards', StorageScope.WORKSPACE), undefined);
	});

	test('requires confirmation for a modified Scratchpad Working Copy even when its EditorInput is clean', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const typeId = 'paradisScratchpadRetirementEditorInputTest';
		testDisposables.add(registerTestEditor('paradisScratchpadRetirementEditorTest', [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		const mapping: { workingCopy?: TestWorkingCopy; editor?: TestFileEditorInput } = {};
		instantiationService.stub(IWorkingCopyEditorService, {
			findEditor: (candidate: IWorkingCopy) => candidate === mapping.workingCopy && mapping.editor ? { editor: mapping.editor, groupId: parts.activeGroup.id } : undefined,
		} as never);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));

		const editor = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/scratchpad.txt'), typeId));
		editor.capabilities = EditorInputCapabilities.Scratchpad;
		await parts.activeGroup.openEditor(editor, { pinned: true });
		const workingCopy = testDisposables.add(new class extends TestWorkingCopy {
			override isDirty(): boolean { return false; }
			override isModified(): boolean { return true; }
		}(editor.resource, false, 'scratchpad'));
		mapping.workingCopy = workingCopy;
		mapping.editor = editor;
		testDisposables.add(instantiationService.get(IWorkingCopyService).registerWorkingCopy(workingCopy));

		(instantiationService.get(IFileDialogService) as TestFileDialogService).setConfirmResult(ConfirmResult.CANCEL);
		assert.strictEqual(editor.isModified(), false);
		assert.strictEqual(instantiationService.get(IWorkingCopyEditorService).findEditor(workingCopy)?.editor, editor);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), false);
	});

	test('invalidates retirement approval when a Working Copy is edited again before commit', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const typeId = 'paradisRetirementRevisionEditorInputTest';
		testDisposables.add(registerTestEditor('paradisRetirementRevisionEditorTest', [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		const mapping: { workingCopy?: TestWorkingCopy; editor?: TestFileEditorInput } = {};
		instantiationService.stub(IWorkingCopyEditorService, {
			findEditor: (candidate: IWorkingCopy) => candidate === mapping.workingCopy && mapping.editor ? { editor: mapping.editor, groupId: parts.activeGroup.id } : undefined,
		} as never);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));

		const editor = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/revision.txt'), typeId));
		editor.capabilities = EditorInputCapabilities.Scratchpad;
		await parts.activeGroup.openEditor(editor, { pinned: true });
		const workingCopy = testDisposables.add(new class extends TestWorkingCopy {
			override isDirty(): boolean { return false; }
			override isModified(): boolean { return true; }
		}(editor.resource, false, 'scratchpad'));
		mapping.workingCopy = workingCopy;
		mapping.editor = editor;
		testDisposables.add(instantiationService.get(IWorkingCopyService).registerWorkingCopy(workingCopy));

		(instantiationService.get(IFileDialogService) as TestFileDialogService).setConfirmResult(ConfirmResult.DONT_SAVE);
		assert.strictEqual(instantiationService.get(IWorkingCopyEditorService).findEditor(workingCopy)?.editor, editor);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), true);
		workingCopy.setContent('edited after confirmation');
		assert.strictEqual(await service.retireScope('space-a'), false);
		assert.strictEqual(editor.gotReverted, false);
	});

	test('rechecks Working Copy revisions after asynchronous backup validation', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const typeId = 'paradisRetirementAsyncRevisionEditorInputTest';
		testDisposables.add(registerTestEditor('paradisRetirementAsyncRevisionEditorTest', [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		const mapping: { workingCopy?: TestWorkingCopy; editor?: TestFileEditorInput } = {};
		instantiationService.stub(IWorkingCopyEditorService, {
			findEditor: (candidate: IWorkingCopy) => candidate === mapping.workingCopy && mapping.editor ? { editor: mapping.editor, groupId: parts.activeGroup.id } : undefined,
		} as never);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		const validationStarted = new DeferredPromise<void>();
		const continueValidation = new DeferredPromise<void>();
		let getBackupsCalls = 0;
		instantiationService.stub(IWorkingCopyBackupService, {
			getBackups: async () => {
				getBackupsCalls++;
				// prepare=1, final pre-commit validation=2
				if (getBackupsCalls === 2) {
					validationStarted.complete();
					await continueValidation.p;
				}
				return [];
			},
			discardBackup: async () => { },
			resolve: async () => undefined,
		} as never);
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));

		const editor = mapping.editor = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/async-revision.txt'), typeId));
		await parts.activeGroup.openEditor(editor, { pinned: true });
		const workingCopy = mapping.workingCopy = testDisposables.add(new TestWorkingCopy(editor.resource, true, 'file'));
		testDisposables.add(instantiationService.get(IWorkingCopyService).registerWorkingCopy(workingCopy));
		(instantiationService.get(IFileDialogService) as TestFileDialogService).setConfirmResult(ConfirmResult.DONT_SAVE);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), true);

		const retirement = service.retireScope('space-a');
		await validationStarted.p;
		workingCopy.setContent('edited while backup validation was pending');
		continueValidation.complete();
		assert.strictEqual(await retirement, false);
		assert.strictEqual(editor.gotReverted, false);
	});

	test('asks separately before discarding an unrestored backup alongside a live editor', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const typeId = 'paradisUnrestoredBackupEditorInputTest';
		testDisposables.add(registerTestEditor('paradisUnrestoredBackupEditorTest', [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		let backupConfirmations = 0;
		instantiationService.stub(IDialogService, new class extends TestDialogService {
			override async confirm(): Promise<{ confirmed: boolean }> {
				backupConfirmations++;
				return { confirmed: false };
			}
		}());
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		const router = testDisposables.add(new WorkingCopyBackupRestoreRouter());
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, router);
		const orphan = { resource: URI.parse('untitled:/orphan'), typeId: 'untitled' };
		instantiationService.stub(IWorkingCopyBackupService, {
			getBackups: async () => [orphan],
			discardBackup: async () => { },
		} as never);
		const ledger = ParadisWorkingCopyOwnerLedger.load(undefined).ledger;
		ledger.assign(orphan, 'space-a');
		instantiationService.get(IStorageService).store('paradis.workspaceSwitch.workingCopyOwners', ledger.serialize(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));
		assert.strictEqual(await router.route(orphan), WorkingCopyBackupRestoreDecision.Restore);

		const editor = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/live.txt'), typeId));
		editor.dirty = true;
		await parts.activeGroup.openEditor(editor, { pinned: true });
		(instantiationService.get(IFileDialogService) as TestFileDialogService).setConfirmResult(ConfirmResult.DONT_SAVE);

		assert.strictEqual(await service.prepareScopeRetirement('space-a'), false);
		assert.strictEqual(backupConfirmations, 1);
		assert.strictEqual(editor.gotReverted, false);
	});

	test('does not treat a modified editor from another scope as handling this scope backup', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const typeId = 'paradisCrossScopeBackupEditorInputTest';
		testDisposables.add(registerTestEditor('paradisCrossScopeBackupEditorTest', [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		const mapping: { workingCopy?: TestWorkingCopy; editor?: TestFileEditorInput } = {};
		instantiationService.stub(IWorkingCopyEditorService, {
			findEditor: (candidate: IWorkingCopy) => candidate === mapping.workingCopy && mapping.editor ? { editor: mapping.editor, groupId: parts.activeGroup.id } : undefined,
		} as never);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-b' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-b' }),
			hasVisibleScope: () => false,
		} as never);
		let backupConfirmations = 0;
		instantiationService.stub(IDialogService, new class extends TestDialogService {
			override async confirm(): Promise<{ confirmed: boolean }> {
				backupConfirmations++;
				return { confirmed: false };
			}
		}());
		const identifier = { resource: URI.parse('untitled:/cross-scope'), typeId };
		instantiationService.stub(IWorkingCopyBackupService, {
			getBackups: async () => [identifier],
			discardBackup: async () => { },
			resolve: async () => undefined,
		} as never);
		const ledger = ParadisWorkingCopyOwnerLedger.load(undefined).ledger;
		ledger.assign(identifier, 'space-a');
		instantiationService.get(IStorageService).store('paradis.workspaceSwitch.workingCopyOwners', ledger.serialize(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-b', URI.file('/workspace-b'));

		const editor = mapping.editor = testDisposables.add(new TestFileEditorInput(identifier.resource, typeId));
		await parts.activeGroup.openEditor(editor, { pinned: true });
		const workingCopy = mapping.workingCopy = testDisposables.add(new TestWorkingCopy(identifier.resource, true, typeId));
		testDisposables.add(instantiationService.get(IWorkingCopyService).registerWorkingCopy(workingCopy));

		assert.strictEqual(await service.prepareScopeRetirement('space-a'), false);
		assert.strictEqual(backupConfirmations, 1);
	});

	test('defers unknown backups when the ownership ledger is corrupt even under the active root', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		const router = testDisposables.add(new WorkingCopyBackupRestoreRouter());
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, router);
		instantiationService.get(IStorageService).store('paradis.workspaceSwitch.workingCopyOwners', '{', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));

		assert.strictEqual(await router.route({ resource: URI.file('/workspace/file.txt'), typeId: 'file' }), WorkingCopyBackupRestoreDecision.Defer);
	});

	test('releases Working Copy ownership after save so the identifier can later belong to another space', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const typeId = 'paradisWorkingCopyOwnerReleaseEditorInputTest';
		testDisposables.add(registerTestEditor('paradisWorkingCopyOwnerReleaseEditorTest', [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		const mapping: { workingCopy?: TestWorkingCopy; editor?: TestFileEditorInput } = {};
		instantiationService.stub(IWorkingCopyEditorService, {
			findEditor: (candidate: IWorkingCopy) => candidate === mapping.workingCopy && mapping.editor ? { editor: mapping.editor, groupId: parts.activeGroup.id } : undefined,
		} as never);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		const resolveStarted = new DeferredPromise<void>();
		const continueResolve = new DeferredPromise<void>();
		let resolveCalls = 0;
		let discardCalls = 0;
		instantiationService.stub(IWorkingCopyBackupService, {
			getBackups: async () => [],
			resolve: async () => {
				resolveCalls++;
				if (resolveCalls === 1) {
					resolveStarted.complete();
					await continueResolve.p;
				}
				return undefined;
			},
			discardBackup: async () => { discardCalls++; },
		} as never);
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));

		const editor = mapping.editor = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/reusable.txt'), typeId));
		await parts.activeGroup.openEditor(editor, { pinned: true });
		const workingCopy = mapping.workingCopy = testDisposables.add(new TestWorkingCopy(editor.resource, true, 'file'));
		testDisposables.add(instantiationService.get(IWorkingCopyService).registerWorkingCopy(workingCopy));
		const storageService = instantiationService.get(IStorageService);
		assert.strictEqual(ParadisWorkingCopyOwnerLedger.load(storageService.get('paradis.workspaceSwitch.workingCopyOwners', StorageScope.WORKSPACE)).ledger.ownerOf(workingCopy), 'space-a');

		workingCopy.setDirty(false);
		await resolveStarted.p;
		workingCopy.setDirty(true);
		continueResolve.complete();
		await timeout(0);
		assert.strictEqual(ParadisWorkingCopyOwnerLedger.load(storageService.get('paradis.workspaceSwitch.workingCopyOwners', StorageScope.WORKSPACE)).ledger.ownerOf(workingCopy), 'space-a');

		workingCopy.setDirty(false);
		await timeout(10);
		assert.strictEqual(ParadisWorkingCopyOwnerLedger.load(storageService.get('paradis.workspaceSwitch.workingCopyOwners', StorageScope.WORKSPACE)).ledger.ownerOf(workingCopy), undefined);
		assert.strictEqual(discardCalls, 0);
	});

	test('keeps a clean Working Copy owner release pending beyond the former polling limit', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const typeId = 'paradisLongPendingOwnerReleaseEditorInputTest';
		testDisposables.add(registerTestEditor('paradisLongPendingOwnerReleaseEditorTest', [new SyncDescriptor(TestFileEditorInput)], typeId));
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		const mapping: { workingCopy?: TestWorkingCopy; editor?: TestFileEditorInput } = {};
		instantiationService.stub(IWorkingCopyEditorService, {
			findEditor: (candidate: IWorkingCopy) => candidate === mapping.workingCopy && mapping.editor ? { editor: mapping.editor, groupId: parts.activeGroup.id } : undefined,
		} as never);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		instantiationService.stub(ILogService, new NullLogService());
		let resolveCalls = 0;
		const releaseReady = new DeferredPromise<void>();
		instantiationService.stub(IWorkingCopyBackupService, {
			getBackups: async () => [],
			resolve: async () => {
				resolveCalls++;
				if (resolveCalls === 26) {
					releaseReady.complete();
					return undefined;
				}
				return {};
			},
			discardBackup: async () => { },
		} as never);
		const service = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await service.commitSwitch('space-a', URI.file('/workspace'));

		const editor = mapping.editor = testDisposables.add(new TestFileEditorInput(URI.file('/workspace/slow-release.txt'), typeId));
		await parts.activeGroup.openEditor(editor, { pinned: true });
		const workingCopy = mapping.workingCopy = testDisposables.add(new TestWorkingCopy(editor.resource, true, 'file'));
		testDisposables.add(instantiationService.get(IWorkingCopyService).registerWorkingCopy(workingCopy));
		const storageService = instantiationService.get(IStorageService);

		workingCopy.setDirty(false);
		await releaseReady.p;
		await timeout(0);
		const savedLedger = ParadisWorkingCopyOwnerLedger.load(storageService.get('paradis.workspaceSwitch.workingCopyOwners', StorageScope.WORKSPACE)).ledger;
		assert.deepStrictEqual({ resolveCalls, owner: savedLedger.ownerOf(workingCopy) }, { resolveCalls: 26, owner: undefined });
	});

	test('resumes a clean Working Copy owner release when the editor scope service restarts', async () => {
		const testDisposables = disposables.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		const parts = await createEditorParts(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, parts);
		instantiationService.stub(IWorkingCopyEditorService, { findEditor: () => undefined } as never);
		instantiationService.stub(IParadisAuxiliaryWindowScopeService, {
			initializationBarrier: Promise.resolve(),
			resolvePart: () => ({ kind: 'managed', stateKey: 'space-a' }),
			resolveGroup: () => ({ kind: 'managed', stateKey: 'space-a' }),
			hasVisibleScope: () => false,
		} as never);
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
		instantiationService.stub(IWorkingCopyBackupService, {
			getBackups: async () => [],
			resolve: async () => undefined,
			discardBackup: async () => { },
		} as never);

		const workingCopy = testDisposables.add(new TestWorkingCopy(URI.file('/workspace/restarted-clean.txt'), false, 'file'));
		testDisposables.add(instantiationService.get(IWorkingCopyService).registerWorkingCopy(workingCopy));
		const ledger = ParadisWorkingCopyOwnerLedger.load(undefined).ledger;
		ledger.assign(workingCopy, 'space-a');
		const storageService = instantiationService.get(IStorageService);
		storageService.store('paradis.workspaceSwitch.workingCopyOwners', ledger.serialize(), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));
		await timeout(10);

		const savedLedger = ParadisWorkingCopyOwnerLedger.load(storageService.get('paradis.workspaceSwitch.workingCopyOwners', StorageScope.WORKSPACE)).ledger;
		assert.strictEqual(savedLedger.ownerOf(workingCopy), undefined);
	});
});
