/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorExtensions, EditorInputCapabilities, IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import { SideBySideEditorInput } from '../../../../../workbench/common/editor/sideBySideEditorInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ConfirmResult, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IWorkingCopyBackupRestoreRouter, WorkingCopyBackupRestoreRouter } from '../../../../../workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.js';
import { createEditorParts, registerTestEditor, TestFileDialogService, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { paradisEditorRequiresScopedLiveState, ParadisEditorScopeService } from '../../browser/paradisEditorScopeService.js';

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
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
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
		instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));
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
		assert.strictEqual(parts.activeGroup.contains(live), true);

		service.cancelScopeRetirement('space-a');
		assert.strictEqual(live.gotReverted, false);
		assert.strictEqual(await service.prepareScopeRetirement('space-a'), true);
		assert.strictEqual(await service.retireScope('space-a'), true);
		assert.strictEqual(live.gotReverted, true);
	});
});
