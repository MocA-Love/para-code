/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBlockTerminalInput, paradisIsTerminalInputBlocked, paradisResetTerminalInputGateForTest } from '../../browser/paradisTerminalInputGate.js';

/**
 * ここで検査するのは**ゲート本体の状態機械だけ**。
 *
 * 「キー入力は止まるが自動応答と `sendText` は通る」という肝心の性質は、呼び出し側
 * (`terminalInstance.ts` の `attachCustomKeyEventHandler`、`terminal.clipboard.contribution.ts` の
 * `_paste`) に置かれているため、ここからは検査できない。**以前ここに置いていた「呼び出し側を
 * 写した偽物」は、本番のガードを消しても通り続ける＝回帰検知になっていなかったので消した。**
 * 呼び出し位置を動かすときは `paradisTerminalInputGate.ts` の説明を必ず読むこと。
 */
suite('paradisTerminalInputGate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		// モジュールスコープの状態なので、落ちたテストの後始末をここで必ずやる
		paradisResetTerminalInputGateForTest();
	});

	test('blocks while held and opens again once released', () => {
		const before = paradisIsTerminalInputBlocked();
		const gate = paradisBlockTerminalInput();
		const during = paradisIsTerminalInputBlocked();
		gate.dispose();

		assert.deepStrictEqual(
			{ before, during, after: paradisIsTerminalInputBlocked() },
			{ before: false, during: true, after: false });
	});

	test('a superseded switch does not open the gate the next one is holding', () => {
		// Sequencer のスロットを時間で手放すと切り替えは並走しうる。このとき先行の後始末が
		// 現役のゲートを開けてしまうと、**この機能が防ぎたかった事故がそのまま起きる**。
		const first = paradisBlockTerminalInput();
		const second = paradisBlockTerminalInput();

		first.dispose();
		const afterStaleRelease = paradisIsTerminalInputBlocked();
		second.dispose();

		assert.deepStrictEqual(
			{ afterStaleRelease, afterCurrentRelease: paradisIsTerminalInputBlocked() },
			{ afterStaleRelease: true, afterCurrentRelease: false });
	});

	test('a superseded auto-release timer does not open the gate either', async () => {
		let staleAutoReleases = 0;
		// 先行世代は極端に短い締め切り、現役は長い締め切り。世代を見ていないと、先行の
		// タイマーが現役のゲートを落とす。
		paradisBlockTerminalInput({ timeoutMs: 1, onAutoRelease: () => staleAutoReleases++ });
		const current = paradisBlockTerminalInput({ timeoutMs: 10_000 });
		await timeout(20);

		assert.deepStrictEqual(
			{ staleAutoReleases, stillBlocked: paradisIsTerminalInputBlocked() },
			{ staleAutoReleases: 0, stillBlocked: true });
		current.dispose();
	});

	test('releases itself when nobody lowers the gate', async () => {
		let autoReleased = 0;

		// 切り替えが永久にハングした状況。**ここが降りないと全ウィンドウの全端末が入力不能**
		paradisBlockTerminalInput({ timeoutMs: 1, onAutoRelease: () => autoReleased++ });
		const blockedRightAway = paradisIsTerminalInputBlocked();
		await timeout(20);

		assert.deepStrictEqual(
			{ blockedRightAway, blockedNow: paradisIsTerminalInputBlocked(), autoReleased },
			{ blockedRightAway: true, blockedNow: false, autoReleased: 1 });
	});

	test('a normal release cancels the pending auto-release', async () => {
		let autoReleased = 0;

		paradisBlockTerminalInput({ timeoutMs: 1, onAutoRelease: () => autoReleased++ }).dispose();
		await timeout(20);

		// 発火させると「切り替えが終わらなかった」という嘘の警告がログに残る
		assert.deepStrictEqual(
			{ autoReleased, blocked: paradisIsTerminalInputBlocked() },
			{ autoReleased: 0, blocked: false });
	});
});
