/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisApprovalSettlePane, IParadisApprovalSettleTargets, ParadisApprovalScreenSettle, paradisNotifyApprovalSettlement, paradisScreenShowsAgentWorking } from '../../browser/paradisApprovalScreenSettle.js';
import { CODEX_EXEC_APPROVAL_DETAIL, CODEX_EXEC_APPROVAL_SCREEN, CODEX_MCP_APPROVAL_DETAIL, CODEX_MCP_APPROVAL_SCREEN, CODEX_WORKING_SCREEN } from './paradisCodexPromptScreens.js';

suite('ParadisApprovalScreenSettle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const exec = { id: 'call_exec', detail: CODEX_EXEC_APPROVAL_DETAIL };
	const tool = { id: 'call_tool', detail: CODEX_MCP_APPROVAL_DETAIL };

	test('tells working screens apart from permission prompts and idle composers', () => {
		const codexQuestion = ['Question 1/1 (1 unanswered)', 'Which one?', '› 1. A', '  2. B', 'tab to add notes | enter to submit answer | esc to interrupt'].join('\n');
		assert.deepStrictEqual(
			[CODEX_WORKING_SCREEN, CODEX_EXEC_APPROVAL_SCREEN, CODEX_MCP_APPROVAL_SCREEN, codexQuestion, '› Ask Codex to do anything'].map(paradisScreenShowsAgentWorking),
			[true, false, false, false, false],
		);
	});

	test('settles a pane once after the prompt is gone and the agent works on two checks in a row, with the approvals seen on screen', () => {
		let now = 10_000;
		const settle = new ParadisApprovalScreenSettle(() => now);
		const since = now;
		const tick = (screen: string | undefined, approval?: IParadisApprovalSettlePane['approval']) => {
			now += 2_000;
			return settle.update([{ token: 'a', since, screen, ...(approval !== undefined ? { approval } : {}) }]);
		};
		const results = [
			// 許可待ちになった直後は、まだ確認が描かれていないだけかもしれない（見えた承認は覚える）
			settle.update([{ token: 'a', since, screen: CODEX_EXEC_APPROVAL_SCREEN, approval: exec }]),
			tick(CODEX_WORKING_SCREEN, exec),
			// 間に確認がまた出たら数え直す
			tick(CODEX_EXEC_APPROVAL_SCREEN, exec),
			tick(CODEX_WORKING_SCREEN, exec),
			tick(undefined, exec),
			tick(CODEX_WORKING_SCREEN, exec),
			tick(CODEX_WORKING_SCREEN, exec),
			// 同じ許可待ちは 2 度返さない
			tick(CODEX_WORKING_SCREEN, exec),
		];
		assert.deepStrictEqual(results, [[], [], [], [], [], [], [{ token: 'a', since, interactionIds: ['call_exec'] }], []]);
	});

	test('does not settle while the pending approval at the front has not been seen on screen, and restarts when the wait is renewed', () => {
		let now = 10_000;
		const settle = new ParadisApprovalScreenSettle(() => now);
		const at = (since: number, screen: string, approval: IParadisApprovalSettlePane['approval']) => {
			now += 2_000;
			return settle.update([{ token: 'a', since, screen, approval }]);
		};
		const results = [
			at(10_000, CODEX_EXEC_APPROVAL_SCREEN, exec),
			// コマンドの許可にキーで答えた直後に、次のツールの許可要求が届いた。許可要求で許可待ちが付け直され（changedAt が
			// 変わる）、中継の表は次の承認になる。次の承認の確認の描画が遅れて、作業中の画面が続いても解かない
			// （解くとペインが作業中へ戻り、hook はもう来ないので許可待ちを見逃す）
			at(13_000, CODEX_WORKING_SCREEN, tool),
			at(13_000, CODEX_WORKING_SCREEN, tool),
			at(13_000, CODEX_WORKING_SCREEN, tool),
			at(13_000, CODEX_WORKING_SCREEN, tool),
			// 画面の確認が表の承認と別物（MCP の確認に、コマンドの承認の中身は見えない）なら、見たことにしない
			at(13_000, CODEX_MCP_APPROVAL_SCREEN, exec),
			// 表の承認の確認が描かれた。答えて消えたら、前に見た承認とまとめて解く
			at(13_000, CODEX_MCP_APPROVAL_SCREEN, tool),
			at(13_000, CODEX_WORKING_SCREEN, tool),
			at(13_000, CODEX_WORKING_SCREEN, tool),
		];
		assert.deepStrictEqual(results, [
			[], [], [], [], [], [], [], [],
			[{ token: 'a', since: 13_000, interactionIds: ['call_exec', 'call_tool'] }],
		]);
	});

	test('moves the pane back only after the approvals are marked and none is left waiting, and not when the relay cannot say', async () => {
		const calls: string[] = [];
		const targets = (reply: boolean | Error): IParadisApprovalSettleTargets => ({
			settleApprovals: async (token, ids) => {
				calls.push(`approvals:${token}:${ids.join(',')}`);
				if (reply instanceof Error) {
					throw reply;
				}
				return reply;
			},
			settlePane: async (token, since) => { calls.push(`pane:${token}:${since}`); },
			onError: (what, error) => calls.push(`error:${what}:${(error as Error).message}`),
		});
		await paradisNotifyApprovalSettlement({ token: 'a', since: 1, interactionIds: ['call_1'] }, targets(false));
		// 見た承認に印を付けても、まだ答えていない承認（続けて届き、描かれていない次の承認）が残っている
		await paradisNotifyApprovalSettlement({ token: 'b', since: 2, interactionIds: ['call_2'] }, targets(true));
		// 中継へ伝えられない。残りが分からないので戻さない
		await paradisNotifyApprovalSettlement({ token: 'c', since: 3, interactionIds: ['call_3'] }, targets(new Error('relay down')));
		// 画面で見た承認が無くても、残りがあるかは中継に確かめる
		await paradisNotifyApprovalSettlement({ token: 'd', since: 4, interactionIds: [] }, targets(false));
		assert.deepStrictEqual(calls, [
			'approvals:a:call_1', 'pane:a:1',
			'approvals:b:call_2',
			'approvals:c:call_3', 'error:approvals:relay down',
			'approvals:d:', 'pane:d:4',
		]);
	});
});
