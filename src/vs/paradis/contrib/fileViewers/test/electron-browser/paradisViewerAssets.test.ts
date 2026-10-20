/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IParadisPreviewMount } from '../../common/paradisHtmlPreview.js';
import { resolveParadisViewerDocumentUrl, resolveParadisViewerLibBase } from '../../electron-browser/paradisViewerAssets.js';

suite('paradisViewerAssets', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 呼ばれた引数を記録し、決まった載せ先を返す偽の shared process。 */
	function sharedProcess(mount: IParadisPreviewMount) {
		const calls: unknown[] = [];
		const channel = {
			call: async (_command: string, arg?: unknown) => {
				calls.push(arg);
				return mount;
			},
			listen: () => { throw new Error('not used'); },
		} as unknown as IChannel;
		const service = { getChannel: () => channel } as unknown as ISharedProcessService;
		return { service, calls };
	}

	test('builds the document URL from the name the server serves (a symlink resolves to its target)', async () => {
		const { service } = sharedProcess({ port: 4000, token: 'abc', file: 'v3.pdf' });

		const url = await resolveParadisViewerDocumentUrl(service, URI.file('/docs/latest.pdf'));

		assert.strictEqual(url, 'http://127.0.0.1:4000/abc/v3.pdf');
	});

	test('pins the library mount so the server never evicts it', async () => {
		const { service, calls } = sharedProcess({ port: 4000, token: 'lib' });

		const base = await resolveParadisViewerLibBase(service, URI.file('/app/lib'));

		assert.deepStrictEqual({ base, calls }, { base: 'http://127.0.0.1:4000/lib', calls: [[URI.file('/app/lib').fsPath, { pinned: true }]] });
	});
});
