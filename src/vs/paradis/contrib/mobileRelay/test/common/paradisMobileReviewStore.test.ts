/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisMobileReviewSpace,
	PARADIS_MOBILE_REVIEW_MAX_MARKS,
	PARADIS_MOBILE_REVIEW_MAX_SPACES,
	paradisApplyMobileReviewMarkChanges,
	paradisParseMobileReviewStore,
	paradisPruneMobileReviewSpace,
	paradisSerializeMobileReviewStore,
	paradisTrimMobileReviewSpace,
} from '../../common/paradisMobileReviewStore.js';

suite('ParadisMobileReviewStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads what it can and skips broken spaces and marks', () => {
		const raw = JSON.stringify({
			repo: { marks: { 'a.ts': { identity: '00aa', reviewedAt: 5 }, 'b.ts': { identity: 'XYZ', reviewedAt: 5 }, '/abs': { identity: '00aa', reviewedAt: 5 } }, updatedAt: 9 },
			broken: 'text',
		});
		assert.deepStrictEqual([...paradisParseMobileReviewStore(raw)], [['repo', { marks: { 'a.ts': { identity: '00aa', reviewedAt: 5 } }, notes: [], updatedAt: 9, revision: 0 }]]);
		assert.deepStrictEqual([...paradisParseMobileReviewStore('{')], []);
	});

	test('keeps the most recently used spaces and drops empty ones when serializing', () => {
		const spaces = new Map<string, IParadisMobileReviewSpace>(Array.from({ length: PARADIS_MOBILE_REVIEW_MAX_SPACES + 2 }, (_, index) => [`ws-${index}`, { marks: { 'a.ts': { identity: '00aa', reviewedAt: index } }, notes: [], updatedAt: index, revision: 0 }]));
		spaces.set('empty', { marks: {}, notes: [], updatedAt: 1_000, revision: 0 });
		const kept = Object.keys(JSON.parse(paradisSerializeMobileReviewStore(spaces)));
		assert.deepStrictEqual({ count: kept.length, oldestDropped: !kept.includes('ws-0') && !kept.includes('ws-1'), empty: kept.includes('empty') }, { count: PARADIS_MOBILE_REVIEW_MAX_SPACES, oldestDropped: true, empty: false });
	});

	test('caps the marks of a space by keeping the latest ones, and prunes paths no longer changed', () => {
		const many = Array.from({ length: PARADIS_MOBILE_REVIEW_MAX_MARKS + 1 }, (_, index) => ({ path: `f${index}.ts`, identity: '00aa' }));
		const first = paradisApplyMobileReviewMarkChanges({ marks: {}, notes: [], updatedAt: 0, revision: 0 }, many.slice(0, 1), 1);
		const capped = paradisApplyMobileReviewMarkChanges(first, many.slice(1), 2);
		const pruned = paradisPruneMobileReviewSpace(capped, new Set(['f1.ts']));
		assert.deepStrictEqual({
			count: Object.keys(capped.marks).length,
			dropsOldest: capped.marks['f0.ts'] === undefined,
			pruned: Object.keys(pruned.marks),
			unchanged: paradisPruneMobileReviewSpace(pruned, new Set(['f1.ts'])) === pruned,
		}, { count: PARADIS_MOBILE_REVIEW_MAX_MARKS, dropsOldest: true, pruned: ['f1.ts'], unchanged: true });
	});
	test('trims the oldest records of a space before dropping the space', () => {
		const note = (id: string, updatedAt: number, sentAt?: number) => ({ id, path: 'a.ts', line: 1, lineText: 'x', body: id, createdAt: 1, updatedAt, ...(sentAt !== undefined ? { sentAt } : {}) });
		const space = {
			marks: { 'old.ts': { identity: '00aa', reviewedAt: 1 }, 'new.ts': { identity: '00aa', reviewedAt: 9 } },
			notes: [note('sent', 1, 2), note('open', 5)],
			updatedAt: 9,
			revision: 3,
		};
		const trimmed = paradisTrimMobileReviewSpace(space);
		assert.deepStrictEqual({
			marks: Object.keys(trimmed!.marks),
			notes: trimmed!.notes.map(item => item.id),
			last: paradisTrimMobileReviewSpace({ marks: { 'a.ts': { identity: '00aa', reviewedAt: 1 } }, notes: [], updatedAt: 1, revision: 0 }),
		}, { marks: ['new.ts'], notes: ['open'], last: undefined });
	});
});
