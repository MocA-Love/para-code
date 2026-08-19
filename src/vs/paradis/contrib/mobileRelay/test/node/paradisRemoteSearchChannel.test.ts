/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisRemoteSearchChannel, ParadisRemoteSearchService } from '../../node/paradisRemoteSearchChannel.js';

suite('ParadisRemoteSearchChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createChannel() {
		const calls: { readonly method: string; readonly rootPath: string; readonly query: string; readonly maxResults: number }[] = [];
		const service = new ParadisRemoteSearchService(new NullLogService());
		// ripgrep自体は起動せず、サービスへ届く引数だけを検証する（実際の検索は paradisMobileSearch.test.ts が別途持つべき領域）
		service.searchFiles = async (rootPath, query, maxResults) => { calls.push({ method: 'searchFiles', rootPath, query, maxResults }); return { files: [], truncated: false }; };
		service.searchText = async (rootPath, query, maxResults) => { calls.push({ method: 'searchText', rootPath, query, maxResults }); return { matches: [], truncated: false }; };
		const channel = new ParadisRemoteSearchChannel(service);
		return { channel, calls };
	}

	test('dispatches searchFiles with the positional arguments unpacked', async () => {
		const { channel, calls } = createChannel();

		const result = await channel.call('ctx', 'searchFiles', ['/repo', 'needle', 100]);

		assert.deepStrictEqual(result, { files: [], truncated: false });
		assert.deepStrictEqual(calls, [{ method: 'searchFiles', rootPath: '/repo', query: 'needle', maxResults: 100 }]);
	});

	test('dispatches searchText with the positional arguments unpacked', async () => {
		const { channel, calls } = createChannel();

		const result = await channel.call('ctx', 'searchText', ['/repo', 'needle', 200]);

		assert.deepStrictEqual(result, { matches: [], truncated: false });
		assert.deepStrictEqual(calls, [{ method: 'searchText', rootPath: '/repo', query: 'needle', maxResults: 200 }]);
	});

	test('rejects an unknown command instead of silently no-op-ing', async () => {
		const { channel } = createChannel();

		// call() は同期的に throw する（Promise を返す前に例外を投げる）ので、呼び出し自体を包む。
		await assert.rejects(async () => channel.call('ctx', 'deleteEverything', ['/repo']), /Method not found/);
	});
});
