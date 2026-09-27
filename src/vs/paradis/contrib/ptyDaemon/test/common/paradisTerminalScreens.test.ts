/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisDecideSavedScreens,
	paradisDecodeTerminalScreens,
	paradisEncodeTerminalScreens,
	PARADIS_TERMINAL_SCREENS_MAX_AGE,
} from '../../common/paradisTerminalScreens.js';

suite('ParadisTerminalScreens', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips the saved screens and rejects broken files', () => {
		assert.deepStrictEqual({
			ok: paradisDecodeTerminalScreens(paradisEncodeTerminalScreens(1000, '{"version":1,"state":[]}')),
			broken: paradisDecodeTerminalScreens('{not json'),
			empty: paradisDecodeTerminalScreens(paradisEncodeTerminalScreens(1000, '')),
			otherVersion: paradisDecodeTerminalScreens(JSON.stringify({ version: 2, savedAt: 1, state: 'x' })),
		}, {
			ok: { version: 1, savedAt: 1000, state: '{"version":1,"state":[]}' },
			broken: undefined,
			empty: undefined,
			otherVersion: undefined,
		});
	});

	test('revives only when the daemon that held the screens is gone', () => {
		const savedAt = 10_000;
		const saved = { version: 1 as const, savedAt, state: 'x' };
		assert.deepStrictEqual([
			// PC を再起動した: 常駐は保存より後に起きている
			paradisDecideSavedScreens(saved, savedAt + 1000, { running: true, startedAt: savedAt + 500 }),
			// アプリだけ閉じて開き直した: 保存したときと同じ常駐がまだ抱えている
			paradisDecideSavedScreens(saved, savedAt + 1000, { running: true, startedAt: savedAt - 500 }),
			// 常駐へ繋がれなかった（アプリの中の pty ホストに落ちた）: 引き取れる相手が居ない
			paradisDecideSavedScreens(saved, savedAt + 1000, { running: false, startedAt: undefined }),
			// 状態が分からない: 二重に起こさない
			paradisDecideSavedScreens(saved, savedAt + 1000, undefined),
			paradisDecideSavedScreens(saved, savedAt + 1000, { running: true, startedAt: undefined }),
			// 30日を過ぎた
			paradisDecideSavedScreens(saved, savedAt + PARADIS_TERMINAL_SCREENS_MAX_AGE + 1, { running: true, startedAt: savedAt + 500 }),
		], ['revive', 'daemonStillHolds', 'revive', 'unknown', 'unknown', 'expired']);
	});
});
