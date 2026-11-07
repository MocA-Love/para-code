/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBookmarkTiles, paradisRankFrequentPages } from '../../common/paradisBrowserNewTabTiles.js';

suite('ParadisBrowserNewTab - tiles', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ranks pages by how often they were opened, then by how recently', () => {
		const tiles = paradisRankFrequentPages([
			{ url: 'https://github.com/a?tab=1', title: 'Repo A', time: 1, icon: 'g' },
			{ url: 'https://github.com/a/', title: '', time: 5 },
			{ url: 'https://docs.example.com/', title: 'Docs', time: 9 },
			{ url: 'http://localhost:5173/', title: 'Acme Admin', time: 3, icon: 'v' },
			{ url: 'http://localhost:5173', title: 'Acme Admin', time: 4 },
			{ url: 'about:blank', title: '', time: 10 },
			{ url: 'https://plain.example.com/path', title: '', time: 2 },
		], 3);
		assert.deepStrictEqual(tiles.map(tile => [tile.url, tile.title, tile.iconKey, tile.count]), [
			['https://github.com/a/', 'Repo A', 'g', 2],
			['http://localhost:5173', 'Acme Admin', 'v', 2],
			['https://docs.example.com/', 'Docs', undefined, 1],
		]);
	});

	test('takes the bookmarks at the top of the bar and skips folders', () => {
		assert.deepStrictEqual(paradisBookmarkTiles([
			{ type: 'bookmark', url: 'https://a.example.com', title: 'A', faviconHash: 'h' },
			{ type: 'folder', title: 'Folder' },
			{ type: 'bookmark', url: 'https://b.example.com', title: ' ' },
		]), [
			{ url: 'https://a.example.com', title: 'A', iconKey: 'h' },
			{ url: 'https://b.example.com', title: 'https://b.example.com', iconKey: undefined },
		]);
	});
});
