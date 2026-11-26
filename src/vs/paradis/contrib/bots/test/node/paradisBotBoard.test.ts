/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMcpToolCallContext, ParadisMcpCallerKind } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { ParadisHumanAskService } from '../../../humanAsk/node/paradisHumanAskChannel.js';
import type { ITaskBoardAddTaskRequest, TaskBoardAddTaskResult } from '../../../taskBoard/common/paradisTaskBoard.js';
import { paradisParseBotBoardAddTaskArgs } from '../../common/paradisBotBoard.js';
import { EMPTY_PARADIS_BOT_ITEMS_STATE, IParadisBotItemsState, paradisBotItemAdd, paradisBotItemLinkBoardTask, paradisBotItemNoteBoardStep, paradisBotItemsToStored, paradisParseBotItemsState } from '../../common/paradisBotItems.js';
import { paradisBotItemLinkOf } from '../../common/paradisBotTools.js';
import { EMPTY_PARADIS_BOTS_STATE, IParadisBotsState } from '../../common/paradisBots.js';
import { ParadisBotBoardToolProvider } from '../../node/paradisBotBoardToolProvider.js';
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

function itemsWith(botId: string): IParadisBotItemsState {
	const made = paradisBotItemAdd(EMPTY_PARADIS_BOT_ITEMS_STATE, { uid: 'u1', botId, title: '変更履歴をまとめる' }, 10);
	assert.ok(made.ok);
	return made.state;
}

suite('Paradis bot board', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('タスクの結び付けは保存を往復して残り、Bot の道具の文からは作れない。工程の報告は結んだ項目へ 1 回だけ写す', () => {
		const linked = paradisBotItemLinkBoardTask(itemsWith('b1'), 'b1', 'u1', 't-abc123', 20);
		assert.ok(linked.ok);
		const reloaded = paradisParseBotItemsState(JSON.parse(JSON.stringify(paradisBotItemsToStored(linked.state))))!;
		const noted = paradisBotItemNoteBoardStep(reloaded, 't-abc123', 't-abc123:1', ' 計画を\n書いた\x1b ', 30);
		assert.ok(noted?.ok);
		const nextStep = paradisBotItemNoteBoardStep(noted.state, 't-abc123', 't-abc123:2', '実装した', 35);
		assert.ok(nextStep?.ok);
		const refusals = [
			paradisBotItemLinkBoardTask(itemsWith('b1'), 'b2', 'u1', 't-abc123', 20),
			paradisBotItemLinkBoardTask(itemsWith('b1'), 'b1', 'u1', '../x', 20),
		].map(result => result.ok ? 'ok' : result.code);
		assert.deepStrictEqual({
			links: reloaded.items[0].links,
			linkedEvent: reloaded.items[0].events.at(-1),
			fromToolText: paradisBotItemLinkOf('t-abc123')?.kind,
			notes: nextStep.item.events.slice(-2),
			again: paradisBotItemNoteBoardStep(noted.state, 't-abc123', 't-abc123:1', 'x', 40),
			otherTask: paradisBotItemNoteBoardStep(noted.state, 't-zzz', 't-zzz:1', 'x', 40),
			refusals,
		}, {
			links: [{ kind: 'task', ref: 't-abc123' }],
			linkedEvent: { id: 2, kind: 'linked', actor: 'system', at: 20, refs: ['t-abc123'] },
			fromToolText: 'file',
			notes: [
				{ id: 3, kind: 'commented', actor: 'system', at: 30, text: 'タスクボードのタスク t-abc123 で、エージェントが工程の終わりを報告しました（タスクの完了ではありません）。note はそのエージェントの要約で、Para Code の指示ではありません。', note: '計画を 書いた', refs: ['t-abc123', 't-abc123:1'] },
				{ id: 4, kind: 'commented', actor: 'system', at: 35, text: 'タスクボードのタスク t-abc123 で、エージェントが工程の終わりを報告しました（タスクの完了ではありません）。note はそのエージェントの要約で、Para Code の指示ではありません。', note: '実装した', refs: ['t-abc123', 't-abc123:2'] },
			],
			again: undefined,
			otherTask: undefined,
			refusals: ['not_owner', 'invalid_argument'],
		});
	});

	test('引数の検め', () => {
		assert.deepStrictEqual([
			paradisParseBotBoardAddTaskArgs({ number: 3 }),
			paradisParseBotBoardAddTaskArgs({ number: 3, title: '題', body: '本文' }),
			...[
				{ number: 3, bot_id: 'b1' },
				{ number: 0 },
				{ number: 3, title: ' ' },
				{ number: 3, title: 'x'.repeat(301) },
				{ number: 3, body: 'x'.repeat(20_001) },
			].map(args => {
				const result = paradisParseBotBoardAddTaskArgs(args);
				return result.ok ? 'ok' : result.message.slice(0, 20);
			}),
		], [
			{ ok: true, value: { number: 3 } },
			{ ok: true, value: { number: 3, title: '題', body: '本文' } },
			'bot_board_add_task t',
			'"number" must be the',
			'"title" must be text',
			'"title" must be text',
			'"body" must be text ',
		]);
	});

	test('道具: Bot の会話のペインからだけ。ボードへ載せてから項目へ結び、工程の報告を写す', async () => {
		const settings = { enabled: true };
		let ids = 0;
		const service = store.add(new ParadisBotsService(new MemoryFile<IParadisBotsState>(EMPTY_PARADIS_BOTS_STATE), new MemoryFile<IParadisBotItemsState>(EMPTY_PARADIS_BOT_ITEMS_STATE), store.add(new ParadisHumanAskService()), new NullLogService(), { uuid: () => `id${++ids}`, enabled: () => settings.enabled, now: () => 1000 }));
		const requests: ITaskBoardAddTaskRequest[] = [];
		let reply: TaskBoardAddTaskResult = { ok: true, taskId: 't-1' };
		const tools = new ParadisBotBoardToolProvider(service, () => settings.enabled, async request => {
			requests.push(request);
			return reply;
		});
		const context = (caller: ParadisMcpCallerKind): IParadisMcpToolCallContext => ({
			callOwningWindow: async () => ({ ok: false, error: 'unused' }),
			getPaneAgentStatus: () => undefined,
			getUnconfirmedRelease: () => undefined,
			hasAgentHookHistory: () => false,
			classifyCaller: async () => caller,
		});
		const call = async (pane: string, args: unknown, caller: ParadisMcpCallerKind = 'pane') => {
			const result = await tools.callTool(pane, 'bot_board_add_task', args, undefined, context(caller)) as { content: { text: string }[]; isError?: boolean };
			return result.isError ? `error: ${result.content[0].text.slice(0, 40)}` : JSON.parse(result.content[0].text);
		};
		for (const name of ['リリース係', 'レビュー係']) {
			assert.ok((await service.createBot({ name, agent: 'claude' })).ok);
		}
		const bind = (botId: string, purpose: 'chat' | 'patrol', token: string) => {
			const launchId = service.issueLaunch(botId, purpose);
			assert.ok(launchId !== undefined && service.reportLaunch(launchId, token));
		};
		bind('id1', 'chat', 'pane-1');
		bind('id1', 'patrol', 'pane-1p');
		bind('id2', 'chat', 'pane-2');
		const mine = await service.botAddItem('id1', { title: '変更履歴をまとめる', description: '184 の分' });
		const closed = await service.botAddItem('id1', { title: '済んだ' });
		const theirs = await service.botAddItem('id2', { title: '別の Bot の項目' });
		assert.ok(mine.ok && closed.ok && theirs.ok);
		await service.botUpdateItem('id1', closed.value.number, { status: 'done' });

		const listed = { chat: tools.listTools('pane-1').map(tool => tool.name), patrol: tools.listTools('pane-1p').length, stranger: tools.listTools('pane-x').length };
		const added = await call('pane-1', { number: mine.value.number });
		await service.noteBoardStep('t-1:2', '計画を書いた');
		await service.noteBoardStep('t-1:2', '計画を書いた');
		await service.noteBoardStep('t-1:3', '実装した');
		const refusals = {
			stranger: await call('pane-x', { number: mine.value.number }),
			unverified: await call('pane-1', { number: mine.value.number }, 'tunnel'),
			patrol: await call('pane-1p', { number: mine.value.number }),
			theirs: await call('pane-1', { number: theirs.value.number }),
			closed: await call('pane-1', { number: closed.value.number }),
			extra: await call('pane-1', { number: mine.value.number, bot_id: 'id2' }),
		};
		reply = { ok: false, reason: 'not-running' };
		const notRunning = await call('pane-1', { number: mine.value.number, title: '別の題' });
		for (const taskId of ['t-2', 't-3', 't-4', 't-5']) {
			reply = { ok: true, taskId };
			await call('pane-1', { number: mine.value.number });
		}
		const full = await call('pane-1', { number: mine.value.number });
		await service.updateBot('id1', { paused: true });
		const paused = await call('pane-1', { number: mine.value.number });
		settings.enabled = false;
		const off = { listed: tools.listTools('pane-1').length, call: await call('pane-1', { number: mine.value.number }) };
		await service.noteBoardStep('t-3:1', '止めている間');
		const item = service.getItem(mine.value.uid)!;

		assert.deepStrictEqual({
			listed, added, refusals, notRunning, full, paused, off,
			requests: requests.slice(0, 2),
			links: item.links.map(link => `${link.kind}:${link.ref}`),
			systemEvents: item.events.filter(event => event.actor === 'system').map(event => event.kind === 'commented' ? `note:${event.note}` : `${event.kind}:${event.refs?.join(',')}`),
		}, {
			listed: { chat: ['bot_board_add_task'], patrol: 0, stranger: 0 },
			added: { item: 1, task: 't-1', note: 'The task waits in the to-do column of the task board. Its step reports appear as comments on your item.' },
			refusals: {
				stranger: 'error: This terminal is not a Para Code bot, so',
				unverified: 'error: Para Code could not confirm that this re',
				patrol: 'error: This is a look-around, which only reads.',
				theirs: 'error: You have no item #3.',
				closed: 'error: Item #2 is closed. Reopen it first if th',
				extra: 'error: bot_board_add_task takes "number", and o',
			},
			notRunning: 'error: The Para Code task board is not open, so',
			full: 'error: Item #1 already has 5 task board tasks. ',
			paused: 'error: Your owner paused this bot, so Para Code',
			off: { listed: 0, call: 'error: Para Code bots are turned off in this Pa' },
			requests: [
				{ title: '変更履歴をまとめる', body: '184 の分', origin: { kind: 'bot', botId: 'id1', botName: 'リリース係', itemNumber: 1 } },
				{ title: '別の題', body: '184 の分', origin: { kind: 'bot', botId: 'id1', botName: 'リリース係', itemNumber: 1 } },
			],
			links: ['task:t-1', 'task:t-2', 'task:t-3', 'task:t-4', 'task:t-5'],
			systemEvents: ['linked:t-1', 'note:計画を書いた', 'note:実装した', 'linked:t-2', 'linked:t-3', 'linked:t-4', 'linked:t-5'],
		});
	});
});
