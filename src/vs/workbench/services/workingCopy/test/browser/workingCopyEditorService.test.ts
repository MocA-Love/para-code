/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorService } from '../../../editor/browser/editorService.js';
import { IEditorGroupsService } from '../../../editor/common/editorGroupsService.js';
import { UntitledTextEditorInput } from '../../../untitled/common/untitledTextEditorInput.js';
// PARA-PATCH: import side-by-side editor input to test nested working copy resolution
import { SideBySideEditorInput } from '../../../../common/editor/sideBySideEditorInput.js';
import { IWorkingCopyEditorHandler, WorkingCopyEditorService } from '../../common/workingCopyEditorService.js';
import { createEditorPart, registerTestResourceEditor, TestEditorService, TestServiceAccessor, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestWorkingCopy } from '../../../../test/common/workbenchTestServices.js';

suite('WorkingCopyEditorService', () => {

	const disposables = new DisposableStore();

	setup(() => {
		disposables.add(registerTestResourceEditor());
	});

	teardown(() => {
		disposables.clear();
	});

	test('registry - basics', () => {
		const service = disposables.add(new WorkingCopyEditorService(disposables.add(new TestEditorService())));

		let handlerEvent: IWorkingCopyEditorHandler | undefined = undefined;
		// PARA-PATCH: also capture the unregister event to assert it fires on dispose
		let unregisteredHandlerEvent: IWorkingCopyEditorHandler | undefined = undefined;
		disposables.add(service.onDidRegisterHandler(handler => {
			handlerEvent = handler;
		}));
		// PARA-PATCH: subscribe to the new unregister event
		disposables.add(service.onDidUnregisterHandler(handler => {
			unregisteredHandlerEvent = handler;
		}));

		const editorHandler: IWorkingCopyEditorHandler = {
			handles: workingCopy => false,
			isOpen: () => false,
			createEditor: workingCopy => { throw new Error(); }
		};

		// PARA-PATCH: upstream discarded the registration; keep it so it can be disposed below
		const registration = service.registerHandler(editorHandler);

		assert.strictEqual(handlerEvent, editorHandler);
		// PARA-PATCH: disposing the registration must fire the unregister event
		registration.dispose();
		assert.strictEqual(unregisteredHandlerEvent, editorHandler);
	});

	test('findEditor', async () => {
		const disposables = new DisposableStore();

		const instantiationService = workbenchInstantiationService(undefined, disposables);
		const part = await createEditorPart(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, part);

		const editorService = disposables.add(instantiationService.createInstance(EditorService, undefined));
		const accessor = instantiationService.createInstance(TestServiceAccessor);

		const service = disposables.add(new WorkingCopyEditorService(editorService));

		const resource = URI.parse('custom://some/folder/custom.txt');
		const testWorkingCopy = disposables.add(new TestWorkingCopy(resource, false, 'testWorkingCopyTypeId1'));

		assert.strictEqual(service.findEditor(testWorkingCopy), undefined);

		const editorHandler: IWorkingCopyEditorHandler = {
			handles: workingCopy => workingCopy === testWorkingCopy,
			isOpen: (workingCopy, editor) => workingCopy === testWorkingCopy,
			createEditor: workingCopy => { throw new Error(); }
		};

		disposables.add(service.registerHandler(editorHandler));

		const editor1 = disposables.add(instantiationService.createInstance(UntitledTextEditorInput, accessor.untitledTextEditorService.create({ initialValue: 'foo' })));
		const editor2 = disposables.add(instantiationService.createInstance(UntitledTextEditorInput, accessor.untitledTextEditorService.create({ initialValue: 'foo' })));

		await editorService.openEditors([{ editor: editor1 }, { editor: editor2 }]);

		assert.ok(service.findEditor(testWorkingCopy));

		disposables.dispose();
	});

	// PARA-PATCH: new test covering findEditor resolving a working copy nested in a side-by-side input
	test('findEditor resolves a Working Copy owned by a nested side-by-side input', async () => {
		const testDisposables = new DisposableStore();
		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		const part = await createEditorPart(instantiationService, testDisposables);
		instantiationService.stub(IEditorGroupsService, part);
		const editorService = testDisposables.add(instantiationService.createInstance(EditorService, undefined));
		const accessor = instantiationService.createInstance(TestServiceAccessor);
		const service = testDisposables.add(new WorkingCopyEditorService(editorService));

		const primary = testDisposables.add(instantiationService.createInstance(UntitledTextEditorInput, accessor.untitledTextEditorService.create({ initialValue: 'primary' })));
		const secondary = testDisposables.add(instantiationService.createInstance(UntitledTextEditorInput, accessor.untitledTextEditorService.create({ initialValue: 'secondary' })));
		const compound = testDisposables.add(new SideBySideEditorInput(undefined, undefined, secondary, primary, editorService));
		await editorService.openEditor(compound);
		const workingCopy = testDisposables.add(new TestWorkingCopy(primary.resource, false, 'nested'));
		testDisposables.add(service.registerHandler({
			handles: () => true,
			isOpen: (candidate, editor) => candidate === workingCopy && editor === primary,
			createEditor: () => { throw new Error(); }
		}));

		assert.strictEqual(service.findEditor(workingCopy)?.editor, compound);
		testDisposables.dispose();
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
