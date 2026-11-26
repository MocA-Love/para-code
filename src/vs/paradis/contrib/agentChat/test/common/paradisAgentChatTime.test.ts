/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentChatTimeLabel, paradisAgentChatUsageCacheDetail, paradisAgentChatUsageLabel } from '../../common/paradisAgentChatTime.js';

suite('paradisAgentChatTimeLabel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows the time for today, the day for earlier days and the year for earlier years', () => {
		const now = new Date(2026, 10, 27, 15, 0).getTime();
		assert.deepStrictEqual([
			paradisAgentChatTimeLabel(new Date(2026, 10, 27, 9, 5).getTime(), now),
			paradisAgentChatTimeLabel(new Date(2026, 10, 26, 23, 21).getTime(), now),
			paradisAgentChatTimeLabel(new Date(2025, 11, 31, 0, 0).getTime(), now),
		], ['9:05', '11/26 23:21', '2025/12/31 0:00']);
	});

	test('writes the usage line with the cache apart from the input, grouped digits, the model when known, and the cache detail', () => {
		const usage = { model: 'claude-opus-4-5', inputTokens: 2, cacheReadTokens: 143_745, cacheCreationTokens: 2_610, outputTokens: 581 };
		assert.deepStrictEqual([
			paradisAgentChatUsageLabel(usage),
			paradisAgentChatUsageLabel({ inputTokens: 1_234_567, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 }),
			paradisAgentChatUsageCacheDetail(usage),
		], ['claude-opus-4-5 / 入力 2 · キャッシュ 146,355 · 出力 581', '入力 1,234,567 · キャッシュ 0 · 出力 0', 'キャッシュから読んだ入力 143,745\nキャッシュへ書いた入力 2,610']);
	});
});
