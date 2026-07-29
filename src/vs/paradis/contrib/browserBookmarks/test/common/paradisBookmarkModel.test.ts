/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	collectParadisFaviconHashes,
	findParadisBookmarkByUrl,
	findParadisNodeById,
	findParadisParentFolderId,
	flattenParadisBookmarks,
	getParadisFolderOptions,
	insertParadisNodeIntoFolder,
	IParadisBookmark,
	IParadisBookmarkFolder,
	moveParadisRootNode,
	normalizeParadisBookmarkUrl,
	ParadisBookmarkNode,
	removeParadisNodeFromTree,
	syncParadisFaviconInTree,
} from '../../common/paradisBookmarkModel.js';

function bookmark(id: string, url: string, faviconHash?: string): IParadisBookmark {
	return {
		id,
		type: 'bookmark',
		url,
		title: id,
		faviconHash,
		createdAt: 1,
	};
}

function folder(id: string, children: readonly ParadisBookmarkNode[], title = id): IParadisBookmarkFolder {
	return {
		id,
		type: 'folder',
		title,
		children,
		createdAt: 1,
	};
}

suite('Paradis bookmark model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes origins while preserving meaningful path, query, hash, and unparseable input', () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			['  https://example.com/  ', 'https://example.com'],
			['https://example.com/path?q=1#part', 'https://example.com/path?q=1#part'],
			['https://example.com/?q=1', 'https://example.com/?q=1'],
			['custom value///', 'custom value'],
			['about:blank', 'about:blank'],
			['   ', ''],
		];

		for (const [input, expected] of cases) {
			assert.strictEqual(normalizeParadisBookmarkUrl(input), expected);
		}
	});

	test('finds deeply nested nodes, normalized duplicate URLs, and parent folders', () => {
		const nestedBookmark = bookmark('nested-bookmark', 'https://example.com/');
		const tree = [
			bookmark('root-bookmark', 'https://root.example/path'),
			folder('outer', [
				folder('inner', [nestedBookmark]),
			]),
		];

		assert.strictEqual(findParadisNodeById(tree, 'nested-bookmark'), nestedBookmark);
		assert.strictEqual(findParadisNodeById(tree, 'missing'), undefined);
		assert.strictEqual(findParadisBookmarkByUrl(tree, ' https://example.com '), nestedBookmark);
		assert.strictEqual(findParadisBookmarkByUrl(tree, 'https://example.com/', 'nested-bookmark'), undefined);
		assert.strictEqual(findParadisParentFolderId(tree, 'nested-bookmark'), 'inner');
		assert.strictEqual(findParadisParentFolderId(tree, 'outer'), null);
		assert.strictEqual(findParadisParentFolderId(tree, 'missing'), null);
	});

	test('inserts into a nested folder without mutating the source tree', () => {
		const source = [
			folder('outer', [
				folder('inner', []),
			]),
			bookmark('root', 'https://root.example'),
		];
		const insertedBookmark = bookmark('inserted', 'https://inserted.example');

		const result = insertParadisNodeIntoFolder(source, insertedBookmark, 'inner');

		assert.strictEqual(result.inserted, true);
		assert.deepStrictEqual(result.nodes, [
			folder('outer', [
				folder('inner', [insertedBookmark]),
			]),
			bookmark('root', 'https://root.example'),
		]);
		assert.deepStrictEqual(source, [
			folder('outer', [
				folder('inner', []),
			]),
			bookmark('root', 'https://root.example'),
		]);
	});

	test('leaves the tree unchanged when the insertion folder is missing', () => {
		const source = [folder('existing', [])];

		const result = insertParadisNodeIntoFolder(source, bookmark('new', 'https://new.example'), 'missing');

		assert.strictEqual(result.inserted, false);
		assert.deepStrictEqual(result.nodes, source);
		assert.strictEqual(result.nodes[0], source[0]);
	});

	test('removes exactly one deeply nested subtree and returns it', () => {
		const removedFolder = folder('remove-me', [
			bookmark('child', 'https://child.example'),
		]);
		const sibling = bookmark('sibling', 'https://sibling.example');
		const outerFolder = folder('outer', [removedFolder, sibling]);
		const source = [
			outerFolder,
			bookmark('root', 'https://root.example'),
		];

		const result = removeParadisNodeFromTree(source, 'remove-me');

		assert.strictEqual(result.removed, removedFolder);
		assert.deepStrictEqual(result.nodes, [
			folder('outer', [sibling]),
			bookmark('root', 'https://root.example'),
		]);
		assert.strictEqual(source[0], outerFolder);
		assert.strictEqual(findParadisNodeById(source, 'remove-me'), removedFolder);
	});

	test('moves root nodes in either direction and rejects same, missing, or nested drop targets', () => {
		const source = [
			bookmark('first', 'https://first.example'),
			folder('parent', [
				bookmark('nested', 'https://nested.example'),
			]),
			bookmark('last', 'https://last.example'),
		];

		assert.deepStrictEqual(
			moveParadisRootNode(source, 'first', 'last')?.map(node => node.id),
			['parent', 'last', 'first'],
		);
		assert.deepStrictEqual(
			moveParadisRootNode(source, 'last', 'first')?.map(node => node.id),
			['last', 'first', 'parent'],
		);
		assert.strictEqual(moveParadisRootNode(source, 'first', 'first'), undefined);
		assert.strictEqual(moveParadisRootNode(source, 'missing', 'first'), undefined);
		assert.strictEqual(moveParadisRootNode(source, 'parent', 'nested'), undefined);
		assert.deepStrictEqual(source.map(node => node.id), ['first', 'parent', 'last']);
	});

	test('flattens bookmarks depth-first and derives nested folder labels', () => {
		const first = bookmark('first', 'https://first.example');
		const second = bookmark('second', 'https://second.example');
		const third = bookmark('third', 'https://third.example');
		const tree = [
			folder('outer', [
				first,
				folder('inner', [second], '  '),
			], 'Outer'),
			third,
		];

		assert.deepStrictEqual(flattenParadisBookmarks(tree), [first, second, third]);
		assert.deepStrictEqual(getParadisFolderOptions(tree, 'Untitled'), [
			{ id: 'outer', label: 'Outer' },
			{ id: 'inner', label: 'Outer / Untitled' },
		]);
	});

	test('collects unique favicon hashes and updates all normalized URL matches', () => {
		const matchingRoot = bookmark('root-match', 'https://match.example/', 'old-root');
		const matchingNested = bookmark('nested-match', 'https://match.example', 'old-nested');
		const untouched = bookmark('untouched', 'https://other.example', 'shared');
		const tree = [
			matchingRoot,
			folder('folder', [
				matchingNested,
				untouched,
				bookmark('duplicate-hash', 'https://duplicate.example', 'shared'),
			]),
		];

		assert.deepStrictEqual([...collectParadisFaviconHashes(tree)].sort(), ['old-nested', 'old-root', 'shared']);

		const result = syncParadisFaviconInTree(tree, ' https://match.example ', 'current');
		assert.strictEqual(result.updated, true);
		assert.deepStrictEqual(
			flattenParadisBookmarks(result.nodes).map(node => [node.id, node.faviconHash]),
			[
				['root-match', 'current'],
				['nested-match', 'current'],
				['untouched', 'shared'],
				['duplicate-hash', 'shared'],
			],
		);
		assert.strictEqual(findParadisNodeById(result.nodes, 'untouched'), untouched);
		assert.deepStrictEqual([...collectParadisFaviconHashes(result.nodes)].sort(), ['current', 'shared']);
	});

	test('reports no favicon update when every matching bookmark already has the hash', () => {
		const tree = [bookmark('match', 'https://match.example/', 'current')];

		const result = syncParadisFaviconInTree(tree, 'https://match.example', 'current');

		assert.strictEqual(result.updated, false);
		assert.strictEqual(result.nodes[0], tree[0]);
	});
});
