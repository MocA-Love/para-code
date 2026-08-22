/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import 'mocha';
import * as assert from 'assert';
import { IParadisUnaccountedCandidate, selectUnaccountedForParking } from '../paradisUnaccountedToPark';

function candidate(root: string, rootRealPath?: string): IParadisUnaccountedCandidate {
	return { repository: { root, rootRealPath } };
}

/**
 * `../util`'s `isDescendant` pulls in the `vscode` module transitively, which isn't available
 * outside the extension host, so these tests exercise `selectUnaccountedForParking`'s own
 * filtering logic (bidirectional match, rootRealPath fallback) against a POSIX-path stand-in
 * with the same contract. `isDescendant` itself is covered wherever the extension host tests run.
 */
function isDescendant(parent: string, descendant: string): boolean {
	if (parent === descendant) {
		return true;
	}
	return descendant.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

suite('selectUnaccountedForParking', () => {

	test('keeps a repository whose root exactly matches a current folder', () => {
		const repo = candidate('/w/repo');
		const result = selectUnaccountedForParking([repo], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, []);
	});

	test('parks a repository no current folder covers', () => {
		const repo = candidate('/other/repo');
		const result = selectUnaccountedForParking([repo], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, [repo]);
	});

	test('keeps a repository nested inside a current folder', () => {
		// e.g. a sibling worktree opened by auto-detection under the workspace folder.
		const repo = candidate('/w/repo/nested');
		const result = selectUnaccountedForParking([repo], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, []);
	});

	test('keeps a repository that is an ancestor of the current folder', () => {
		// e.g. the workspace folder is a subdirectory of a parent repository.
		const repo = candidate('/w');
		const result = selectUnaccountedForParking([repo], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, []);
	});

	test('matches through rootRealPath when the plain root disagrees with every folder', () => {
		const repo = candidate('/tmp/work', '/private/tmp/work');
		const result = selectUnaccountedForParking([repo], ['/private/tmp/work'], isDescendant);
		assert.deepStrictEqual(result, []);
	});

	test('parks only the candidates unaccounted for, keeping the rest', () => {
		const kept = candidate('/w/repo');
		const parked = candidate('/other/repo');
		const result = selectUnaccountedForParking([kept, parked], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, [parked]);
	});

	test('parks every candidate when there are no current folders at all', () => {
		const repo = candidate('/w/repo');
		const result = selectUnaccountedForParking([repo], [], isDescendant);
		assert.deepStrictEqual(result, [repo]);
	});
});
