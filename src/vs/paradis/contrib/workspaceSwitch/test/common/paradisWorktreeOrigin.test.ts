/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIssueUrlsWithoutOrigin, paradisParseWorktreeOrigin, paradisWorktreeOriginToShow } from '../../common/paradisWorktreeOrigin.js';

suite('ParadisWorktreeOrigin', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ISSUE = 'https://github.com/acme/app/issues/1234';

	test('keeps only github.com issue and pull request URLs whose number and kind match, and cleans the title', () => {
		assert.deepStrictEqual([
			paradisParseWorktreeOrigin({ kind: 'issue', url: ISSUE, number: 1234, title: ' Fix\nthe‮ list ' }),
			// 後ろに付いた `/files` や `#issuecomment-…` は落として同じ PR として残す
			paradisParseWorktreeOrigin({ kind: 'pr', url: 'https://github.com/acme/app/pull/77/files', number: 77 }),
			// 押すと外のブラウザで開くので、github.com の Issue・PR 以外は通さない
			paradisParseWorktreeOrigin({ kind: 'issue', url: 'https://example.com/acme/app/issues/1234', number: 1234 }),
			paradisParseWorktreeOrigin({ kind: 'issue', url: 'javascript:alert(1)' }),
			// 番号・種類が URL と食い違うもの
			paradisParseWorktreeOrigin({ kind: 'issue', url: ISSUE, number: 99 }),
			paradisParseWorktreeOrigin({ kind: 'pr', url: ISSUE, number: 1234 }),
			paradisParseWorktreeOrigin('https://github.com/acme/app/issues/1'),
			paradisParseWorktreeOrigin(undefined),
		], [
			{ kind: 'issue', url: ISSUE, number: 1234, title: 'Fix the list' },
			{ kind: 'pr', url: 'https://github.com/acme/app/pull/77', number: 77 },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('shows the origin unless the branch pull request chip already shows the same pull request, and does not count the origin issue twice', () => {
		const issue = { kind: 'issue' as const, url: ISSUE, number: 1234 };
		const pr = { kind: 'pr' as const, url: 'https://github.com/acme/app/pull/77', number: 77 };
		const detected = ['https://github.com/acme/app/issues/1234', 'https://github.com/acme/app/issues/1240'];
		assert.deepStrictEqual({
			issueWithPrChip: paradisWorktreeOriginToShow(issue, 77),
			samePr: paradisWorktreeOriginToShow(pr, 77),
			otherPr: paradisWorktreeOriginToShow(pr, 80),
			prWithoutChip: paradisWorktreeOriginToShow(pr, undefined),
			none: paradisWorktreeOriginToShow(undefined, 77),
			detected: paradisIssueUrlsWithoutOrigin(detected, issue),
			// 大文字小文字だけ違う URL も同じ Issue として除く
			caseInsensitive: paradisIssueUrlsWithoutOrigin(['https://github.com/ACME/App/issues/1234'], issue),
			noOrigin: paradisIssueUrlsWithoutOrigin(detected, undefined) === detected,
		}, {
			issueWithPrChip: issue,
			samePr: undefined,
			otherPr: pr,
			prWithoutChip: pr,
			none: undefined,
			detected: ['https://github.com/acme/app/issues/1240'],
			caseInsensitive: [],
			noOrigin: true,
		});
	});
});
