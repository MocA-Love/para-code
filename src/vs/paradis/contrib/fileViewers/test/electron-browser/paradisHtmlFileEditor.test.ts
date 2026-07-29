/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
/* eslint-disable local/code-no-unexternalized-strings */

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IOverlayWebview, IWebviewService } from '../../../../../workbench/contrib/webview/browser/webview.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { TestEditorGroupView, TestLayoutService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ParadisHtmlFileEditor } from '../../electron-browser/paradisHtmlFileEditor.js';
import { ParadisHtmlFileInput } from '../../electron-browser/paradisHtmlFileInput.js';

class TestParadisHtmlFileEditor extends ParadisHtmlFileEditor {

	get scriptsAllowed(): boolean {
		return this.allowScripts;
	}

	render(text: string, resource: URI): string {
		return this.renderDocument(text, resource, Object.create(null) as IOverlayWebview);
	}
}

suite('ParadisHtmlFileEditor', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createGenerationEditor(): TestParadisHtmlFileEditor {
		return disposables.add(new TestParadisHtmlFileEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			Object.create(null) as IWebviewService,
			Object.create(null) as ITextFileService,
			Object.create(null) as IFileService,
			Object.create(null) as ITextModelService,
			disposables.add(new TestInstantiationService()),
			new TestLayoutService(),
			new TestConfigurationService(),
		));
	}

	function createProductionEditor(webviewService: IWebviewService, textFileService: ITextFileService, fileService: IFileService): ParadisHtmlFileEditor {
		return disposables.add(new ParadisHtmlFileEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			webviewService,
			textFileService,
			fileService,
			Object.create(null) as ITextModelService,
			disposables.add(new TestInstantiationService()),
			new TestLayoutService(),
			new TestConfigurationService(),
		));
	}

	test('public setInput applies script and resource policy before setting rendered HTML', async () => {
		const resource = URI.file('/workspace/site/index.html');
		const source = '<main><img src="./assets/logo.png"></main>';
		let renderedHtml: string | undefined;
		let contentOptionsAtSetHtml: { allowScripts: boolean | undefined; localResourceRoots: string[] | undefined } | undefined;
		const webview = {
			contentOptions: {},
			onFatalError: Event.None,
			setHtml: (html: string) => {
				renderedHtml = html;
				contentOptionsAtSetHtml = {
					allowScripts: webview.contentOptions.allowScripts,
					localResourceRoots: webview.contentOptions.localResourceRoots?.map(root => root.toString()),
				};
			},
			focus: () => { },
			dispose: () => { },
		} as unknown as IOverlayWebview;
		const webviewService = {
			createWebviewOverlay: () => webview,
		} as unknown as IWebviewService;
		const textFileService = {
			read: () => Promise.resolve({ value: source }),
		} as unknown as ITextFileService;
		const fileService = {
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const editor = createProductionEditor(webviewService, textFileService, fileService);
		const input = disposables.add(new ParadisHtmlFileInput(resource, textFileService, workingCopyService));

		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);

		deepStrictEqual(contentOptionsAtSetHtml, {
			allowScripts: true,
			localResourceRoots: ['file:///workspace/site'],
		});
		ok(renderedHtml);
		const document = new DOMParser().parseFromString(renderedHtml, 'text/html');
		strictEqual(document.querySelector('base')?.getAttribute('href'), 'https://file+.vscode-resource.vscode-cdn.net/workspace/site/');
		strictEqual(document.querySelector('img')?.getAttribute('src'), './assets/logo.png');
	});

	suite('renderDocument generation contract', () => {

		test('preserves the author CSP and external script URL', () => {
			const editor = createGenerationEditor();
			const source = `<!DOCTYPE html>
<html>
<head>
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://trusted.example">
	<script src="https://trusted.example/app.js"></script>
</head>
<body></body>
</html>`;

			const document = new DOMParser().parseFromString(editor.render(source, URI.file('/workspace/site/index.html')), 'text/html');
			const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
			const externalScript = document.querySelector('script[src]');

			strictEqual(editor.scriptsAllowed, true);
			strictEqual(csp?.getAttribute('content'), "default-src 'none'; script-src https://trusted.example");
			strictEqual(externalScript?.getAttribute('src'), 'https://trusted.example/app.js');
		});

		test('resolves relative document assets from the viewed file directory', () => {
			const editor = createGenerationEditor();
			const source = '<main><img id="logo" src="./assets/logo.png"><a id="guide" href="../guide.html">Guide</a></main>';

			const document = new DOMParser().parseFromString(editor.render(source, URI.file('/workspace/site/index.html')), 'text/html');
			const base = document.querySelector('base');
			const image = document.querySelector<HTMLImageElement>('#logo');
			const link = document.querySelector<HTMLAnchorElement>('#guide');

			ok(base);
			ok(image);
			ok(link);
			strictEqual(base.getAttribute('href'), 'https://file+.vscode-resource.vscode-cdn.net/workspace/site/');
			strictEqual(new URL(image.getAttribute('src')!, base.href).toString(), 'https://file+.vscode-resource.vscode-cdn.net/workspace/site/assets/logo.png');
			strictEqual(new URL(link.getAttribute('href')!, base.href).toString(), 'https://file+.vscode-resource.vscode-cdn.net/workspace/guide.html');
		});
	});
});
