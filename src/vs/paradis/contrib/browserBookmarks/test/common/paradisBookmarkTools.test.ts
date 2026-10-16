/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisBookmarkNode } from '../../common/paradisBookmarkModel.js';
import { paradisBookmarkToolTitle, paradisBookmarkToolTree, paradisParseEditBookmarks, paradisParseListBookmarks } from '../../common/paradisBookmarkTools.js';

suite('Paradis bookmark MCP tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads each action with exactly the arguments it takes', () => {
		const parse = (args: unknown) => {
			const parsed = paradisParseEditBookmarks(args);
			return parsed.ok ? { request: parsed.request, ...(parsed.needsTab ? { needsTab: parsed.needsTab } : {}) } : parsed.error;
		};
		assert.deepStrictEqual([
			{ action: 'add', url: ' https://example.com/a ', title: 'A\nB', folder_id: 'f1' },
			{ action: 'add' },
			{ action: 'add', tab_id: 'tab-2', folder_id: null },
			{ action: 'add', url: 'javascript:alert(1)' },
			{ action: 'add', url: 'file:///etc/hosts' },
			{ action: 'add', url: 'https://example.com', tab_id: 'tab-2' },
			{ action: 'create_folder', title: 'Docs' },
			{ action: 'create_folder', title: '   ' },
			{ action: 'rename', id: 'n1', title: 'New' },
			{ action: 'rename', title: 'New' },
			{ action: 'move', id: 'n1', folder_id: 'f1', index: 2 },
			{ action: 'move', id: 'n1', index: -1 },
			{ action: 'move', id: 'n1', title: 'x' },
			{ action: 'delete', id: 'n1' },
			{ action: 'delete', id: 'n1', recursive: true },
			{ action: 'delete', id: 'n1', recursive: 'yes' },
			{ action: 'delete' },
			{ action: 'remove', id: 'n1' },
			{ action: 'rename', id: '', title: 'x' },
			{ action: 'rename', id: 'n1', title: ' \n ' },
		].map(parse), [
			{ request: { op: 'add', url: 'https://example.com/a', title: 'A B', folderId: 'f1' } },
			{ request: { op: 'add', url: '', title: '', folderId: null }, needsTab: { tabId: undefined } },
			{ request: { op: 'add', url: '', title: '', folderId: null }, needsTab: { tabId: 'tab-2' } },
			'"url" must be an http or https URL.',
			'"url" must be an http or https URL.',
			'Give either "url" or "tab_id", not both.',
			{ request: { op: 'createFolder', title: 'Docs', folderId: null } },
			'action "create_folder" needs a non-empty "title".',
			{ request: { op: 'rename', id: 'n1', title: 'New' } },
			'action "rename" needs the "id" of a bookmark or folder from list_bookmarks.',
			{ request: { op: 'move', id: 'n1', folderId: 'f1', index: 2 } },
			'"index" must be an integer of 0 or more.',
			'action "move" does not take "title".',
			{ request: { op: 'delete', id: 'n1', recursive: false } },
			{ request: { op: 'delete', id: 'n1', recursive: true } },
			'"recursive" must be true or false.',
			'action "delete" needs the "id" of a bookmark or folder from list_bookmarks.',
			'"action" must be one of "add", "create_folder", "rename", "move", "delete".',
			'"id" must be an id from list_bookmarks.',
			'action "rename" needs a non-empty "title".',
		]);
	});

	test('lists the tree with ids, one-line titles and a cap on the number of nodes', () => {
		const nodes: ParadisBookmarkNode[] = [
			{ id: 'f1', type: 'folder', title: 'Docs', createdAt: 1, children: [{ id: 'b1', type: 'bookmark', url: 'https://a.example', title: 'A\u0007\ttitle', createdAt: 1, faviconHash: 'h' }] },
			{ id: 'b2', type: 'bookmark', url: 'https://b.example', title: 'B', createdAt: 1 },
		];
		assert.deepStrictEqual({
			full: paradisBookmarkToolTree(nodes),
			capped: paradisBookmarkToolTree(nodes, 2),
			folder: paradisParseListBookmarks({ folder_id: 'f1' }),
			badFolder: paradisParseListBookmarks({ folder_id: 3 }),
			longTitle: Array.from(paradisBookmarkToolTitle('x'.repeat(300))).length,
			// SSH の接続先へは、クエリ・フラグメント・ユーザー情報を落とした URL を返す
			redacted: paradisBookmarkToolTree([
				{ id: 'b3', type: 'bookmark', url: 'https://user:secret@intra.example:8443/path/a?token=abc#frag', title: 'C', createdAt: 1 },
				{ id: 'b4', type: 'bookmark', url: 'not a url?token=abc', title: 'D', createdAt: 1 },
			], undefined, true).nodes,
		}, {
			full: {
				nodes: [
					{ id: 'f1', type: 'folder', title: 'Docs', children: [{ id: 'b1', type: 'bookmark', title: 'A title', url: 'https://a.example' }] },
					{ id: 'b2', type: 'bookmark', title: 'B', url: 'https://b.example' },
				],
				count: 3,
				truncated: false,
			},
			capped: { nodes: [{ id: 'f1', type: 'folder', title: 'Docs', children: [{ id: 'b1', type: 'bookmark', title: 'A title', url: 'https://a.example' }] }], count: 2, truncated: true },
			folder: { ok: true, request: { op: 'list', folderId: 'f1' } },
			badFolder: { ok: false, error: '"folder_id" must be an id from list_bookmarks.' },
			longTitle: 200,
			redacted: [
				{ id: 'b3', type: 'bookmark', title: 'C', url: 'https://intra.example:8443/path/a' },
				{ id: 'b4', type: 'bookmark', title: 'D', url: 'not a url' },
			],
		});
	});
});
