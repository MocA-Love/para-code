/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual } from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IReference } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DiffEditorWidget } from '../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { TestEditorGroupView } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ParadisFileDiffEditor } from '../../browser/paradisFileDiffEditor.js';
import { ParadisFileDiffInput } from '../../browser/paradisFileDiffInput.js';

interface IControlledReference {
	readonly deferred: DeferredPromise<IReference<IResolvedTextEditorModel>>;
	disposeCount: number;
}

function createControlledReference(): IControlledReference {
	const controlled: IControlledReference = {
		deferred: new DeferredPromise<IReference<IResolvedTextEditorModel>>(),
		disposeCount: 0,
	};
	return controlled;
}

function completeReference(controlled: IControlledReference): void {
	controlled.deferred.complete(createReference(controlled));
}

function createReference(controlled: IControlledReference): IReference<IResolvedTextEditorModel> {
	return {
		object: Object.create(null) as IResolvedTextEditorModel,
		dispose: () => controlled.disposeCount++,
	};
}

function createInput(original: URI, modified: URI): ParadisFileDiffInput {
	const textFileService = Object.create(null) as ITextFileService;
	const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
	return new ParadisFileDiffInput(original, modified, undefined, textFileService, workingCopyService);
}

suite('ParadisFileDiffEditor', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('releases both stored model references when disposed after setInput completes', async () => {
		const original = URI.parse('git:/workspace/readme.md?ref=HEAD');
		const modified = URI.file('/workspace/readme.md');
		const originalReference = createControlledReference();
		const modifiedReference = createControlledReference();
		const modelService = {
			createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				return Promise.resolve(createReference(resource.scheme === 'git' ? originalReference : modifiedReference));
			}
		} as unknown as ITextModelService;
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stubInstance(DiffEditorWidget, {
			setModel: () => { },
			dispose: () => { },
		});
		const editor = new ParadisFileDiffEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			instantiationService,
			modelService,
		);
		const input = disposables.add(createInput(original, modified));

		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		strictEqual(originalReference.disposeCount, 0);
		strictEqual(modifiedReference.disposeCount, 0);

		editor.dispose();

		strictEqual(originalReference.disposeCount, 1);
		strictEqual(modifiedReference.disposeCount, 1);
	});

	test('requests both model references and releases late results after disposal', async () => {
		const original = URI.parse('git:/workspace/readme.md?ref=HEAD');
		const modified = URI.file('/workspace/readme.md');
		const originalReference = createControlledReference();
		const modifiedReference = createControlledReference();
		const requests: string[] = [];
		const modelService = {
			createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				requests.push(resource.toString());
				return resource.scheme === 'git' ? originalReference.deferred.p : modifiedReference.deferred.p;
			}
		} as unknown as ITextModelService;
		const editor = new ParadisFileDiffEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			disposables.add(new TestInstantiationService()),
			modelService,
		);
		const input = disposables.add(createInput(original, modified));

		const settingInput = editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await Promise.resolve();
		deepStrictEqual(requests, [original.toString(), modified.toString()]);

		editor.dispose();
		completeReference(originalReference);
		completeReference(modifiedReference);
		await settingInput;

		strictEqual(originalReference.disposeCount, 1);
		strictEqual(modifiedReference.disposeCount, 1);
	});

	test('releases an already resolved original and a late modified reference after disposal', async () => {
		const original = URI.parse('git:/workspace/readme.md?ref=HEAD');
		const modified = URI.file('/workspace/readme.md');
		const originalReference = createControlledReference();
		const modifiedReference = createControlledReference();
		const resolvedOriginal = Promise.resolve(createReference(originalReference));
		const modelService = {
			createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				return resource.scheme === 'git' ? resolvedOriginal : modifiedReference.deferred.p;
			}
		} as unknown as ITextModelService;
		const editor = new ParadisFileDiffEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			disposables.add(new TestInstantiationService()),
			modelService,
		);
		const input = disposables.add(createInput(original, modified));

		const settingInput = editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await Promise.resolve();
		await Promise.resolve();
		editor.dispose();
		try {
			strictEqual(originalReference.disposeCount, 1);
			strictEqual(modifiedReference.disposeCount, 0);
		} finally {
			completeReference(modifiedReference);
			await settingInput;
		}

		strictEqual(originalReference.disposeCount, 1);
		strictEqual(modifiedReference.disposeCount, 1);
	});

	test('releases an already resolved modified and a late original reference after disposal', async () => {
		const original = URI.parse('git:/workspace/readme.md?ref=HEAD');
		const modified = URI.file('/workspace/readme.md');
		const originalReference = createControlledReference();
		const modifiedReference = createControlledReference();
		const resolvedModified = Promise.resolve(createReference(modifiedReference));
		const modelService = {
			createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				return resource.scheme === 'git' ? originalReference.deferred.p : resolvedModified;
			}
		} as unknown as ITextModelService;
		const editor = new ParadisFileDiffEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			disposables.add(new TestInstantiationService()),
			modelService,
		);
		const input = disposables.add(createInput(original, modified));

		const settingInput = editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await Promise.resolve();
		await Promise.resolve();
		editor.dispose();
		try {
			strictEqual(originalReference.disposeCount, 0);
			strictEqual(modifiedReference.disposeCount, 1);
		} finally {
			completeReference(originalReference);
			await settingInput;
		}

		strictEqual(originalReference.disposeCount, 1);
		strictEqual(modifiedReference.disposeCount, 1);
	});

	test('releases an acquired original reference when the modified reference fails', async () => {
		const original = URI.parse('git:/workspace/readme.md?ref=HEAD');
		const modified = URI.file('/workspace/readme.md');
		const originalReference = createControlledReference();
		const modelService = {
			createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				if (resource.scheme === 'git') {
					return originalReference.deferred.p;
				}
				return Promise.reject(new Error('modified model failed'));
			}
		} as unknown as ITextModelService;
		const editor = disposables.add(new ParadisFileDiffEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			disposables.add(new TestInstantiationService()),
			modelService,
		));
		const input = disposables.add(createInput(original, modified));

		const settingInput = editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		completeReference(originalReference);

		await rejects(settingInput, /modified model failed/);
		strictEqual(originalReference.disposeCount, 1);
	});

	test('releases an acquired modified reference when the original reference fails', async () => {
		const original = URI.parse('git:/workspace/readme.md?ref=HEAD');
		const modified = URI.file('/workspace/readme.md');
		const modifiedReference = createControlledReference();
		const modelService = {
			createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				if (resource.scheme === 'git') {
					return Promise.reject(new Error('original model failed'));
				}
				return Promise.resolve(createReference(modifiedReference));
			}
		} as unknown as ITextModelService;
		const editor = disposables.add(new ParadisFileDiffEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			disposables.add(new TestInstantiationService()),
			modelService,
		));
		const input = disposables.add(createInput(original, modified));

		const settingInput = editor.setInput(input, undefined, Object.create(null), CancellationToken.None);

		await rejects(settingInput, /original model failed/);
		strictEqual(modifiedReference.disposeCount, 1);
	});

	test('releases each model reference once when cancellation wins a pending acquisition', async () => {
		const original = URI.parse('git:/workspace/readme.md?ref=HEAD');
		const modified = URI.file('/workspace/readme.md');
		const originalReference = createControlledReference();
		const modifiedReference = createControlledReference();
		const modelService = {
			createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				return resource.scheme === 'git' ? originalReference.deferred.p : modifiedReference.deferred.p;
			}
		} as unknown as ITextModelService;
		const editor = disposables.add(new ParadisFileDiffEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			disposables.add(new TestInstantiationService()),
			modelService,
		));
		const input = disposables.add(createInput(original, modified));
		const cancellation = disposables.add(new CancellationTokenSource());

		const settingInput = editor.setInput(input, undefined, Object.create(null), cancellation.token);
		completeReference(originalReference);
		await Promise.resolve();
		await Promise.resolve();

		cancellation.cancel();
		completeReference(modifiedReference);
		await settingInput;
		editor.dispose();

		strictEqual(originalReference.disposeCount, 1);
		strictEqual(modifiedReference.disposeCount, 1);
	});

	test('releases stale references without disposing the replacement input references', async () => {
		const firstOriginal = URI.parse('git:/workspace/first.md?ref=HEAD');
		const firstModified = URI.file('/workspace/first.md');
		const secondOriginal = URI.parse('git:/workspace/second.md?ref=HEAD');
		const secondModified = URI.file('/workspace/second.md');
		const references = new Map([
			[firstOriginal.toString(), createControlledReference()],
			[firstModified.toString(), createControlledReference()],
			[secondOriginal.toString(), createControlledReference()],
			[secondModified.toString(), createControlledReference()],
		]);
		const modelService = {
			createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				return references.get(resource.toString())!.deferred.p;
			}
		} as unknown as ITextModelService;
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stubInstance(DiffEditorWidget, {
			setModel: () => { },
			dispose: () => { },
		});
		const editor = new ParadisFileDiffEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			instantiationService,
			modelService,
		);
		const firstInput = disposables.add(createInput(firstOriginal, firstModified));
		const secondInput = disposables.add(createInput(secondOriginal, secondModified));

		const settingFirstInput = editor.setInput(firstInput, undefined, Object.create(null), CancellationToken.None);
		completeReference(references.get(firstOriginal.toString())!);
		await Promise.resolve();
		await Promise.resolve();

		const settingSecondInput = editor.setInput(secondInput, undefined, Object.create(null), CancellationToken.None);
		completeReference(references.get(secondOriginal.toString())!);
		completeReference(references.get(secondModified.toString())!);
		await settingSecondInput;

		strictEqual(references.get(firstOriginal.toString())!.disposeCount, 1);
		strictEqual(references.get(secondOriginal.toString())!.disposeCount, 0);
		strictEqual(references.get(secondModified.toString())!.disposeCount, 0);

		completeReference(references.get(firstModified.toString())!);
		await settingFirstInput;
		editor.dispose();

		strictEqual(references.get(firstOriginal.toString())!.disposeCount, 1);
		strictEqual(references.get(firstModified.toString())!.disposeCount, 1);
		strictEqual(references.get(secondOriginal.toString())!.disposeCount, 1);
		strictEqual(references.get(secondModified.toString())!.disposeCount, 1);
	});
});
