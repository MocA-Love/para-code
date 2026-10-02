/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisPaneEntry,
	paradisCanChangePermissions,
	paradisFilterEntries,
	paradisFormatSize,
	paradisMatchRange,
	paradisNextSort,
	paradisNumberedName,
	paradisSortEntries,
	PARADIS_DEFAULT_SORT,
} from '../../common/paradisFileTransferListing.js';

function entry(name: string, kind: IParadisPaneEntry['kind'], size: number | undefined, mtime: number, isDirectory = kind === 'directory'): IParadisPaneEntry {
	return { name, resource: URI.file(`/work/${name}`), kind, isDirectory, size, mtime, mode: undefined };
}

const ENTRIES: readonly IParadisPaneEntry[] = [
	entry('src', 'directory', undefined, 50),
	entry('.git', 'directory', undefined, 90),
	entry('dist', 'directory', undefined, 70),
	entry('README.md', 'file', 4915, 30),
	entry('build.tar.gz', 'file', 50646630, 80),
	entry('.env', 'file', 412, 10),
	entry('package.json', 'file', 2150, 60),
	entry('current', 'symlink', 33, 40, true),
	entry('file10.txt', 'file', 1, 20),
	entry('file2.txt', 'file', 1, 20),
];

const names = (entries: readonly IParadisPaneEntry[]) => entries.map(candidate => candidate.name);

suite('Paradis file transfer - listing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('sorts with folders always on top, in both directions', () => {
		assert.deepStrictEqual({
			name: names(paradisSortEntries(ENTRIES, PARADIS_DEFAULT_SORT)),
			nameDescending: names(paradisSortEntries(ENTRIES, { key: 'name', descending: true })),
			sizeDescending: names(paradisSortEntries(ENTRIES, { key: 'size', descending: true })),
			mtime: names(paradisSortEntries(ENTRIES, { key: 'mtime', descending: false })),
		}, {
			name: ['.git', 'current', 'dist', 'src', '.env', 'build.tar.gz', 'file2.txt', 'file10.txt', 'package.json', 'README.md'],
			nameDescending: ['src', 'dist', 'current', '.git', 'README.md', 'package.json', 'file10.txt', 'file2.txt', 'build.tar.gz', '.env'],
			sizeDescending: ['current', '.git', 'dist', 'src', 'build.tar.gz', 'README.md', 'package.json', '.env', 'file2.txt', 'file10.txt'],
			mtime: ['current', 'src', 'dist', '.git', '.env', 'file2.txt', 'file10.txt', 'README.md', 'package.json', 'build.tar.gz'],
		});
	});

	test('a second click on the same column flips the direction; date and size start from the largest', () => {
		assert.deepStrictEqual([
			paradisNextSort(PARADIS_DEFAULT_SORT, 'name'),
			paradisNextSort({ key: 'name', descending: true }, 'name'),
			paradisNextSort(PARADIS_DEFAULT_SORT, 'size'),
			paradisNextSort(PARADIS_DEFAULT_SORT, 'mtime'),
			paradisNextSort({ key: 'size', descending: true }, 'kind'),
		], [
			{ key: 'name', descending: true },
			{ key: 'name', descending: false },
			{ key: 'size', descending: true },
			{ key: 'mtime', descending: true },
			{ key: 'kind', descending: false },
		]);
	});

	test('filters hidden files and by a case-insensitive part of the name', () => {
		assert.deepStrictEqual({
			hiddenOff: names(paradisFilterEntries(ENTRIES, { filter: '', showHidden: false })),
			hiddenOn: paradisFilterEntries(ENTRIES, { filter: '', showHidden: true }).length,
			filtered: names(paradisFilterEntries(ENTRIES, { filter: ' MD ', showHidden: false })),
			filteredHidden: names(paradisFilterEntries(ENTRIES, { filter: 'en', showHidden: false })),
			filteredHiddenShown: names(paradisFilterEntries(ENTRIES, { filter: 'en', showHidden: true })),
		}, {
			hiddenOff: ['src', 'dist', 'README.md', 'build.tar.gz', 'package.json', 'current', 'file10.txt', 'file2.txt'],
			hiddenOn: 10,
			filtered: ['README.md'],
			filteredHidden: ['current'],
			filteredHiddenShown: ['.env', 'current'],
		});
	});

	test('a leftover transfer file is listed even while hidden files are hidden', () => {
		const partial = entry('.paratransfer-3-1-abc-def', 'file', 10, 1);
		assert.deepStrictEqual(names(paradisFilterEntries([...ENTRIES, partial], { filter: '', showHidden: false })).filter(name => name.startsWith('.')), ['.paratransfer-3-1-abc-def']);
	});

	test('finds the range to highlight', () => {
		assert.deepStrictEqual([
			paradisMatchRange('nginx.conf', 'CONF'),
			paradisMatchRange('nginx.conf', ''),
			paradisMatchRange('nginx.conf', 'xyz'),
		], [{ start: 6, end: 10 }, undefined, undefined]);
	});

	test('numbers a conflicting name before the first extension', () => {
		assert.deepStrictEqual(
			[paradisNumberedName('build.tar.gz', 1), paradisNumberedName('README.md', 2), paradisNumberedName('.env', 1), paradisNumberedName('Makefile', 3)],
			['build (1).tar.gz', 'README (2).md', '.env (1)', 'Makefile (3)'],
		);
	});

	test('permissions can be changed only for known modes and never on links', () => {
		const file = { kind: 'file' as const, mode: 0o644 };
		const link = { kind: 'symlink' as const, mode: 0o777 };
		const unknown = { kind: 'file' as const, mode: undefined };
		assert.deepStrictEqual([
			paradisCanChangePermissions([file], true),
			paradisCanChangePermissions([file, link], true),
			paradisCanChangePermissions([link], true),
			paradisCanChangePermissions([unknown], true),
			paradisCanChangePermissions([file], false),
			paradisCanChangePermissions([], true),
		], [true, false, false, false, false, false]);
	});

	test('formats sizes in 1024 steps', () => {
		assert.deepStrictEqual(
			[0, 412, 1229, 831488, 50646630, 3 * 1024 * 1024 * 1024].map(paradisFormatSize),
			['0 B', '412 B', '1.2 KB', '812.0 KB', '48.3 MB', '3.0 GB'],
		);
	});
});
