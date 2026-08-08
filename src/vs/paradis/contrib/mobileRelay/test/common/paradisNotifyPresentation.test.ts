/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentLabel, paradisNotifySubtitleCandidate, paradisNotifyTitle } from '../../common/paradisNotifyPresentation.js';

/**
 * 通知の見出しの組み立てを固定するテスト。ロック画面で太字になるのは title だけなので、
 * 「ワークツリー名がそこへ入る」「入らないときも読める文字列になる」の2点が本質。
 */
suite('paradisNotifyTitle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('スペース名を使い、旧アプリ互換の worktree 印は外す', () => {
		assert.deepStrictEqual(
			// allow-any-unicode-next-line
			[paradisNotifyTitle('✦ paracode-103', 'Claude Code'), paradisNotifyTitle('para-code', 'Claude Code')],
			['paracode-103', 'para-code'],
		);
	});

	test('スペース名が無ければターミナル名、それも無ければ製品名へ落ちる', () => {
		assert.deepStrictEqual(
			[paradisNotifyTitle(undefined, 'Claude Code'), paradisNotifyTitle('   ', '  '), paradisNotifyTitle(undefined)],
			['Claude Code', 'Para Code', 'Para Code'],
		);
	});
});

suite('paradisNotifySubtitleCandidate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('タイトルと同じ文字列は出さない（同じ名前が2行並ぶため）', () => {
		assert.deepStrictEqual(
			[
				paradisNotifySubtitleCandidate('Claude Code', 'paracode-103'),
				paradisNotifySubtitleCandidate('Claude Code', 'Claude Code'),
				paradisNotifySubtitleCandidate('  ', 'paracode-103'),
				paradisNotifySubtitleCandidate(undefined, 'paracode-103'),
			],
			['Claude Code', undefined, undefined, undefined],
		);
	});
});

suite('paradisAgentLabel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('エージェントの呼び名', () => {
		assert.deepStrictEqual([paradisAgentLabel('claude'), paradisAgentLabel('codex')], ['Claude', 'Codex']);
	});
});
