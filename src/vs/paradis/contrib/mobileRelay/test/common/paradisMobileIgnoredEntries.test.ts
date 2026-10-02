/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileIgnoredRuns, paradisMarkMobileIgnoredEntries, paradisMobileIgnoredRepoDir, paradisMobileIgnoredStatusArgs, paradisParseMobileIgnoredNames } from '../../common/paradisMobileIgnoredEntries.js';

suite('ParadisMobileIgnoredEntries', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('limits git status to the listed folder without pathspec magic', () => {
		assert.deepStrictEqual([paradisMobileIgnoredStatusArgs('').at(-1), paradisMobileIgnoredStatusArgs('/src/*/').at(-1)], ['.', ':(literal)src/*']);
	});

	test('reads only the direct children that are ignored', () => {
		const stdout = ['!! node_modules/', ' M src/a.ts', '?? docs/', '!! src/out/', '!! src/gen/x.log', 'R  src/new.ts', 'src/!! old.ts', '!! .env', ''].join('\0');
		const toSorted = (value: ReadonlySet<string> | 'all') => value === 'all' ? value : [...value].sort();
		assert.deepStrictEqual({
			root: toSorted(paradisParseMobileIgnoredNames(stdout, '')),
			src: toSorted(paradisParseMobileIgnoredNames(stdout, 'src')),
			inside: paradisParseMobileIgnoredNames('!! node_modules/\0', 'node_modules/lodash'),
		}, {
			root: ['.env', 'node_modules'],
			src: ['out'],
			inside: 'all',
		});
	});

	test('reads repository-root paths when the space is a folder inside the repository', () => {
		const stdout = ['!! packages/app/dist/', '!! packages/app/src/gen.ts', ''].join('\0');
		assert.deepStrictEqual({
			root: [...paradisParseMobileIgnoredNames(stdout, paradisMobileIgnoredRepoDir('packages/app/\n', ''))],
			src: [...paradisParseMobileIgnoredNames(stdout, paradisMobileIgnoredRepoDir('packages/app/\n', 'src'))],
			plain: paradisMobileIgnoredRepoDir('\n', 'src'),
			skipsSubmodules: paradisMobileIgnoredStatusArgs('').includes('--ignore-submodules=all'),
		}, { root: ['dist'], src: ['gen.ts'], plain: 'src', skipsSubmodules: true });
	});

	test('runs one git per space and reuses a recent result', async () => {
		let now = 0;
		let started = 0;
		const pending: ((value: string) => void)[] = [];
		const runs = new ParadisMobileIgnoredRuns<string>(1000, 64, () => now);
		const start = () => { started++; return new Promise<string>(resolve => pending.push(resolve)); };
		const first = runs.lookup('ws', 'src', start);
		const samePath = runs.lookup('ws', 'src', start);
		const otherPath = await runs.lookup('ws', 'docs', start);
		const otherSpace = runs.lookup('ws2', 'src', start);
		pending[0]('a');
		pending[1]('b');
		const results = [await first, await samePath, otherPath, await otherSpace];
		const cached = await runs.lookup('ws', 'src', start);
		now = 2000;
		const expired = runs.lookup('ws', 'src', start);
		pending[2]('c');
		assert.deepStrictEqual({ results, cached, expired: await expired, started }, { results: ['a', 'a', undefined, 'b'], cached: 'a', expired: 'c', started: 3 });
	});

	test('marks entries without touching the others', () => {
		const entries = [{ name: 'a', dir: true }, { name: 'b', dir: false }];
		assert.deepStrictEqual({
			some: paradisMarkMobileIgnoredEntries(entries, new Set(['b'])),
			all: paradisMarkMobileIgnoredEntries(entries, 'all'),
			none: paradisMarkMobileIgnoredEntries(entries, undefined),
		}, {
			some: [{ name: 'a', dir: true }, { name: 'b', dir: false, ignored: true }],
			all: [{ name: 'a', dir: true, ignored: true }, { name: 'b', dir: false, ignored: true }],
			none: entries,
		});
	});
});
