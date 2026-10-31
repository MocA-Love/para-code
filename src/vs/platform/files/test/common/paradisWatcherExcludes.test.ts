/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PARADIS_NODE_MODULES_WATCHER_EXCLUDE, PARADIS_VENV_WATCHER_EXCLUDE, paradisRewriteParcelExcludes } from '../../common/paradisWatcherExcludes.js';
import { parseWatcherPatterns } from '../../common/watcher.js';

suite('Paradis parcel watcher excludes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rewrites only the exact Para Code defaults to root-relative forms', () => {
		const excludes = ['.git/objects/**', PARADIS_NODE_MODULES_WATCHER_EXCLUDE, '**/node_modules/**', 'node_modules/*/**', PARADIS_VENV_WATCHER_EXCLUDE, '**/.venv'];
		const original = [...excludes];

		assert.deepStrictEqual({
			rewritten: paradisRewriteParcelExcludes(excludes),
			inputUnchanged: excludes,
		}, {
			rewritten: [
				'.git/objects/**',
				'node_modules/*/**', '*/node_modules/*/**', '*/*/node_modules/*/**',
				'**/node_modules/**',
				'.venv/**', '*/.venv/**', '*/*/.venv/**',
				'**/.venv',
			],
			inputUnchanged: original,
		});
	});

	test('the JS-side exclude still uses the original keys, including deeper nesting', () => {
		const [nodeModules, venv] = parseWatcherPatterns('/repo', [PARADIS_NODE_MODULES_WATCHER_EXCLUDE, PARADIS_VENV_WATCHER_EXCLUDE], false);
		const paths = [
			'/repo/node_modules/react/index.js',
			'/repo/a/b/c/node_modules/react/index.js',
			'/repo/a/b/c/.venv/lib/site.py',
			'/repo/src/index.ts',
		];

		assert.deepStrictEqual(paths.map(path => nodeModules(path) || venv(path)), [true, true, true, false]);
	});
});
