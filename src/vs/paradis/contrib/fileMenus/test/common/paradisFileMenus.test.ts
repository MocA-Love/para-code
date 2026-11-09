/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ResourceTree } from '../../../../../base/common/resourceTree.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCommonFolder, paradisFilePathsPrompt, paradisResolveFileMenuTargets, paradisTerminalFolders, paradisToWindowUri } from '../../common/paradisFileMenus.js';

const ROOT = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev-server', path: '/home/example/app' });
const file = (path: string) => ROOT.with({ path: `${ROOT.path}/${path}` });

/** ソース管理の ISCMResource のうち、読む分だけ。 */
const scmResource = (path: string) => ({ sourceUri: file(path), resourceGroup: {}, decorations: {} });

/** 検索の FileMatch・FolderMatch（`resource` は getter）と、その行（Match）。 */
class SearchFileMatch {
	constructor(private readonly _resource: URI) { }
	get resource(): URI { return this._resource; }
}
class SearchLineMatch {
	constructor(private readonly _parent: SearchFileMatch) { }
	parent(): SearchFileMatch { return this._parent; }
}

const asText = (uris: readonly URI[] | undefined) => uris?.map(uri => uri.toString());

suite('Paradis file menus', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves the arguments of each place into the files to act on', () => {
		const a = scmResource('src/a.ts');
		const b = scmResource('src/b.ts');
		const fileA = new SearchFileMatch(file('src/a.ts'));
		const fileB = new SearchFileMatch(file('src/b.ts'));
		const folder = new SearchFileMatch(file('src'));
		assert.deepStrictEqual({
			// ソース管理: 選んだ resource が並べて渡る
			scmOne: asText(paradisResolveFileMenuTargets([a], undefined)),
			scmMany: asText(paradisResolveFileMenuTargets([a, b], undefined)),
			// 検索: 選択が無いときは要素だけ
			searchOne: asText(paradisResolveFileMenuTargets([undefined, fileA], undefined)),
			// 検索: 右クリックした要素を含む選択は全部。行は親のファイルになり、重なりは外す
			searchSelection: asText(paradisResolveFileMenuTargets([fileA, [fileA, new SearchLineMatch(fileA), fileB, folder]], undefined)),
			// 検索: 選択の外を右クリックしたときは、その要素だけ
			searchOutside: asText(paradisResolveFileMenuTargets([fileB, [fileA, folder]], undefined)),
			// ブランチの変更点: 拡張の側が URI の配列にして渡す
			branchDiff: asText(paradisResolveFileMenuTargets([[file('README.md')]], undefined)),
			nothing: asText(paradisResolveFileMenuTargets([undefined, {}, 'text'], undefined)),
		}, {
			scmOne: [file('src/a.ts').toString()],
			scmMany: [file('src/a.ts').toString(), file('src/b.ts').toString()],
			searchOne: [file('src/a.ts').toString()],
			searchSelection: [file('src/a.ts').toString(), file('src/b.ts').toString(), file('src').toString()],
			searchOutside: [file('src/b.ts').toString()],
			branchDiff: [file('README.md').toString()],
			nothing: [],
		});
	});

	test('recovers the right-clicked source control folder from the list, since its files are what the menu passes', () => {
		const tree = new ResourceTree<ReturnType<typeof scmResource>, void>(undefined, ROOT);
		const a = scmResource('src/lib/a.ts');
		const b = scmResource('src/b.ts');
		const c = scmResource('test/c.ts');
		tree.add(a.sourceUri, a);
		tree.add(b.sourceUri, b);
		tree.add(c.sourceUri, c);
		const src = tree.root.get('src')!;
		const test = tree.root.get('test')!;
		const leafB = src.get('b.ts')!;
		assert.deepStrictEqual({
			// フォルダー 1 つ: 引数は中のファイル（a, b）、一覧の focus がフォルダー
			folder: asText(paradisResolveFileMenuTargets([a, b], { focus: [src], selection: [] })),
			// フォルダー 2 つを選んで右クリック
			folders: asText(paradisResolveFileMenuTargets([a, b, c], { focus: [src], selection: [src, test] })),
			// 選択の外のフォルダーを右クリックしたときは、そのフォルダーだけ
			folderOutside: asText(paradisResolveFileMenuTargets([c], { focus: [test], selection: [src] })),
			// ファイル（ツリー表示の葉）を右クリックしたときは引数のまま
			treeFile: asText(paradisResolveFileMenuTargets([b], { focus: [leafB], selection: [] })),
			// 一覧の focus が別のフォルダー（キーボードで動かした後など）なら、引数のまま
			mismatch: asText(paradisResolveFileMenuTargets([c], { focus: [src], selection: [] })),
		}, {
			folder: [file('src').toString()],
			folders: [file('src').toString(), file('test').toString()],
			folderOutside: [file('test').toString()],
			treeFile: [file('src/b.ts').toString()],
			mismatch: [file('test/c.ts').toString()],
		});
	});

	test('turns file URIs from git into the connected host only in a remote window', () => {
		const local = URI.file('/home/example/app/src/a.ts');
		assert.deepStrictEqual([
			paradisToWindowUri(local, 'ssh-remote+dev-server').toString(),
			paradisToWindowUri(local, undefined).toString(),
			paradisToWindowUri(file('src/a.ts'), 'ssh-remote+dev-server').toString(),
			paradisToWindowUri(URI.parse('untitled:Untitled-1'), 'ssh-remote+dev-server').toString(),
		], [
			'vscode-remote://ssh-remote%2Bdev-server/home/example/app/src/a.ts',
			'file:///home/example/app/src/a.ts',
			file('src/a.ts').toString(),
			'untitled:Untitled-1',
		]);
	});

	test('opens a terminal in each distinct folder, the parent folder for a file', () => {
		assert.deepStrictEqual(asText(paradisTerminalFolders([
			{ resource: file('src/a.ts'), isDirectory: false },
			{ resource: file('src/b.ts'), isDirectory: false },
			{ resource: file('src'), isDirectory: true },
			{ resource: file('test'), isDirectory: true },
		])), [file('src').toString(), file('test').toString()]);
	});

	test('checks the space with the folder that holds every file, and sends one path per line', () => {
		assert.deepStrictEqual({
			one: paradisCommonFolder([file('src/a.ts')])?.toString(),
			siblings: paradisCommonFolder([file('src/a.ts'), file('src/lib/b.ts')])?.toString(),
			apart: paradisCommonFolder([file('src/a.ts'), file('test/c.ts')])?.toString(),
			otherHost: paradisCommonFolder([file('src/a.ts'), URI.file('/home/example/app/src/b.ts')])?.toString(),
			none: paradisCommonFolder([]),
			prompt: paradisFilePathsPrompt(['src/a.ts', 'test/c.ts']),
		}, {
			one: file('src/a.ts').toString(),
			siblings: file('src').toString(),
			apart: ROOT.toString(),
			otherHost: undefined,
			none: undefined,
			prompt: 'src/a.ts\ntest/c.ts',
		});
	});
});
