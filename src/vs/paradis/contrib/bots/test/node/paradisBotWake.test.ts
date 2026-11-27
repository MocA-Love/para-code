/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisHumanAskLedger } from '../../../humanAsk/common/paradisHumanAskLedger.js';
import { ParadisHumanAskService } from '../../../humanAsk/node/paradisHumanAskChannel.js';
import { EMPTY_PARADIS_BOT_ITEMS_STATE, IParadisBotItemsState } from '../../common/paradisBotItems.js';
import { EMPTY_PARADIS_BOTS_STATE, IParadisBotsState } from '../../common/paradisBots.js';
import { paradisBotStatusLine } from '../../common/paradisBotsBandModel.js';
import { IParadisBotStopRequest } from '../../common/paradisBotsApi.js';
import { paradisBotResumeArgs } from '../../common/paradisBotTools.js';
import { ParadisBotHomes } from '../../node/paradisBotHomes.js';
import { EMPTY_PARADIS_BOT_PANES_STATE, IParadisBotPanesState, PARADIS_BOT_IDLE_STOP_MS, paradisBotPaneTokenHash, paradisParseBotPanesState, ParadisBotPanes } from '../../node/paradisBotPanes.js';
import { ParadisBotsService } from '../../node/paradisBotsService.js';
import { IParadisBotsJsonFile } from '../../node/paradisBotsStore.js';

class MemoryFile<T> implements IParadisBotsJsonFile<T> {
	constructor(public state: T) { }
	async read() {
		return { state: this.state };
	}
	async write(state: T) {
		this.state = state;
	}
}

const SESSION = '0193a3c2-7b4e-7f00-9c1d-2f5a8e6b1c3d';

suite('Paradis bot wake and sleep', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('会話の id は最初の hook（か SessionStart）のものを持ち、1 ターン動いたら眠った会話として控える。子エージェントの id では上書きしない', () => {
		const panes = new ParadisBotPanes();
		panes.issue('l1', 'b1', 'chat', 0, 'codex');
		panes.report('l1', 'token-1', 0);
		panes.noteHook('token-1', 'SessionStart', 1, SESSION);
		const beforeTurn = panes.chatSessionOf('b1');
		panes.noteHook('token-1', 'UserPromptSubmit', 2, SESSION);
		panes.noteHook('token-1', 'UserPromptSubmit', 3, 'child-session-1');
		const afterTurn = panes.chatSessionOf('b1');
		// 見回りのペインの会話は控えない
		panes.issue('l2', 'b1', 'patrol', 4, 'codex');
		panes.report('l2', 'token-2', 4);
		panes.noteHook('token-2', 'SessionStart', 5, 'patrol-session');
		panes.noteHook('token-2', 'UserPromptSubmit', 6, 'patrol-session');
		// ペインを閉じても会話は残る（止めた・30 分で止めた後も続けられる）
		panes.release('token-1');
		panes.releaseBot('b1');
		assert.deepStrictEqual({ beforeTurn, afterTurn, afterRelease: panes.chatSessionOf('b1') }, {
			beforeTurn: undefined,
			afterTurn: { botId: 'b1', agent: 'codex', sessionId: SESSION, at: 2 },
			afterRelease: { botId: 'b1', agent: 'codex', sessionId: SESSION, at: 2 },
		});
	});

	test('続けて起こした会話が動く前に終わったら（会話が消えていた）、眠った会話を忘れて次は新しい会話にする', () => {
		const panes = new ParadisBotPanes();
		panes.loadSessions([{ botId: 'b1', agent: 'claude', sessionId: SESSION, at: 0 }]);
		panes.issue('l1', 'b1', 'chat', 1, 'claude', true);
		panes.report('l1', 'token-1', 1);
		panes.noteCommand('token-1', undefined, false, 2);
		panes.noteCommand('token-1', 1, true, 3);
		assert.strictEqual(panes.chatSessionOf('b1'), undefined);
	});

	test('何もしないまま 30 分たった会話のペインだけを止める候補にする（動いている・答えを待っている・見回りは除く）', () => {
		const panes = new ParadisBotPanes();
		const bind = (launchId: string, botId: string, token: string, purpose: 'chat' | 'patrol') => {
			panes.issue(launchId, botId, purpose, 0, 'claude');
			panes.report(launchId, token, 0);
		};
		bind('l1', 'idle', 'idle-token', 'chat');
		bind('l2', 'working', 'working-token', 'chat');
		bind('l3', 'asking', 'asking-token', 'chat');
		bind('l4', 'patrol', 'patrol-token', 'patrol');
		bind('l5', 'recent', 'recent-token', 'chat');
		panes.noteHook('working-token', 'UserPromptSubmit', 10);
		panes.noteHook('asking-token', 'PermissionRequest', 10);
		panes.noteHook('recent-token', 'Stop', PARADIS_BOT_IDLE_STOP_MS);
		assert.deepStrictEqual(panes.idleChatTokens(PARADIS_BOT_IDLE_STOP_MS + 10), [{ botId: 'idle', token: 'idle-token' }]);
	});

	test('保存した眠った会話を読み直せる。形の違う id は捨てる', () => {
		assert.deepStrictEqual(paradisParseBotPanesState({
			version: 1, panes: [], sessions: [
				{ botId: 'b1', agent: 'claude', sessionId: SESSION, at: 5 },
				{ botId: 'b2', agent: 'claude', sessionId: '$(rm -rf ~)', at: 5 },
			],
		})?.sessions, [{ botId: 'b1', agent: 'claude', sessionId: SESSION, at: 5 }]);
	});

	test('続ける引数: Claude Code は --resume、Codex は resume サブコマンド。ほかのエージェントとシェルの文字を含む id は続けない', () => {
		assert.deepStrictEqual([
			paradisBotResumeArgs('claude', SESSION),
			paradisBotResumeArgs('codex', SESSION),
			paradisBotResumeArgs('opencode', SESSION),
			paradisBotResumeArgs('claude', 'a;b'),
		], [`--resume ${SESSION}`, `resume ${SESSION}`, undefined, undefined]);
	});

	test('再起動の後は眠った会話として並び、話しかけて起こすと同じ会話を続ける。30 分何もしなければ止める依頼を出す。エージェントを変えたら忘れる', async () => {
		const disposables = store.add(new DisposableStore());
		const clock = { now: 1_000 };
		const botsFile = new MemoryFile<IParadisBotsState>(EMPTY_PARADIS_BOTS_STATE);
		const itemsFile = new MemoryFile<IParadisBotItemsState>(EMPTY_PARADIS_BOT_ITEMS_STATE);
		const panesFile = new MemoryFile<IParadisBotPanesState>(EMPTY_PARADIS_BOT_PANES_STATE);
		const homes = { ensure: async () => '/tmp/bot-home', read: async () => undefined, existingFolders: async () => [] } as unknown as ParadisBotHomes;
		const start = () => {
			const hooks = disposables.add(new Emitter<{ token: string; event: string; sessionId?: string }>());
			const humanAsk = disposables.add(new ParadisHumanAskService(new ParadisHumanAskLedger(() => clock.now)));
			const service = disposables.add(new ParadisBotsService(botsFile, itemsFile, humanAsk, new NullLogService(), { now: () => clock.now, hookEvents: hooks.event, panesFile, homes }));
			return { service, hooks };
		};
		const first = start();
		await first.service.ready;
		const created = await first.service.createBot({ name: 'A', agent: 'claude' });
		assert.ok(created.ok, created.ok ? '' : created.message);
		const botId = created.value.id;
		const fresh = await first.service.requestLaunch(botId, 'chat');
		assert.ok(fresh.ok);
		first.service.reportLaunch(fresh.value.launchId, 'pane-1');
		first.hooks.fire({ token: 'pane-1', event: 'SessionStart', sessionId: SESSION });
		first.hooks.fire({ token: 'pane-1', event: 'UserPromptSubmit', sessionId: SESSION });
		first.hooks.fire({ token: 'pane-1', event: 'Stop', sessionId: SESSION });
		// 30 分たつ前は止めない。たったら会話のペインだけ止める依頼を出す（閉じたことが届くまで出し直さない）
		const stops: IParadisBotStopRequest[] = [];
		disposables.add(first.service.onDidRequestStop(request => stops.push(request)));
		clock.now += PARADIS_BOT_IDLE_STOP_MS - 1;
		first.service.stopIdleChats();
		const before = stops.length;
		clock.now += 1;
		first.service.stopIdleChats();
		first.service.stopIdleChats();
		first.hooks.fire({ token: 'pane-1', event: 'TerminalExit' });
		const afterStop = paradisBotStatusLine(first.service.getSnapshot().bots[0]);

		// 起動し直した（新しいサービスが保存から読む）
		const second = start();
		await second.service.ready;
		const summary = second.service.getSnapshot().bots[0];
		const resumed = await second.service.requestLaunch(botId, 'chat');
		assert.ok(resumed.ok);
		second.service.cancelLaunch(resumed.value.launchId);
		await second.service.updateBot(botId, { agent: 'codex' });
		const afterAgentChange = await second.service.requestLaunch(botId, 'chat');
		assert.ok(afterAgentChange.ok);

		assert.deepStrictEqual({
			freshFlags: fresh.value.extraFlags,
			stopsBefore: before,
			stops,
			afterStop,
			sleeping: [summary.activity, summary.sleeping, paradisBotStatusLine(summary)],
			resumed: [resumed.value.extraFlags, resumed.value.resumed],
			afterAgentChange: [afterAgentChange.value.resumed, second.service.getSnapshot().bots[0].sleeping],
		}, {
			freshFlags: undefined,
			stopsBefore: 0,
			stops: [{ botId, paneHashes: [paradisBotPaneTokenHash('pane-1')] }],
			afterStop: '眠っています',
			sleeping: ['stopped', true, '眠っています'],
			resumed: [`--resume ${SESSION}`, true],
			afterAgentChange: [undefined, undefined],
		});
	});
});
