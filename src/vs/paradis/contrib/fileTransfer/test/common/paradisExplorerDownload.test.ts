/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisExplorerDownloadItem, paradisPlanBatchDownload, paradisSummarizeBatchDownload, paradisUsesBatchDownload } from '../../common/paradisExplorerDownload.js';

const REMOTE = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev-server', path: '/home/example/apps' });
const OTHER_ROOT = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev-server', path: '/home/example/tools' });
const LOCAL = URI.file('/Users/example/web-app');

function item(root: URI, path: string, isDirectory = false): IParadisExplorerDownloadItem {
	const resource = joinPath(root, path);
	return { resource, name: path.split('/').pop()!, isDirectory };
}

suite('Paradis file transfer - explorer batch download', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('only two or more items of the connected host use the batch download', () => {
		assert.deepStrictEqual([
			paradisUsesBatchDownload([item(REMOTE, 'a.txt')]),
			paradisUsesBatchDownload([item(REMOTE, 'a.txt'), item(REMOTE, 'b.txt')]),
			paradisUsesBatchDownload([item(REMOTE, 'a.txt'), item(LOCAL, 'b.txt')]),
			paradisUsesBatchDownload([item(LOCAL, 'a.txt'), item(LOCAL, 'b.txt')]),
			paradisUsesBatchDownload([]),
		], [false, true, false, false, false]);
	});

	test('drops items inside a selected folder and duplicates, and renames the same name from different parents', () => {
		const planned = paradisPlanBatchDownload([
			item(REMOTE, 'src', true),
			item(REMOTE, 'src/index.ts'),
			item(REMOTE, 'README.md'),
			item(REMOTE, 'README.md'),
			item(REMOTE, 'docs/readme.md'),
			item(OTHER_ROOT, 'src', true),
			item(REMOTE, 'srcs/a.txt'),
		]);
		assert.deepStrictEqual(planned.map(source => ({ path: source.resource.path, name: source.name, isDirectory: source.isDirectory })), [
			{ path: '/home/example/apps/src', name: 'src', isDirectory: true },
			{ path: '/home/example/apps/README.md', name: 'README.md', isDirectory: false },
			// 手元は大文字と小文字を区別しないことがあるので、別名にする
			{ path: '/home/example/apps/docs/readme.md', name: 'readme (1).md', isDirectory: false },
			{ path: '/home/example/tools/src', name: 'src (1)', isDirectory: true },
			// 名前が前方一致するだけのフォルダーの中身は外さない
			{ path: '/home/example/apps/srcs/a.txt', name: 'a.txt', isDirectory: false },
		]);
	});

	test('summarizes the progress of the queued items only, counting removed rows as finished', () => {
		const summary = paradisSummarizeBatchDownload([1, 2, 3, 4], [
			{ id: 1, state: 'done', totalBytes: 100, doneBytes: 100, skipped: 1 },
			{ id: 2, state: 'running', totalBytes: 200, doneBytes: 100, skipped: 0 },
			{ id: 3, state: 'waiting', totalBytes: undefined, doneBytes: 0, skipped: 0 },
			// 別の転送の行は数えない
			{ id: 9, state: 'error', totalBytes: 10, doneBytes: 0, skipped: 5 },
		]);
		const finished = paradisSummarizeBatchDownload([1, 2], [
			{ id: 1, state: 'error', totalBytes: 100, doneBytes: 10, skipped: 0 },
			{ id: 2, state: 'cancelled', totalBytes: 100, doneBytes: 10, skipped: 2 },
		]);
		assert.deepStrictEqual({ summary, finished }, {
			summary: { finished: 2, total: 4, percent: 62, failed: 0, cancelled: 0, skipped: 1 },
			finished: { finished: 2, total: 2, percent: 100, failed: 1, cancelled: 1, skipped: 2 },
		});
	});
});
