/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBotSummary } from '../../common/paradisBotsApi.js';
import { EMPTY_PARADIS_BOT_ITEMS_STATE } from '../../common/paradisBotItems.js';
import { IParadisBot } from '../../common/paradisBots.js';
import { PARADIS_BOT_SETUP_STALL_MS, ParadisBotPanes } from '../../node/paradisBotPanes.js';

suite('Paradis bot panes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** 会話のペインを 1 つ結び付けた表と、その時刻の Bot の様子（帯に出す activity と halt）。 */
	function bound(agent: string): { panes: ParadisBotPanes; view: (now: number) => unknown } {
		const panes = new ParadisBotPanes();
		panes.issue('launch-1', 'b1', 'chat', 0, agent);
		assert.strictEqual(panes.report('launch-1', 'token-1', 0), 'b1');
		const bot = { id: 'b1', name: 'b', folder: 'b', agent, paused: false, pinned: false, faceColor: 'blue', faceShape: 'drop', createdAt: 0, updatedAt: 0 } as IParadisBot;
		return {
			panes,
			view: now => {
				const summary = paradisBotSummary(bot, EMPTY_PARADIS_BOT_ITEMS_STATE, panes.statesOf('b1', now), now);
				return [summary.activity, summary.halt];
			},
		};
	}

	test('エージェントのコマンドが見つからない・終わったときは「待機中」ではなく、その理由を出す。起動し直せば外れる', () => {
		const { panes, view } = bound('claude');
		const seen: unknown[] = [view(1)];
		panes.noteCommand('token-1', undefined, false, 1);
		panes.noteCommand('token-1', 127, true, 2);
		seen.push(view(2));
		panes.noteCommand('token-1', undefined, false, 3);
		panes.noteHook('token-1', 'SessionStart', 4);
		seen.push(view(4));
		panes.noteCommand('token-1', 1, true, 5);
		seen.push(view(5));
		panes.noteCommand('token-1', undefined, false, 6);
		panes.noteHook('token-1', 'SessionStart', 6);
		panes.noteHook('token-1', 'SessionEnd', 7);
		seen.push(view(7));
		panes.noteCommand('token-1', 0, true, 8);
		seen.push(view(8));
		assert.deepStrictEqual(seen, [
			['idle', undefined],
			['idle', { kind: 'notFound' }],
			['idle', undefined],
			['idle', { kind: 'exited', exitCode: 1 }],
			['idle', { kind: 'exited' }],
			['idle', { kind: 'exited', exitCode: 0 }],
		]);
	});

	test('起動しても hook が来ない Claude Code（初回設定・ログインの画面）は時間が過ぎたら「操作が要ります」。許可待ちも同じ。普通に起動した会話と Codex は待機中のまま', () => {
		const stalled = bound('claude');
		const started = bound('claude');
		started.panes.noteHook('token-1', 'SessionStart', 1_000);
		const codex = bound('codex');
		const asking = bound('claude');
		asking.panes.noteHook('token-1', 'PermissionRequest', 1_000);
		const answered = bound('claude');
		answered.panes.noteHook('token-1', 'PermissionRequest', 1_000);
		answered.panes.noteHook('token-1', 'PreToolUse', 2_000);
		const after = PARADIS_BOT_SETUP_STALL_MS + 1;
		assert.deepStrictEqual([
			stalled.view(PARADIS_BOT_SETUP_STALL_MS - 1),
			stalled.view(after),
			started.view(after),
			codex.view(after),
			asking.view(after),
			answered.view(after),
		], [
			['idle', undefined],
			['idle', { kind: 'needsUser' }],
			['idle', undefined],
			['idle', undefined],
			['idle', { kind: 'needsUser' }],
			['working', undefined],
		]);
	});
});
