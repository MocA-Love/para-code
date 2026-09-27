/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisDaemonStatusLike,
	paradisDaemonIdentityForSaving,
	paradisDecideSavedScreens,
	paradisDecodeTerminalScreens,
	paradisEncodeTerminalScreens,
	PARADIS_TERMINAL_SCREENS_MAX_AGE,
} from '../../common/paradisTerminalScreens.js';

suite('ParadisTerminalScreens', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const daemon = { pid: 100, startedAt: 5_000 };

	test('round-trips the saved screens and rejects broken files', () => {
		assert.deepStrictEqual({
			ok: paradisDecodeTerminalScreens(paradisEncodeTerminalScreens(1000, daemon, '{"version":1,"state":[]}')),
			broken: paradisDecodeTerminalScreens('{not json'),
			empty: paradisDecodeTerminalScreens(paradisEncodeTerminalScreens(1000, daemon, '')),
			// 保存時の常駐を持たない古い形は使わない
			oldVersion: paradisDecodeTerminalScreens(JSON.stringify({ version: 1, savedAt: 1, state: 'x' })),
		}, {
			ok: { version: 2, savedAt: 1000, daemon, state: '{"version":1,"state":[]}' },
			broken: undefined,
			empty: undefined,
			oldVersion: undefined,
		});
	});

	test('saves only while the daemon holds the terminals', () => {
		assert.deepStrictEqual([
			paradisDaemonIdentityForSaving({ running: true, pid: 1, startedAt: 2, foreign: [], terminalCount: 3 }, 3),
			// 常駐は生きているが、保存する本数を抱えていない（pty ホストがアプリの中に落ちている）
			paradisDaemonIdentityForSaving({ running: true, pid: 1, startedAt: 2, foreign: [], terminalCount: 0 }, 3),
			// 本数を聞けなかった
			paradisDaemonIdentityForSaving({ running: true, pid: 1, startedAt: 2, foreign: [] }, 1),
			paradisDaemonIdentityForSaving({ running: false, pid: undefined, startedAt: undefined, foreign: [], terminalCount: 3 }, 1),
			paradisDaemonIdentityForSaving(undefined, 0),
		], [{ pid: 1, startedAt: 2 }, undefined, undefined, undefined, undefined]);
	});

	test('revives only when the daemon that held the screens is gone everywhere', () => {
		const savedAt = 10_000;
		const saved = { version: 2 as const, savedAt, daemon, state: 'x' };
		const status = (overrides: Partial<IParadisDaemonStatusLike>): IParadisDaemonStatusLike => ({ running: true, pid: 200, startedAt: savedAt + 500, foreign: [], ...overrides });
		assert.deepStrictEqual([
			// PC を再起動した: 別の常駐に繋がっていて、元の常駐はどこにも居ない
			paradisDecideSavedScreens(saved, savedAt + 1000, status({})),
			// アプリだけ閉じて開き直した: 同じ常駐がまだ抱えている
			paradisDecideSavedScreens(saved, savedAt + 1000, status({ pid: daemon.pid, startedAt: daemon.startedAt })),
			// 更新した: 新しいビルドの常駐に繋がったが、更新前の常駐が元の端末を抱えたまま残っている
			paradisDecideSavedScreens(saved, savedAt + 1000, status({ foreign: [{ pid: daemon.pid, startedAt: daemon.startedAt }] })),
			// pid が再利用されていても、起動時刻が違えば別の常駐
			paradisDecideSavedScreens(saved, savedAt + 1000, status({ pid: daemon.pid, startedAt: savedAt + 500 })),
			// 常駐が動いていない・アプリは保存より前から動いている（再読み込み。アプリの中の pty ホストに生きているシェルがある）
			paradisDecideSavedScreens(saved, savedAt + 1000, status({ running: false, pid: undefined, startedAt: undefined }), savedAt - 1),
			// 状態が分からない
			paradisDecideSavedScreens(saved, savedAt + 1000, undefined),
			// PC を再起動した直後で常駐の起動がまだ: アプリが保存より後に起動していれば戻す
			paradisDecideSavedScreens(saved, savedAt + 1000, status({ running: false, pid: undefined, startedAt: undefined }), savedAt + 1),
			paradisDecideSavedScreens(saved, savedAt + 1000, undefined, savedAt + 1),
			// ただし更新前の常駐が元の端末を抱えて生きていれば戻さない
			paradisDecideSavedScreens(saved, savedAt + 1000, status({ running: false, pid: undefined, startedAt: undefined, foreign: [daemon] }), savedAt + 1),
			// 30日を過ぎた
			paradisDecideSavedScreens(saved, savedAt + PARADIS_TERMINAL_SCREENS_MAX_AGE + 1, status({})),
		], ['revive', 'daemonStillHolds', 'daemonStillHolds', 'revive', 'unknown', 'unknown', 'revive', 'revive', 'daemonStillHolds', 'expired']);
	});
});
