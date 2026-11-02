/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisTerminalInstanceRecords } from '../../browser/paradisTerminalInstanceRecords.js';

suite('ParadisTerminalInstanceRecords', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('台帳の見え方は Map / Set と同じに答え、retire 1 回で全部消える', () => {
		const records = new ParadisTerminalInstanceRecords();
		const candidates = records.map('activeScopeCandidate');
		const cwds = records.map('initialCwd');
		const fallback = records.flag('activeFallback');
		const inherited = records.flag('inheritedGroupScope');

		// 値が undefined でも「ある」と答える（Map の has と同じ）
		candidates.set(1, undefined);
		cwds.set(1, '/repo');
		fallback.add(1);
		fallback.add(2);
		inherited.add(3);

		const before = {
			hasUndefinedCandidate: candidates.has(1),
			candidate: candidates.get(1),
			cwd: cwds.get(1),
			fallback: [...fallback],
			inherited: [...inherited],
			deletedMissing: cwds.delete(2),
			deletedFlag: inherited.delete(3),
			deletedAgain: inherited.delete(3),
			size: records.size,
		};
		records.retire(1);
		fallback.delete(2);

		deepStrictEqual({ before, after: { candidate: candidates.has(1), cwd: cwds.get(1), fallback: [...fallback], size: records.size } }, {
			before: {
				hasUndefinedCandidate: true,
				candidate: undefined,
				cwd: '/repo',
				fallback: [1, 2],
				inherited: [3],
				deletedMissing: false,
				deletedFlag: true,
				deletedAgain: false,
				// 3 は印を消した時点で記録ごと無くなる
				size: 2,
			},
			after: { candidate: false, cwd: undefined, fallback: [], size: 0 },
		});
	});
});
