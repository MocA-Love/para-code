/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MOBILE_PC_CAPABILITIES } from '../../common/paradisMobileCompat.js';
import { PARADIS_MOBILE_REVIEW_NOTES_CAPABILITY, PARADIS_MOBILE_REVIEW_STAGE_CAPABILITY, PARADIS_MOBILE_REVIEW_STORE_CAPABILITY, paradisBuildReviewNotesPrompt, paradisLocateReviewNoteLine, paradisStagedConsistently, paradisStagedContentDiffers, paradisWithUntrackedFileStats, paradisMobileDiffIdentity, paradisMobileReviewState, paradisParseMobilePorcelainStatus, paradisParseNumstatZ, paradisWithMobileLineCounts } from '../../common/paradisMobileDiffReview.js';

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

	test('follows a note to its line by content, within the search radius', () => {
		const lines = ['a', 'target', 'b'];
		const textAt = (line: number) => lines[line - 1];
		const shifted = ['new', ...lines];
		const far = [...Array.from({ length: 60 }, () => 'pad'), ...lines];
		assert.deepStrictEqual([
			paradisLocateReviewNoteLine(textAt, 2, 'target'),
			paradisLocateReviewNoteLine(line => shifted[line - 1], 2, 'target'),
			paradisLocateReviewNoteLine(line => far[line - 1], 2, 'target'),
			paradisLocateReviewNoteLine(textAt, 2, 'rewritten'),
		], [2, 3, undefined, undefined]);
	});

	test('builds the request from the stored notes, marking notes whose line moved away', () => {
		const note = { id: 'n1', path: 'src/a.ts', line: 10, lineText: '  const a = 1;  ', body: 'use let\nand rename', createdAt: 1, updatedAt: 1 };
		assert.strictEqual(paradisBuildReviewNotesPrompt([{ note, currentLine: 12 }, { note: { ...note, id: 'n2' }, currentLine: undefined }]), [
			'差分レビューのメモです。それぞれの場所を確かめて、メモに沿って直してください。',
			'',
			'1. src/a.ts:12',
			'   対象の行: const a = 1;',
			'   メモ: use let',
			'         and rename',
			'2. src/a.ts（メモを書いた後に行が変わっています。書いたときは 10 行目）',
			'   対象の行: const a = 1;',
			'   メモ: use let',
			'         and rename',
		].join('\n'));
	});
	test('the PC advertises the review capabilities the app looks for', () => {
		// アプリはこのファイルの名前で PC の広告を調べる（paradisMobileCompat.ts は依存ゼロのため、名前はここと二重に持つ）
		assert.deepStrictEqual(
			[PARADIS_MOBILE_REVIEW_STORE_CAPABILITY, PARADIS_MOBILE_REVIEW_NOTES_CAPABILITY, PARADIS_MOBILE_REVIEW_STAGE_CAPABILITY].map(name => PARADIS_MOBILE_PC_CAPABILITIES.includes(name)),
			[true, true, true],
		);
	});
	test('untracked files carry their size and time so that a rewrite changes the identity; folders do not', async () => {
		const files = paradisParseMobilePorcelainStatus('?? a.ts\n?? dir/\n M b.ts\n');
		const stats = new Map([['a.ts', { size: 10, mtime: 5 }]]);
		const asked: (readonly string[])[] = [];
		const withStats = await paradisWithUntrackedFileStats(files, async paths => { asked.push(paths); return new Map([...stats].filter(([path]) => paths.includes(path))); });
		const rewritten = await paradisWithUntrackedFileStats(files, async () => new Map([['a.ts', { size: 10, mtime: 6 }]]));
		assert.deepStrictEqual({
			files: withStats,
			asked,
			changed: paradisMobileDiffIdentity(withStats[0]!) !== paradisMobileDiffIdentity(rewritten[0]!),
		}, {
			files: [{ x: '?', y: '?', path: 'a.ts', size: 10, mtime: 5 }, { x: '?', y: '?', path: 'dir/' }, { x: ' ', y: 'M', path: 'b.ts' }],
			asked: [['a.ts']],
			changed: true,
		});
	});

	test('re-keys a mark after staging only when the staged content matches what was reviewed', () => {
		const worktree = { x: ' ', y: 'M', path: 'a.ts', added: 3, removed: 1 };
		const untracked = { x: '?', y: '?', path: 'n.ts', size: 4, mtime: 9 };
		assert.deepStrictEqual([
			paradisStagedConsistently(worktree, { x: 'M', y: ' ', path: 'a.ts', stagedAdded: 3, stagedRemoved: 1 }),
			paradisStagedConsistently(worktree, { x: 'M', y: ' ', path: 'a.ts', stagedAdded: 4, stagedRemoved: 1 }),
			paradisStagedConsistently(worktree, { x: 'M', y: 'M', path: 'a.ts', stagedAdded: 3, stagedRemoved: 1, added: 1, removed: 0 }),
			// 追跡中になった後の status には大きさが載らないので、調べ直した大きさと時刻で比べる
			paradisStagedConsistently(untracked, { x: 'A', y: ' ', path: 'n.ts' }, { size: 4, mtime: 9 }),
			paradisStagedConsistently(untracked, { x: 'A', y: ' ', path: 'n.ts' }, { size: 4, mtime: 10 }),
			paradisStagedConsistently(untracked, { x: 'A', y: ' ', path: 'n.ts' }),
			paradisStagedConsistently({ x: 'M', y: 'M', path: 'm.ts' }, { x: 'M', y: ' ', path: 'm.ts' }),
		], [true, false, false, true, false, false, false]);
	});

	// 確認していない中身を足したと言い切れるものだけ（足したものを戻す）。確かめられないものは言わない
	test('tells that the staged content differs from the reviewed one only when it can be sure', () => {
		const worktree = { x: ' ', y: 'M', path: 'a.ts', added: 3, removed: 1 };
		const untracked = { x: '?', y: '?', path: 'n.ts', size: 4, mtime: 9 };
		assert.deepStrictEqual({
			same: paradisStagedContentDiffers(worktree, { x: 'M', y: ' ', path: 'a.ts', stagedAdded: 3, stagedRemoved: 1 }),
			more: paradisStagedContentDiffers(worktree, { x: 'M', y: ' ', path: 'a.ts', stagedAdded: 4, stagedRemoved: 1 }),
			// 足した後に作業ツリーがまた変わっても、ステージ側の行数で分かる
			moreThenEdited: paradisStagedContentDiffers(worktree, { x: 'M', y: 'M', path: 'a.ts', stagedAdded: 4, stagedRemoved: 1, added: 1, removed: 0 }),
			binary: paradisStagedContentDiffers({ x: ' ', y: 'M', path: 'b.png' }, { x: 'M', y: ' ', path: 'b.png' }),
			untrackedSame: paradisStagedContentDiffers(untracked, { x: 'A', y: ' ', path: 'n.ts' }, { size: 4, mtime: 9 }),
			untrackedResized: paradisStagedContentDiffers(untracked, { x: 'A', y: ' ', path: 'n.ts' }, { size: 5, mtime: 10 }),
			// 足した後にまた書き換えられた未追跡のファイルは、足したときの中身を確かめられない
			untrackedEditedAgain: paradisStagedContentDiffers(untracked, { x: 'A', y: 'M', path: 'n.ts' }, { size: 5, mtime: 10 }),
			bothSides: paradisStagedContentDiffers({ x: 'M', y: 'M', path: 'm.ts', added: 1, removed: 0, stagedAdded: 1, stagedRemoved: 0 }, { x: 'M', y: ' ', path: 'm.ts', stagedAdded: 5, stagedRemoved: 0 }),
		}, {
			same: false,
			more: true,
			moreThenEdited: true,
			binary: false,
			untrackedSame: false,
			untrackedResized: true,
			untrackedEditedAgain: false,
			bothSides: false,
		});
	});
});
