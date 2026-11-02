/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileChangesEvent, FileChangeType, IFileService } from '../../../../../platform/files/common/files.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import type { IOverlayWebview, IWebviewService } from '../../../../../workbench/contrib/webview/browser/webview.js';
import type { IWorkbenchLayoutService } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { ParadisOverlayWebviewPane, watchParadisViewerResource } from '../../browser/paradisOverlayWebviewPane.js';

suite('ParadisOverlayWebviewPane', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('calls back once per burst of changes and tells whether the file was deleted', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const resource = URI.file('/doc/a.pdf');
		const changes = store.add(new Emitter<FileChangesEvent>());
		const fileService = { createWatcher: () => ({ onDidChange: changes.event, dispose: () => { } }) } as unknown as IFileService;
		const calls: boolean[] = [];
		const watch = watchParadisViewerResource(fileService, resource, deleted => calls.push(deleted));
		const event = (type: FileChangeType, target = resource) => new FileChangesEvent([{ resource: target, type }], true);
		changes.fire(event(FileChangeType.UPDATED));
		changes.fire(event(FileChangeType.UPDATED));
		changes.fire(event(FileChangeType.UPDATED, URI.file('/doc/other.pdf')));
		await new Promise(resolve => setTimeout(resolve, 60));
		changes.fire(event(FileChangeType.DELETED));
		changes.fire(event(FileChangeType.ADDED));
		await new Promise(resolve => setTimeout(resolve, 60));
		watch.dispose();
		deepStrictEqual(calls, [false, true]);
	}));

	test('claims once, recreates the webview when the service worker choice changes, and empties it on request', () => {
		const created: { disableServiceWorker: boolean; html: string[]; claims: number; releases: number; disposed: boolean }[] = [];
		const webviewService = {
			createWebviewOverlay: (init: { options: { disableServiceWorker: boolean } }) => {
				const record = { disableServiceWorker: init.options.disableServiceWorker, html: [] as string[], claims: 0, releases: 0, disposed: false };
				created.push(record);
				return {
					container: mainWindow.document.createElement('div'),
					onFatalError: Event.None,
					claim: () => { record.claims++; },
					release: () => { record.releases++; },
					setAnchorElement: () => { },
					setHtml: (html: string) => { record.html.push(html); },
					dispose: () => { record.disposed = true; },
				} as unknown as IOverlayWebview;
			},
		} as unknown as IWebviewService;
		const layoutService = { getContainer: () => mainWindow.document.body } as unknown as IWorkbenchLayoutService;
		let disposedCalls = 0;
		const pane = store.add(new ParadisOverlayWebviewPane({}, {
			originKey: 'test.viewer', enableFindWidget: false, allowScripts: true,
			onDidDispose: () => { disposedCalls++; },
		}, webviewService, layoutService, store.add(new TestStorageService())));
		const container = mainWindow.document.createElement('div');
		let disableServiceWorker = false;
		const options = () => ({ disableServiceWorker, localResourceRoots: [] });
		const claimed = [
			pane.place(true, mainWindow, container, options, () => { }),
			pane.place(true, mainWindow, container, options, () => { }),
		];
		disableServiceWorker = true;
		claimed.push(pane.place(true, mainWindow, container, options, () => { }));
		// 閉じたタブの文書が、いま書いてある文書のときだけ空にする。
		const shown = URI.file('/doc/shown.pdf');
		pane.setDocumentHtml(pane.webview!, shown, '<p>doc</p>');
		pane.clearContentFor(URI.file('/doc/other.pdf'));
		pane.clearContentFor(shown);
		pane.clearContentFor(shown);
		claimed.push(pane.place(false, mainWindow, container, options, () => { }));
		// 戻ったときに描き直さないための記録: 描き終わりを確かめたものだけ使い回し、確かめる前に離れたら捨て、閉じたら捨てる。
		const webview = pane.webview!;
		const record = (confirmed: boolean) => ({ resource: shown, webview, keys: ['etag'], confirmed });
		pane.shown = record(false);
		const beforeConfirm = pane.canReuseShown(shown, ['etag']);
		pane.confirmShown(webview);
		const afterConfirm = [pane.canReuseShown(shown, ['etag']), pane.canReuseShown(shown, ['other'])];
		pane.forgetUnconfirmedShown();
		const keptConfirmed = pane.shown !== undefined;
		pane.shown = record(false);
		pane.forgetUnconfirmedShown();
		const droppedUnconfirmed = pane.shown === undefined;
		pane.shown = record(true);
		pane.clearContentFor(shown);
		const droppedOnClose = pane.shown === undefined;
		deepStrictEqual({ beforeConfirm, afterConfirm, keptConfirmed, droppedUnconfirmed, droppedOnClose }, { beforeConfirm: false, afterConfirm: [true, false], keptConfirmed: true, droppedUnconfirmed: true, droppedOnClose: true });
		deepStrictEqual({ claimed, disposedCalls, created }, {
			claimed: [true, false, true, undefined],
			disposedCalls: 1,
			created: [
				{ disableServiceWorker: false, html: [], claims: 1, releases: 1, disposed: true },
				{ disableServiceWorker: true, html: ['<p>doc</p>', ''], claims: 1, releases: 1, disposed: false },
			],
		});
	});
});
