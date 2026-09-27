/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { Dimension } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IFilesConfigurationService } from '../../../../../workbench/services/filesConfiguration/common/filesConfigurationService.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { TestEditorGroupView } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ParadisCsvFileEditor } from '../../browser/csv/paradisCsvFileEditor.js';
import { isParadisCsvTextModePreferred, ParadisCsvFileInput } from '../../browser/csv/paradisCsvFileInput.js';

const resource = URI.file('/workspace/orders.csv');

/** A dirty-able text file model standing in for the one the text editors share. */
class FakeFileModel {
	readonly resource = resource;
	dirty = false;
	value = '';
	private readonly _onDidChangeContent = new Emitter<void>();
	readonly onDidChangeContent = this._onDidChangeContent.event;
	readonly textEditorModel = {
		isDisposed: () => false,
		getValue: () => this.value,
		getValueLength: () => this.value.length,
	};
	isDirty(): boolean { return this.dirty; }
	isResolved(): boolean { return true; }
	isReadonly(): boolean { return false; }
	getEncoding(): string { return 'utf8'; }
	edit(value: string): void {
		this.value = value;
		this.dirty = true;
		this._onDidChangeContent.fire();
	}
	dispose(): void { this._onDidChangeContent.dispose(); }
}

interface Harness {
	readonly editor: ParadisCsvFileEditor;
	readonly input: ParadisCsvFileInput;
	readonly storage: TestStorageService;
	readonly reads: string[];
	readonly modelReferences: string[];
	readonly selections: IRange[];
	readonly root: HTMLElement;
	disk: string;
	stat: { size: number; mtime: number };
	fileModel: FakeFileModel | undefined;
	readGate: DeferredPromise<void> | undefined;
}

function createHarness(store: Pick<DisposableStore, 'add'>): Harness {
	const parent = mainWindow.document.createElement('div');
	parent.style.cssText = 'position: fixed; left: 0; top: 0; width: 640px; height: 320px;';
	mainWindow.document.body.appendChild(parent);
	store.add(toDisposable(() => parent.remove()));

	const harness = {
		reads: [] as string[],
		modelReferences: [] as string[],
		selections: [] as IRange[],
		disk: 'id,name\n1,a\n2,b\n',
		stat: { size: 17, mtime: 1 },
		fileModel: undefined as FakeFileModel | undefined,
		readGate: undefined as DeferredPromise<void> | undefined,
	};
	const textFileService = {
		files: {
			get: () => harness.fileModel,
			onDidResolve: Event.None,
			onDidChangeEncoding: Event.None,
			onDidChangeReadonly: Event.None,
		},
		read: async () => {
			harness.reads.push(harness.disk);
			await harness.readGate?.p;
			return { value: harness.disk, size: harness.stat.size, mtime: harness.stat.mtime };
		},
		isDirty: () => false,
	} as unknown as ITextFileService;
	const fileService = {
		createWatcher: () => ({ onDidChange: Event.None, dispose: () => { } }),
		onDidWatchError: Event.None,
		stat: async () => ({ ...harness.stat }),
	} as unknown as IFileService;
	const textModelService = {
		createModelReference: async (uri: URI) => {
			harness.modelReferences.push(uri.toString());
			return { object: { textEditorModel: { uri } }, dispose: () => { } };
		},
	} as unknown as ITextModelService;
	const instantiationService = store.add(new TestInstantiationService());
	instantiationService.stubInstance(CodeEditorWidget, {
		setModel: () => { },
		updateOptions: () => { },
		focus: () => { },
		dispose: () => { },
		setSelection: (range: unknown) => { harness.selections.push(range as IRange); },
		revealRangeInCenter: () => { },
	});
	const filesConfigurationService = { isReadonly: () => false, onDidChangeReadonly: Event.None } as unknown as IFilesConfigurationService;
	const storage = store.add(new TestStorageService());
	const editor = store.add(new ParadisCsvFileEditor(
		new TestEditorGroupView(1),
		NullTelemetryService,
		new TestThemeService(),
		storage,
		textFileService,
		fileService,
		textModelService,
		instantiationService,
		{ writeText: async () => { } } as unknown as IClipboardService,
		{ notify: () => undefined } as unknown as INotificationService,
		new TestConfigurationService(),
		filesConfigurationService,
	));
	editor.create(parent);
	editor.layout(new Dimension(640, 320));
	const input = store.add(new ParadisCsvFileInput(resource, textFileService, { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService));
	return Object.assign(harness, { editor, input, storage, root: parent });
}

function footer(harness: Harness): string {
	return harness.root.querySelector('.paradis-csv-footer')?.textContent ?? '';
}

async function until(condition: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 300 && !condition(); i++) {
		await timeout(10);
	}
	if (!condition()) {
		throw new Error(`timed out waiting for ${label}`);
	}
}

suite('ParadisCsvFileEditor', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens at the requested line in text mode without reading the table or remembering the mode', async () => {
		const harness = createHarness(store);
		const options: ITextEditorOptions = { selection: { startLineNumber: 3, startColumn: 2 } };
		await harness.editor.setInput(harness.input, options, Object.create(null), CancellationToken.None);
		deepStrictEqual({
			mode: harness.editor.getViewMode(),
			control: !!harness.editor.getControl(),
			selections: harness.selections,
			reads: harness.reads.length,
			remembered: isParadisCsvTextModePreferred(harness.storage, resource),
		}, {
			mode: 'text',
			control: true,
			selections: [{ startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 2 }],
			reads: 0,
			remembered: false,
		});
	});

	test('reflects unsaved edits made in a text editor while the table is shown', async () => {
		const harness = createHarness(store);
		harness.fileModel = store.add(new FakeFileModel());
		await harness.editor.setInput(harness.input, undefined, Object.create(null), CancellationToken.None);
		await until(() => footer(harness).startsWith('2 '), 'initial table');
		harness.fileModel.edit('id,name\n1,a\n2,b\n3,c\n');
		await until(() => footer(harness).startsWith('3 '), 'table to pick up the edit');
		deepStrictEqual(harness.reads.length, 1);
	});

	test('asks before opening a file larger than the confirmation limit as text', async () => {
		const harness = createHarness(store);
		await harness.editor.setInput(harness.input, undefined, Object.create(null), CancellationToken.None);
		harness.stat = { size: 2 * 1024 * 1024 * 1024, mtime: 1 };
		harness.editor.setViewMode('text');
		await until(() => !!harness.root.querySelector('.paradis-csv-message.visible .paradis-csv-link-button'), 'confirmation');
		const before = harness.modelReferences.length;
		const openAnyway = [...harness.root.querySelectorAll<HTMLButtonElement>('.paradis-csv-message.visible .paradis-csv-link-button')][0];
		openAnyway.click();
		await until(() => harness.modelReferences.length > before, 'model reference after confirming');
		deepStrictEqual({ before, after: harness.modelReferences.length, control: !!harness.editor.getControl() }, { before: 0, after: 1, control: true });
	});

	test('reuses the loaded table when returning to an unchanged file and reloads a changed one', async () => {
		const harness = createHarness(store);
		await harness.editor.setInput(harness.input, undefined, Object.create(null), CancellationToken.None);
		await until(() => footer(harness).startsWith('2 '), 'initial table');
		harness.editor.clearInput();
		await harness.editor.setInput(harness.input, undefined, Object.create(null), CancellationToken.None);
		await timeout(50);
		const readsWhenUnchanged = harness.reads.length;
		harness.editor.clearInput();
		harness.disk = 'id,name\n1,a\n';
		harness.stat = { size: 12, mtime: 2 };
		await harness.editor.setInput(harness.input, undefined, Object.create(null), CancellationToken.None);
		await until(() => footer(harness).startsWith('1 '), 'reloaded table');
		deepStrictEqual({ readsWhenUnchanged, readsAfterChange: harness.reads.length }, { readsWhenUnchanged: 1, readsAfterChange: 2 });
	});

	test('stops loading and leaves no grid behind when disposed mid-load', async () => {
		const harness = createHarness(store);
		harness.readGate = new DeferredPromise<void>();
		await harness.editor.setInput(harness.input, undefined, Object.create(null), CancellationToken.None);
		await until(() => harness.reads.length === 1, 'read to start');
		harness.editor.dispose();
		harness.readGate.complete();
		await timeout(20);
		deepStrictEqual(harness.root.querySelectorAll('.paradis-spreadsheet-virtual-cell').length, 0);
	});
});
