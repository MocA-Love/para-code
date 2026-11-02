/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisModalDraftSnapshot, ParadisModalDrafts } from '../../browser/paradisModalDrafts.js';

suite('ParadisModalDrafts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps drafts per key, drops the oldest over the limit, and keeps nothing unchanged or before loading', () => {
		const drafts = new ParadisModalDrafts<{ name: string; rows: string[] }>(2);
		drafts.keep('a', { name: 'a', rows: ['one'] });
		drafts.keepIfChanged('b', { name: 'b', rows: [] }, paradisModalDraftSnapshot({ name: 'b', rows: [] }));
		drafts.keepIfChanged('c', { name: 'c', rows: [] }, undefined);
		drafts.keep('d', { name: 'd', rows: [] });
		drafts.keep('a', { name: 'a2', rows: [] });
		drafts.keep('e', { name: 'e', rows: [] });
		const keys = drafts.keys();
		const takenA = drafts.take('a');
		const takenAgain = drafts.take('a');
		drafts.discard('e');
		assert.deepStrictEqual({ keys, takenA, takenAgain, left: drafts.keys() }, {
			keys: ['a', 'e'],
			takenA: { name: 'a2', rows: [] },
			takenAgain: undefined,
			left: [],
		});
	});

	test('a draft is a copy that does not follow later changes', () => {
		const drafts = new ParadisModalDrafts<{ rows: string[] }>();
		const live = { rows: ['one'] };
		drafts.keep('x', live);
		live.rows.push('two');
		assert.deepStrictEqual(drafts.take('x'), { rows: ['one'] });
	});
});
