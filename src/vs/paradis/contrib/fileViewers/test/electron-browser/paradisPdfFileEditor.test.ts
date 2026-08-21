/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import { deepStrictEqual, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
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
