/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisRemoteTerminalShutdownInput, paradisParseKeepRemoteTerminalsChoice, paradisPlanRemoteTerminalShutdown } from '../../common/paradisRemoteTerminalShutdown.js';
import { PARADIS_TERMINAL_RECONNECTION_GRACE_TIME, paradisTerminalReconnectionGraceTime } from '../../common/paradisTerminalGraceTime.js';

suite('ParadisRemoteTerminalShutdown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function plan(overrides: Partial<IParadisRemoteTerminalShutdownInput> = {}): string {
		return paradisPlanRemoteTerminalShutdown({
			hasRemoteAuthority: true,
			isReload: false,
			isQuit: false,
			choice: 'ask',
			persistentTerminalCount: 1,
			...overrides,
		});
	}

	// ローカルのウィンドウの挙動は一切変えない。ここが崩れると、閉じたのに手元のターミナルが
	// 残り続ける（次に開いても繋ぎ直す相手が居ないので、ただ残骸になる）。
	test('never touches a window that is not connected to a remote', () => {
		assert.deepStrictEqual([
			plan({ hasRemoteAuthority: false }),
			plan({ hasRemoteAuthority: false, choice: 'always' }),
		], ['end', 'end']);
	});

	test('leaves reloads alone, since those already keep the processes', () => {
		assert.deepStrictEqual([
			plan({ isReload: true }),
			plan({ isReload: true, choice: 'always' }),
		], ['end', 'end']);
	});

	test('does not ask when there is nothing to leave running', () => {
		assert.deepStrictEqual([
			plan({ persistentTerminalCount: 0 }),
			plan({ persistentTerminalCount: 0, choice: 'always' }),
		], ['end', 'end']);
	});

	test('follows a remembered choice and otherwise asks', () => {
		assert.deepStrictEqual([
			plan({ choice: 'always' }),
			plan({ choice: 'never' }),
			plan({ choice: 'ask' }),
		], ['keep', 'end', 'ask']);
	});

	// アプリごと終了するときは尋ねない。開いている接続先ウィンドウの数だけダイアログが並び、
	// 背面のウィンドウのものは見えないまま終了できなくなる。
	test('does not ask while the whole app is quitting', () => {
		assert.deepStrictEqual([
			plan({ isQuit: true }),
			plan({ isQuit: true, choice: 'never' }),
			plan({ isQuit: true, choice: 'always' }),
		], ['keep', 'end', 'keep']);
	});

	// 接続の猶予（拡張ホストを抱える）とターミナルの猶予（実行中の作業を抱える）は重さが違う。
	// 前者が切れて失うのは繋ぎ直しの速さだけだが、後者が切れると作業ごと消える。
	test('waits longer for terminals than for the connection, unless a grace time was asked for', () => {
		const threeHours = 3 * 60 * 60 * 1000;
		const oneWeek = 7 * 24 * 60 * 60 * 1000;
		assert.deepStrictEqual([
			// 既定のまま: ターミナルだけ伸ばす。
			paradisTerminalReconnectionGraceTime(undefined, threeHours),
			paradisTerminalReconnectionGraceTime('', threeHours),
			// 明示指定は素通し（0 = 残さない、も意図的な指定として尊重する）。
			paradisTerminalReconnectionGraceTime('60', 60_000),
			paradisTerminalReconnectionGraceTime('0', 0),
			// 接続側の方が長い構成では、短くしない。
			paradisTerminalReconnectionGraceTime(undefined, oneWeek),
			// 解釈できない指定は `parseGraceTime` が既定へ落とすので、こちらも明示扱いにしない
			// （片方だけが明示だと見ると、伸ばすべき場面で伸ばさなくなる）。
			paradisTerminalReconnectionGraceTime('later', threeHours),
			paradisTerminalReconnectionGraceTime('-1', threeHours),
			paradisTerminalReconnectionGraceTime(String(Number.MAX_SAFE_INTEGER), threeHours),
		], [
			PARADIS_TERMINAL_RECONNECTION_GRACE_TIME,
			PARADIS_TERMINAL_RECONNECTION_GRACE_TIME,
			60_000,
			0,
			oneWeek,
			PARADIS_TERMINAL_RECONNECTION_GRACE_TIME,
			PARADIS_TERMINAL_RECONNECTION_GRACE_TIME,
			PARADIS_TERMINAL_RECONNECTION_GRACE_TIME,
		]);
	});

	// 設定が壊れていても閉じられなくなってはいけない。読めない値は「毎回尋ねる」に倒す。
	test('reads an unusable setting as asking every time', () => {
		assert.deepStrictEqual([
			paradisParseKeepRemoteTerminalsChoice(undefined),
			paradisParseKeepRemoteTerminalsChoice('yes'),
			paradisParseKeepRemoteTerminalsChoice(true),
			paradisParseKeepRemoteTerminalsChoice('always'),
			paradisParseKeepRemoteTerminalsChoice('never'),
		], ['ask', 'ask', 'ask', 'always', 'never']);
	});
});
