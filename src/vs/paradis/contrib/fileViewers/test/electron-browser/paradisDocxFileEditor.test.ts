/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import { deepStrictEqual, strictEqual } from 'assert';
import { Dimension } from '../../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileChangesEvent, IFileService, IFileSystemWatcher } from '../../../../../platform/files/common/files.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IOverlayWebview, IWebviewService } from '../../../../../workbench/contrib/webview/browser/webview.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { TestEditorGroupView, TestLayoutService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { getParadisDocxRenderDecision, isParadisDocxHeader, ParadisDocxFileEditor, readParadisDocxHeader } from '../../electron-browser/paradisDocxFileEditor.js';
import { ParadisDocxInput } from '../../electron-browser/paradisDocxInput.js';

interface IDocxEditorSnapshot {
	readonly watcherResources: readonly string[];
	readonly readResources: readonly string[];
	readonly readOptions: readonly { readonly length: number }[];
	readonly claims: number;
	readonly releases: number;
	readonly htmlDocuments: readonly string[];
	readonly overlayCallsAfterDispose: number;
}

suite('ParadisDocxFileEditor', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createDocxEditorFixture() {
		const watcherResources: string[] = [];
		const readResources: string[] = [];
		const readOptions: { length: number }[] = [];
		const htmlDocuments: string[] = [];
		let claims = 0;
		let releases = 0;
		let overlayCallsAfterDispose = 0;
		let overlayDisposed = false;

		const recordOverlayCall = () => {
			if (overlayDisposed) {
				overlayCallsAfterDispose++;
			}
		};
		const classifyHtml = (html: string): string => {
			if (html.includes('Word 文書を表示できませんでした: ファイルが空または破損しています')) {
				return 'rejected';
			}
			return html.includes('id="content"') ? 'viewer' : 'unknown';
		};

		const webview = {
			container: document.createElement('div'),
			contentOptions: {},
			claim: () => {
				recordOverlayCall();
				claims++;
			},
			release: () => {
				recordOverlayCall();
				releases++;
			},
			setAnchorElement: () => recordOverlayCall(),
			setHtml: (html: string) => {
				recordOverlayCall();
				htmlDocuments.push(classifyHtml(html));
			},
			focus: () => recordOverlayCall(),
			dispose: () => {
				overlayDisposed = true;
			},
		} as unknown as IOverlayWebview;
		const webviewService = {
			createWebviewOverlay: () => webview,
		} as unknown as IWebviewService;
		const fileService = {
			createWatcher: (resource: URI): IFileSystemWatcher => {
				watcherResources.push(resource.toString());
				const onDidChange = disposables.add(new Emitter<FileChangesEvent>());
				return {
					onDidChange: onDidChange.event,
					dispose: () => onDidChange.dispose(),
				};
			},
			readFile: async (resource: URI, options: { length: number }) => {
				readResources.push(resource.toString());
				readOptions.push({ length: options.length });
				return { value: VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)) };
			},
		} as unknown as IFileService;
		const editor = disposables.add(new ParadisDocxFileEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			webviewService,
			fileService,
			new TestLayoutService(),
		));
		const parent = document.createElement('div');
		editor.create(parent);
		editor.layout(new Dimension(800, 600));

		return {
			editor,
			createInput(resource: URI): ParadisDocxInput {
				const textFileService = Object.create(null) as ITextFileService;
				const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
				return disposables.add(new ParadisDocxInput(resource, textFileService, workingCopyService));
			},
			createCancellationTokenSource(): CancellationTokenSource {
				return disposables.add(new CancellationTokenSource());
			},
			async settleCurrentRender(): Promise<void> {
				await Promise.resolve();
				await Promise.resolve();
			},
			snapshot(): IDocxEditorSnapshot {
				return {
					watcherResources: [...watcherResources],
					readResources: [...readResources],
					readOptions: [...readOptions],
					claims,
					releases,
					htmlDocuments: [...htmlDocuments],
					overlayCallsAfterDispose,
				};
			},
		};
	}

	test('reads only the DOCX header and rejects empty and corrupt input', async () => {
		const options: { length: number }[] = [];
		const fileService = {
			readFile: async (_resource: URI, readOptions: { length: number }) => {
				options.push(readOptions);
				return { value: VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)) };
			}
		} as unknown as IFileService;

		strictEqual(await readParadisDocxHeader(fileService, URI.file('/workspace/document.docx')), true);
		deepStrictEqual(options, [{ length: 4 }]);
		deepStrictEqual([new Uint8Array(), Uint8Array.of(0x50, 0x4b, 0x03)].map(isParadisDocxHeader), [false, false]);
	});

	test('maps DOCX preflight results to the observable render outcome', () => {
		const resource = URI.file('/workspace/document.docx');
		const otherResource = URI.file('/workspace/other.docx');

		deepStrictEqual([
			getParadisDocxRenderDecision(false, resource, resource, 1, 1),
			getParadisDocxRenderDecision(true, resource, resource, 1, 1),
			getParadisDocxRenderDecision(undefined, resource, resource, 1, 1),
			getParadisDocxRenderDecision(false, resource, otherResource, 1, 1),
			getParadisDocxRenderDecision(false, resource, resource, 1, 2),
		], ['rejected', 'viewer', 'viewer', 'stale', 'stale']);
	});

	suite('input adoption epoch', () => {

		test('does not adopt an input cleared before its setInput continuation', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const pending = fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);

			fixture.editor.clearInput();
			await pending;

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [],
				readResources: [],
				readOptions: [],
				claims: 0,
				releases: 0,
				htmlDocuments: [],
				overlayCallsAfterDispose: 0,
			});
		});

		test('does not adopt an input disposed before its setInput continuation', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const pending = fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);

			fixture.editor.dispose();
			await pending;

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [],
				readResources: [],
				readOptions: [],
				claims: 0,
				releases: 0,
				htmlDocuments: [],
				overlayCallsAfterDispose: 0,
			});
		});

		test('lets only the newest different-resource invocation adopt ownership', async () => {
			const fixture = createDocxEditorFixture();
			const resourceA = URI.file('/workspace/a.docx');
			const resourceB = URI.file('/workspace/b.docx');
			const pendingA = fixture.editor.setInput(fixture.createInput(resourceA), undefined, Object.create(null), CancellationToken.None);
			const pendingB = fixture.editor.setInput(fixture.createInput(resourceB), undefined, Object.create(null), CancellationToken.None);

			await Promise.all([pendingA, pendingB]);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [resourceB.toString()],
				readResources: [resourceB.toString()],
				readOptions: [{ length: 4 }],
				claims: 1,
				releases: 0,
				htmlDocuments: ['viewer'],
				overlayCallsAfterDispose: 0,
			});
		});

		test('does not adopt an input cancelled before its setInput continuation', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const cancellation = fixture.createCancellationTokenSource();
			const pending = fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), cancellation.token);

			cancellation.cancel();
			await pending;

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [],
				readResources: [],
				readOptions: [],
				claims: 0,
				releases: 0,
				htmlDocuments: [],
				overlayCallsAfterDispose: 0,
			});
		});

		test('lets only the second invocation adopt the same input object', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');
			const input = fixture.createInput(resource);
			const pendingA = fixture.editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
			const pendingB = fixture.editor.setInput(input, undefined, Object.create(null), CancellationToken.None);

			await Promise.all([pendingA, pendingB]);
			await fixture.settleCurrentRender();

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [resource.toString()],
				readResources: [resource.toString()],
				readOptions: [{ length: 4 }],
				claims: 1,
				releases: 0,
				htmlDocuments: ['viewer'],
				overlayCallsAfterDispose: 0,
			});
		});

		test('does not revive an editor when setInput is called after disposal', async () => {
			const fixture = createDocxEditorFixture();
			const resource = URI.file('/workspace/document.docx');

			fixture.editor.dispose();
			await fixture.editor.setInput(fixture.createInput(resource), undefined, Object.create(null), CancellationToken.None);

			deepStrictEqual(fixture.snapshot(), {
				watcherResources: [],
				readResources: [],
				readOptions: [],
				claims: 0,
				releases: 0,
				htmlDocuments: [],
				overlayCallsAfterDispose: 0,
			});
		});
	});
});
