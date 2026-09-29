/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsLocalFileUrl, paradisRemotePaneCdpDeniedMessage } from '../../node/paradisCdpRemotePolicy.js';

suite('ParadisCdpRemotePolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes file: URLs the way the URL parser would', () => {
		const urls = ['file:///etc/passwd', 'FILE:///x', ' \u0001file:///x', 'fi\tle:///x', 'view-source:file:///x', 'view-source: view-source:file:///x', 'https://example.com/file:///x', 'about:blank', 'filesystem:https://a/x', 42];
		assert.deepStrictEqual(urls.map(url => paradisIsLocalFileUrl(url)), [true, true, true, true, true, true, false, false, false, false]);
	});

	test('denies only the commands that reach local files', () => {
		const deniedMethods = [
			['DOM.setFileInputFiles', { files: ['/etc/passwd'], backendNodeId: 1 }],
			['DOM.getFileInfo', { objectId: 'x' }],
			['Page.handleFileChooser', { action: 'accept', files: ['/etc/passwd'] }],
			['Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { items: [], files: ['/etc/passwd'], dragOperationsMask: 1 } }],
			['Page.navigate', { url: 'file:///etc/passwd' }],
			['Target.createTarget', { url: 'view-source:file:///etc/passwd' }],
			['Tracing.start', { perfettoConfig: 'base64-config' }],
			['Tracing.start', { tracingBackend: 'system' }],
			['Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { items: [{ mimeType: 'text/plain', data: 'hi' }], dragOperationsMask: 1 } }],
			['Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { items: [], files: [], dragOperationsMask: 1 } }],
			['Page.navigate', { url: 'https://example.com' }],
			['Page.navigateToHistoryEntry', { entryId: 1 }],
			['Runtime.evaluate', { expression: 'location.href' }],
			['Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['devtools.timeline'] } }],
		] as const;
		assert.deepStrictEqual(deniedMethods.map(([method, params]) => paradisRemotePaneCdpDeniedMessage(method, params as Record<string, unknown>) !== undefined), [
			true, true, true, true, true, true, true, true,
			false, false, false, false, false, false,
		]);
	});
});
