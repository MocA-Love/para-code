/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import { deepStrictEqual, ok, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { configureParadisSpanRunner, ParadisSpanAttributes } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { PARADIS_PDF_FIRST_PAINT_MESSAGE, PARADIS_PDF_VIEW_STATE_MESSAGE, PARADIS_PDF_ZOOM_MESSAGE } from '../../common/paradisPdfViewerHtml.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IOverlayWebview, IWebviewService } from '../../../../../workbench/contrib/webview/browser/webview.js';
import { TestEditorGroupView, TestLayoutService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { getParadisPdfRenderDecision, isParadisPdfHeader, ParadisPdfFileEditor, readParadisPdfHeader } from '../../electron-browser/paradisPdfFileEditor.js';
import { ParadisPdfInput } from '../../electron-browser/paradisPdfInput.js';

suite('ParadisPdfFileEditor', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('reads only the PDF header and rejects empty and corrupt input', async () => {
		const options: { length: number }[] = [];
		const fileService = {
			readFile: async (_resource: URI, readOptions: { length: number }) => {
				options.push(readOptions);
				return { value: VSBuffer.fromString('%PDF-') };
			}
		} as unknown as IFileService;

		strictEqual(await readParadisPdfHeader(fileService, URI.file('/workspace/document.pdf')), true);
		deepStrictEqual(options, [{ length: 5 }]);
		deepStrictEqual([new Uint8Array(), VSBuffer.fromString('%PDF').buffer].map(isParadisPdfHeader), [false, false]);
	});

	test('creates its webview even though the render path only runs once claimed', async () => {
		// 配信先の解決を待つ間、placement は webview を作らない。**その解決を誰が蹴るか**を
		// 間違えると、描画は claim 済みでないと走らないので初回オープンで永久に白紙になる。
		// アサーションが落ちても片付くよう、スイートの store 経由で持つ。
		const disposables = store.add(new DisposableStore());
		const created: string[] = [];
		const webview = {
			contentOptions: {},
			onFatalError: Event.None,
			onMessage: Event.None,
			setHtml: () => { },
			claim: () => { },
			release: () => { },
			focus: () => { },
			setAnchorElement: () => { },
			container: document.createElement('div'),
			dispose: () => { },
		} as unknown as IOverlayWebview;
		const webviewService = { createWebviewOverlay: () => { created.push('webview'); return webview; } } as unknown as IWebviewService;
		const fileService = {
			readFile: async () => ({ value: VSBuffer.fromString('%PDF-') }),
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const sharedProcessService = {
			getChannel: () => ({ call: () => Promise.reject(new Error('no preview server')), listen: () => { throw new Error('not used'); } }),
		} as unknown as ISharedProcessService;

		const editor = disposables.add(new ParadisPdfFileEditor(
			new TestEditorGroupView(1),
			sharedProcessService,
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			webviewService,
			fileService,
			new TestLayoutService(),
		));
		editor.create(document.createElement('div'));
		const textFileService = { isDirty: () => false } as unknown as ITextFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const input = disposables.add(new ParadisPdfInput(URI.file('/workspace/document.pdf'), textFileService, workingCopyService));

		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		editor.layout(new Dimension(800, 600));
		// 解決（ここでは失敗）が終わったあと、placement が自分で作り直しに来る。
		await new Promise(resolve => setTimeout(resolve, 0));
		await new Promise(resolve => setTimeout(resolve, 0));

		deepStrictEqual(created, ['webview']);
	});

	test('ends the open timing only with the first-paint message of the HTML it is showing', async () => {
		// 使い回した webview には、前の文書の知らせが遅れて届くことがある。それで今の計測を終わらせない。
		const disposables = store.add(new DisposableStore());
		const spans: ParadisSpanAttributes[] = [];
		configureParadisSpanRunner((_feature, operation, attributes, callback) => {
			if (operation === 'open-paint' && attributes) {
				spans.push(attributes);
			}
			return callback();
		});
		disposables.add({ dispose: () => configureParadisSpanRunner((_feature, _operation, _attributes, callback) => callback()) });
		const messages = disposables.add(new Emitter<{ message: unknown }>());
		const html: string[] = [];
		const htmlSet = disposables.add(new Emitter<void>());
		const webview = {
			contentOptions: {},
			onFatalError: Event.None,
			onMessage: messages.event,
			setHtml: (value: string) => { html.push(value); htmlSet.fire(); },
			claim: () => { },
			release: () => { },
			focus: () => { },
			setAnchorElement: () => { },
			container: document.createElement('div'),
			dispose: () => { },
		} as unknown as IOverlayWebview;
		const webviewService = { createWebviewOverlay: () => webview } as unknown as IWebviewService;
		const fileService = {
			readFile: async () => ({ value: VSBuffer.fromString('%PDF-') }),
			stat: async () => ({ size: 2048 }),
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const sharedProcessService = {
			getChannel: () => ({ call: () => Promise.reject(new Error('no preview server')), listen: () => { throw new Error('not used'); } }),
		} as unknown as ISharedProcessService;
		const editor = disposables.add(new ParadisPdfFileEditor(new TestEditorGroupView(1), sharedProcessService, NullTelemetryService, new TestThemeService(), disposables.add(new TestStorageService()), webviewService, fileService, new TestLayoutService()));
		editor.create(document.createElement('div'));
		const firstHtml = Event.toPromise(htmlSet.event, disposables);
		const input = disposables.add(new ParadisPdfInput(URI.file('/workspace/document.pdf'), { isDirty: () => false } as unknown as ITextFileService, { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService));
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		editor.layout(new Dimension(800, 600));
		await firstHtml;
		const render = /render: "(?<render>[^"]+)"/.exec(html[html.length - 1] ?? '')?.groups?.render;
		ok(render);

		messages.fire({ message: { type: PARADIS_PDF_FIRST_PAINT_MESSAGE, render: 'an-earlier-document', pages: 9 } });
		const afterStale = spans.length;
		messages.fire({ message: { type: PARADIS_PDF_FIRST_PAINT_MESSAGE, render, pages: 3 } });
		deepStrictEqual({ afterStale, sent: spans.map(span => [span.safe_viewer, span.safe_pages, span.safe_size_kb]) }, { afterStale: 0, sent: [['pdf', 3, 2]] });
	});

	test('shows the zoom and page of the current document in the toolbar and sends the zoom buttons to the page', async () => {
		const disposables = store.add(new DisposableStore());
		const messages = disposables.add(new Emitter<{ message: unknown }>());
		const html: string[] = [];
		const htmlSet = disposables.add(new Emitter<void>());
		const posted: unknown[] = [];
		const webview = {
			contentOptions: {},
			onFatalError: Event.None,
			onMessage: messages.event,
			setHtml: (value: string) => { html.push(value); htmlSet.fire(); },
			postMessage: async (message: unknown) => { posted.push(message); return true; },
			claim: () => { },
			release: () => { },
			focus: () => { },
			setAnchorElement: () => { },
			container: document.createElement('div'),
			dispose: () => { },
		} as unknown as IOverlayWebview;
		const webviewService = { createWebviewOverlay: () => webview } as unknown as IWebviewService;
		const fileService = {
			readFile: async () => ({ value: VSBuffer.fromString('%PDF-') }),
			stat: async () => ({ size: 2048 }),
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const sharedProcessService = {
			getChannel: () => ({ call: () => Promise.reject(new Error('no preview server')), listen: () => { throw new Error('not used'); } }),
		} as unknown as ISharedProcessService;
		const editor = disposables.add(new ParadisPdfFileEditor(new TestEditorGroupView(1), sharedProcessService, NullTelemetryService, new TestThemeService(), disposables.add(new TestStorageService()), webviewService, fileService, new TestLayoutService()));
		const parent = document.createElement('div');
		editor.create(parent);
		const firstHtml = Event.toPromise(htmlSet.event, disposables);
		const input = disposables.add(new ParadisPdfInput(URI.file('/workspace/document.pdf'), { isDirty: () => false } as unknown as ITextFileService, { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService));
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		editor.layout(new Dimension(800, 600));
		await firstHtml;
		const render = /render: "(?<render>[^"]+)"/.exec(html[html.length - 1] ?? '')?.groups?.render;
		ok(render);
		const bar = () => [parent.querySelector('.paradis-pdf-toolbar .paradis-viewer-toolbar-position')?.textContent, parent.querySelector('.paradis-pdf-toolbar .paradis-viewer-toolbar-percent')?.textContent];

		messages.fire({ message: { type: PARADIS_PDF_VIEW_STATE_MESSAGE, render: 'an-earlier-document', zoom: 300, page: 9, pages: 9 } });
		const afterStale = bar();
		messages.fire({ message: { type: PARADIS_PDF_VIEW_STATE_MESSAGE, render, zoom: 85, page: 2, pages: 12 } });
		const afterCurrent = bar();
		parent.querySelectorAll<HTMLButtonElement>('.paradis-pdf-toolbar .paradis-viewer-toolbar-button').forEach(button => button.click());
		parent.querySelector<HTMLButtonElement>('.paradis-pdf-toolbar .paradis-viewer-toolbar-percent')!.click();

		deepStrictEqual({ afterStale, afterCurrent, posted }, {
			afterStale: ['', ''],
			afterCurrent: ['2 / 12 ページ', '85%'],
			posted: ['out', 'in', 'fit', 'reset'].map(command => ({ type: PARADIS_PDF_ZOOM_MESSAGE, command })),
		});
	});

	test('keeps the shown PDF when coming back to its tab, unless the file changed or the first paint never came', async () => {
		// 別の種類のタブへ移ると clearInput → setVisible(false)、戻ると setVisible(true) → setInput になる。
		const disposables = store.add(new DisposableStore());
		const run = async (confirmPaint: boolean, mtimeOnReturn: number) => {
			const messages = disposables.add(new Emitter<{ message: unknown }>());
			const htmlSet = disposables.add(new Emitter<void>());
			const statCalled = disposables.add(new Emitter<void>());
			const html: string[] = [];
			let mtime = 1;
			let stats = 0;
			const webview = {
				contentOptions: {},
				onFatalError: Event.None,
				onMessage: messages.event,
				setHtml: (value: string) => { html.push(value); htmlSet.fire(); },
				claim: () => { },
				release: () => { },
				focus: () => { },
				setAnchorElement: () => { },
				container: document.createElement('div'),
				dispose: () => { },
			} as unknown as IOverlayWebview;
			const fileService = {
				readFile: async () => ({ value: VSBuffer.fromString('%PDF-') }),
				stat: async () => { stats++; statCalled.fire(); return { size: 2048, mtime, etag: `e${mtime}` }; },
				createWatcher: () => { throw new Error('watching is unavailable in this test'); },
				onDidWatchError: Event.None,
			} as unknown as IFileService;
			const sharedProcessService = {
				getChannel: () => ({ call: () => Promise.reject(new Error('no preview server')), listen: () => { throw new Error('not used'); } }),
			} as unknown as ISharedProcessService;
			const editor = disposables.add(new ParadisPdfFileEditor(new TestEditorGroupView(1), sharedProcessService, NullTelemetryService, new TestThemeService(), disposables.add(new TestStorageService()), { createWebviewOverlay: () => webview } as unknown as IWebviewService, fileService, new TestLayoutService()));
			editor.create(document.createElement('div'));
			const resource = URI.file('/workspace/document.pdf');
			const createInput = () => disposables.add(new ParadisPdfInput(resource, { isDirty: () => false } as unknown as ITextFileService, { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService));

			const firstHtml = Event.toPromise(htmlSet.event, disposables);
			await editor.setInput(createInput(), undefined, Object.create(null), CancellationToken.None);
			editor.layout(new Dimension(800, 600));
			await firstHtml;
			if (confirmPaint) {
				const render = /render: "(?<render>[^"]+)"/.exec(html[html.length - 1] ?? '')?.groups?.render;
				messages.fire({ message: { type: PARADIS_PDF_FIRST_PAINT_MESSAGE, render, pages: 1 } });
			}
			editor.clearInput();
			editor.setVisible(false);
			mtime = mtimeOnReturn;
			stats = 0;
			const rerendered = Event.toPromise(htmlSet.event, disposables);
			const checked = Event.toPromise(statCalled.event, disposables);
			editor.setVisible(true);
			await editor.setInput(createInput(), undefined, Object.create(null), CancellationToken.None);
			if (confirmPaint && mtimeOnReturn === 1) {
				// 使い回すときは stat を 1 回読んで判定するだけ。判定の続きが走り切るまで待つ。
				await checked;
				for (let turn = 0; turn < 8; turn++) {
					await Promise.resolve();
				}
			} else {
				await rerendered;
			}
			return { html: html.length, stats };
		};

		deepStrictEqual({
			unchanged: await run(true, 1),
			changedWhileAway: await run(true, 2),
			neverPainted: await run(false, 1),
		}, {
			unchanged: { html: 1, stats: 1 },
			changedWhileAway: { html: 2, stats: 2 },
			neverPainted: { html: 2, stats: 1 },
		});
	});

	test('maps PDF preflight results to the observable render outcome', () => {
		const resource = URI.file('/workspace/document.pdf');
		const otherResource = URI.file('/workspace/other.pdf');

		deepStrictEqual([
			getParadisPdfRenderDecision(false, resource, resource, 1, 1),
			getParadisPdfRenderDecision(true, resource, resource, 1, 1),
			getParadisPdfRenderDecision(undefined, resource, resource, 1, 1),
			getParadisPdfRenderDecision(false, resource, otherResource, 1, 1),
			getParadisPdfRenderDecision(false, resource, resource, 1, 2),
		], ['rejected', 'viewer', 'viewer', 'stale', 'stale']);
	});
});
