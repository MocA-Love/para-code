/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisMobileDiffIdentity, paradisMobileReviewState, paradisParseMobilePorcelainStatus, paradisParseNumstatZ, paradisWithMobileLineCounts } from '../../common/paradisMobileDiffReview.js';

suite('ParadisMobileDiffReview', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads porcelain status, keeping the original path of a rename', () => {
		assert.deepStrictEqual(paradisParseMobilePorcelainStatus(' M src/a.ts\nR  old.ts -> new.ts\n?? notes/\n'), [
			{ x: ' ', y: 'M', path: 'src/a.ts' },
			{ x: 'R', y: ' ', path: 'new.ts', oldPath: 'old.ts' },
			{ x: '?', y: '?', path: 'notes/' },
		]);
	});

	test('reads numstat -z, including renames and binary files', () => {
		const counts = paradisParseNumstatZ('3\t1\tsrc/a.ts\0-\t-\timage.png\0' + '2\t0\t\0old.ts\0new.ts\0');
		assert.deepStrictEqual([...counts], [
			['src/a.ts', { added: 3, removed: 1 }],
			['image.png', { added: -1, removed: -1 }],
			['new.ts', { added: 2, removed: 0 }],
		]);
	});

	test('adds the counts of each side to the status entries', () => {
		const files = paradisParseMobilePorcelainStatus('MM src/a.ts\n?? b.ts\n');
		assert.deepStrictEqual(paradisWithMobileLineCounts(files, '3\t1\tsrc/a.ts\0', '1\t0\tsrc/a.ts\0'), [
			{ x: 'M', y: 'M', path: 'src/a.ts', added: 3, removed: 1, stagedAdded: 1, stagedRemoved: 0 },
			{ x: '?', y: '?', path: 'b.ts' },
		]);
		assert.deepStrictEqual(paradisWithMobileLineCounts(files, undefined, undefined), files);
	});

	test('the identity changes with the content counts and the staging state, and is stable otherwise', () => {
		const base = { x: ' ', y: 'M', path: 'a.ts', added: 3, removed: 1 };
		const identity = paradisMobileDiffIdentity(base);
		assert.deepStrictEqual({
			shape: /^[0-9a-f]{16}$/.test(identity),
			stable: paradisMobileDiffIdentity({ ...base }) === identity,
			moreLines: paradisMobileDiffIdentity({ ...base, added: 4 }) === identity,
			staged: paradisMobileDiffIdentity({ x: 'M', y: ' ', path: 'a.ts', stagedAdded: 3, stagedRemoved: 1 }) === identity,
			otherPath: paradisMobileDiffIdentity({ ...base, path: 'b.ts' }) === identity,
		}, { shape: true, stable: true, moreLines: false, staged: false, otherPath: false });
	});

	test('a mark counts as reviewed only while the identity matches', () => {
		assert.deepStrictEqual([
			paradisMobileReviewState('abc', undefined),
			paradisMobileReviewState('abc', { identity: 'abc', reviewedAt: 1 }),
			paradisMobileReviewState('abd', { identity: 'abc', reviewedAt: 1 }),
		], ['todo', 'reviewed', 'changed']);
	});
});
