/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMcpToolCallContext, ParadisMcpCallerKind } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisHumanAskSnapshot } from '../../../humanAsk/common/paradisHumanAsk.js';
import { ParadisHumanAskLedger } from '../../../humanAsk/common/paradisHumanAskLedger.js';
import { ParadisHumanAskService } from '../../../humanAsk/node/paradisHumanAskChannel.js';
import { EMPTY_PARADIS_BOT_ITEMS_STATE, IParadisBotItemsState } from '../../common/paradisBotItems.js';
import { EMPTY_PARADIS_BOTS_STATE, IParadisBotsState } from '../../common/paradisBots.js';
import { IParadisBotsSnapshot } from '../../common/paradisBotsApi.js';
import { EMPTY_PARADIS_BOT_PANES_STATE, IParadisBotPanesState, PARADIS_BOT_LAUNCH_TTL_MS } from '../../node/paradisBotPanes.js';
import { ParadisBotToolProvider } from '../../node/paradisBotToolProvider.js';
import { ParadisBotsService } from '../../node/paradisBotsService.js';
import { IParadisBotsJsonFile } from '../../node/paradisBotsStore.js';

/** メモリの保存先。`failing` を立てると書き込みが失敗する。 */
class MemoryFile<T> implements IParadisBotsJsonFile<T> {
	failing = false;
	writes = 0;
	constructor(public state: T) { }
	async read() {
		return { state: this.state };
	}
	async write(state: T) {
		if (this.failing) {
			throw new Error('disk full');
		}
		this.writes++;
		this.state = state;
	}
}

interface IHarness {
	readonly service: ParadisBotsService;
	readonly humanAsk: ParadisHumanAskService;
	readonly tools: ParadisBotToolProvider;
	readonly botsFile: MemoryFile<IParadisBotsState>;
	readonly itemsFile: MemoryFile<IParadisBotItemsState>;
	readonly panesFile: MemoryFile<IParadisBotPanesState>;
	readonly hooks: Emitter<{ token: string; event: string }>;
	readonly clock: { now: number };
	/** 道具を呼び、結果の JSON（失敗なら `error: 文`）を返す。 */
	call(paneToken: string, name: string, args?: unknown, caller?: ParadisMcpCallerKind | 'none'): Promise<Record<string, unknown>>;
	/** Bot を作り、ペイン `pane-<名前>` を結び付ける。Bot の id を返す。 */
	bot(name: string): Promise<string>;
}

function harness(store: Pick<DisposableStore, 'add'>, files?: { botsFile: MemoryFile<IParadisBotsState>; itemsFile: MemoryFile<IParadisBotItemsState>; panesFile?: MemoryFile<IParadisBotPanesState> }): IHarness {
	const clock = { now: 1_000 };
	const botsFile = files?.botsFile ?? new MemoryFile(EMPTY_PARADIS_BOTS_STATE);
	const itemsFile = files?.itemsFile ?? new MemoryFile(EMPTY_PARADIS_BOT_ITEMS_STATE);
	const panesFile = files?.panesFile ?? new MemoryFile(EMPTY_PARADIS_BOT_PANES_STATE);
	const humanAsk = store.add(new ParadisHumanAskService(new ParadisHumanAskLedger(() => clock.now)));
	const hooks = store.add(new Emitter<{ token: string; event: string }>());
	let ids = 0;
	const service = store.add(new ParadisBotsService(botsFile, itemsFile, humanAsk, new NullLogService(), { now: () => clock.now, uuid: () => `id${++ids}`, hookEvents: hooks.event, panesFile }));
	const tools = new ParadisBotToolProvider(service);
	const context = (caller: ParadisMcpCallerKind): IParadisMcpToolCallContext => ({
		callOwningWindow: async () => ({ ok: false, error: 'unused' }),
		getPaneAgentStatus: () => undefined,
		getUnconfirmedRelease: () => undefined,
		hasAgentHookHistory: () => false,
		classifyCaller: async () => caller,
	});
	return {
		service, humanAsk, tools, botsFile, itemsFile, panesFile, hooks, clock,
		async call(paneToken, name, args, caller = 'pane') {
			const result = await tools.callTool(paneToken, name, args, undefined, caller === 'none' ? undefined : context(caller)) as { content: { text: string }[]; isError?: boolean };
			return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
		},
		async bot(name) {
			const created = await service.createBot({ name, agent: 'claude' });
			assert.ok(created.ok);
			const launchId = service.issueLaunch(created.value.id, 'chat');
			assert.ok(launchId !== undefined && service.reportLaunch(launchId, `pane-${name}`));
			return created.value.id;
		},
	};
}

const asks = (snapshot: IParadisHumanAskSnapshot) => snapshot.entries.map(entry => `${entry.key} ${entry.state}${entry.resolution?.surface ? ` by ${entry.resolution.surface}: ${entry.resolution.summary}` : ''}`);

const ASK_ARGS = { number: 1, status: 'needs_you', comment: 'セッションの扱いを決めてください', questions: [{ question: '全員をログアウトさせますか?', options: [{ label: 'させる' }, { label: '残す' }], recommended: '残す' }] };

suite('Paradis bots service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('保存して読み戻す: Bot・項目・番号の続きが残り、結び付けは残らない', async () => {
		const first = harness(store);
		const botId = await first.bot('リリース係');
		await first.call('pane-リリース係', 'bot_item_add', { title: 'ログインの不具合を直す', done_means: 'テストが通る' });
		await first.call('pane-リリース係', 'bot_item_update', { number: 1, comment: '原因が分かった' });

		// ペインとの結び付けの保存（panes.json）が無ければ、前のペインはもう Bot ではない
		const second = harness(store, { botsFile: first.botsFile, itemsFile: first.itemsFile });
		await second.service.ready;
		const reopened = await second.call('pane-リリース係', 'bot_item_list');
		const launchId = second.service.issueLaunch(botId, 'chat');
		assert.ok(launchId !== undefined && second.service.reportLaunch(launchId, 'pane-new'));
		const added = await second.call('pane-new', 'bot_item_add', { title: '二つ目' });
		const shown = await second.call('pane-new', 'bot_item_show', { number: 1 });
		assert.deepStrictEqual({
			bots: second.service.getSnapshot().bots.map(bot => [bot.id, bot.name, bot.folder, bot.openItems]),
			reopened,
			added,
			shown: { title: shown.title, done_means: shown.done_means, events: (shown.events as { kind: string; text?: string }[]).map(event => `${event.kind}${event.text ? `: ${event.text}` : ''}`) },
		}, {
			bots: [['id1', 'リリース係', 'bot', 2]],
			reopened: { error: 'This terminal is not a Para Code bot, so the bot item tools do nothing here. Only a terminal that Para Code started for a bot can use them.' },
			added: { number: 2, status: 'working', last_event: 1 },
			shown: { title: 'ログインの不具合を直す', done_means: 'テストが通る', events: ['made', 'commented: 原因が分かった'] },
		});
	});

	test('Needs you → 「聞く・答える」に 1 件 → 回答 → 項目が作業中へ戻る', async () => {
		const h = harness(store);
		await h.bot('リリース係');
		const seen: string[][] = [];
		store.add(h.humanAsk.onDidChange(snapshot => seen.push(asks(snapshot))));
		const mail: string[] = [];
		store.add(h.service.onDidQueueMail(event => mail.push(event.uid)));

		await h.call('pane-リリース係', 'bot_item_add', { title: 'ログインの不具合を直す' });
		const asked = await h.call('pane-リリース係', 'bot_item_update', ASK_ARGS);
		await timeout(80);
		const waiting = h.humanAsk.getSnapshot();
		const needsYou = h.service.getSnapshot().bots[0].needsYou;

		h.clock.now = 5_000;
		const answered = h.humanAsk.answer('bot:id3.2', { type: 'answers', answers: [{ questionId: 'q1', optionIds: ['o2'], text: '金曜までは' }] }, 'inbox');
		await timeout(80);
		const item = h.service.getItem('id3');
		const shown = await h.call('pane-リリース係', 'bot_item_show', { number: 1, after: 3 });
		assert.deepStrictEqual({
			asked,
			waiting: [waiting.counts, waiting.entries.map(entry => [entry.key, entry.owner, entry.from, entry.questions.map(question => question.options.map(option => option.label))])],
			needsYou,
			answered: answered.ok,
			seen,
			item: [item?.status, item?.ask, item?.events.slice(-2)],
			after: [h.service.getSnapshot().bots[0].needsYou, h.humanAsk.getSnapshot().counts.total],
			mail,
			// Bot は持ち主の答えを道具で読める。読んだ分は「まだ届けていない」から外れる
			shown: shown.owner_updates,
			pendingAfterRead: h.service.pendingMail('id1'),
		}, {
			asked: { number: 1, status: 'needs_you', last_event: 3 },
			waiting: [{ total: 1, pane: 0, board: 0, bot: 1 }, [['bot:id3.2', 'bots', { title: 'リリース係', detail: '#1 ログインの不具合を直す' }, [['させる', '残す']]]]],
			needsYou: 1,
			answered: true,
			// allow-any-unicode-next-line
			seen: [['bot:id3.2 waiting'], ['bot:id3.2 answered by inbox: 残す ／ 金曜までは']],
			item: ['working', undefined, [
				{ id: 4, kind: 'commented', actor: 'owner', at: 5_000, text: '残す\n金曜までは', answers: 2, toBot: true },
				{ id: 5, kind: 'status', actor: 'owner', at: 5_000, from: 'needs_you', to: 'working' },
			]],
			after: [0, 0],
			mail: ['id3'],
			shown: [{ id: 4, kind: 'commented', actor: 'owner', at: '1970-01-01T00:00:05.000Z', text: '残す\n金曜までは', answers: 2 }],
			pendingAfterRead: [],
		});
	});

	test('聞き直し・取り下げ・一時停止・後回し・削除で、台帳の待ちが入れ替わる', async () => {
		const h = harness(store);
		const botId = await h.bot('A');
		await h.call('pane-A', 'bot_item_add', { title: '一つ目' });
		await h.call('pane-A', 'bot_item_update', ASK_ARGS);
		const waiting = () => asks(h.humanAsk.getSnapshot()).filter(line => line.endsWith('waiting'));
		const first = waiting();
		await h.call('pane-A', 'bot_item_update', { number: 1, status: 'needs_you', comment: '聞き直します', questions: [{ question: 'A と B のどちらですか?' }] });
		const again = waiting();
		// 古い問いへの答えは届かない
		const stale = h.humanAsk.answer('bot:id3.2', { type: 'answers', answers: [{ questionId: 'q1', optionIds: ['o1'] }] }, 'inbox');
		await h.service.updateBot(botId, { paused: true });
		const paused = [waiting(), h.service.getSnapshot().bots[0].needsYou, h.service.getSnapshot().bots[0].activity];
		await h.service.updateBot(botId, { paused: false });
		const resumed = waiting();
		await h.service.ownerSnooze('id3', 1_050);
		const snoozed = [waiting(), h.service.getSnapshot().bots[0].needsYou];
		h.clock.now = 1_100;
		await timeout(150);
		const woke = [waiting(), h.service.getSnapshot().bots[0].needsYou];
		await h.call('pane-A', 'bot_item_update', { number: 1, status: 'working' });
		const withdrawn = waiting();
		await h.call('pane-A', 'bot_item_update', { number: 1, status: 'needs_you' });
		const look = h.humanAsk.getSnapshot().entries.filter(entry => entry.state === 'waiting').map(entry => [entry.key, entry.questions]);
		// Bot のページから直接答えると、台帳では「取り下げ」ではなく「回答済み」になる
		await h.service.ownerComment('id3', { text: '見ました' });
		const direct = asks(h.humanAsk.getSnapshot())[0];
		await h.service.removeBot(botId);
		assert.deepStrictEqual({ first, again, stale: stale.ok, paused, resumed, snoozed, woke, withdrawn, look, removed: [waiting(), h.service.listItems(), h.service.botOfPane('pane-A')], direct }, {
			first: ['bot:id3.2 waiting'],
			again: ['bot:id3.4 waiting'],
			stale: false,
			paused: [[], 0, 'stopped'],
			resumed: ['bot:id3.4 waiting'],
			snoozed: [[], 0],
			woke: [['bot:id3.4 waiting'], 1],
			withdrawn: [],
			look: [['bot:id3.8', [{ id: 'q1', text: '一つ目', options: [], allowText: true }]]],
			removed: [[], [], undefined],
			direct: 'bot:id3.8 answered by bot: 見ました',
		});
	});

	test('起動し直し: 保存したトークンのハッシュで、同じペインが現れたら結び付けを戻す', async () => {
		const first = harness(store);
		const a = await first.bot('A');
		await first.bot('B');
		await first.call('pane-A', 'bot_item_add', { title: 'A の項目' });
		const saved = first.panesFile.state;

		const second = harness(store, first);
		await second.service.ready;
		// 現れるまでは動いているものに数えない
		const beforeSeen = second.service.getSnapshot().bots.map(bot => bot.activity);
		// 止める依頼は、まだ現れていないペインのハッシュも載せる（ウィンドウが自分のペインと照らして閉じる）
		const stops: unknown[] = [];
		store.add(second.service.onDidRequestStop(request => stops.push(request)));
		const stopped = second.service.requestStop(second.service.getSnapshot().bots[1].id);
		// 保存した結び付けで B のものになっているトークンを、A の起動として報告しても通らない
		const launchId = second.service.issueLaunch(a, 'chat');
		const stolen = launchId !== undefined && second.service.reportLaunch(launchId, 'pane-B');
		const listed = await second.call('pane-A', 'bot_item_list');
		second.hooks.fire({ token: 'pane-B', event: 'UserPromptSubmit' });
		const afterSeen = second.service.getSnapshot().bots.map(bot => [bot.name, bot.activity]);
		// 現れないまま閉じたペイン（TerminalExit）と、消した Bot の分は保存から消える
		second.hooks.fire({ token: 'pane-A', event: 'TerminalExit' });
		await second.service.removeBot(second.service.botOfPane('pane-B')!.id);
		assert.deepStrictEqual({
			saved: [saved.version, saved.panes.map(pane => [pane.hash, pane.purpose])],
			tokenNotSaved: JSON.stringify(saved).includes('pane-'),
			beforeSeen,
			stolen,
			stopped: [stopped, stops],
			listed: (listed.items as { title: string }[]).map(item => item.title),
			afterSeen,
			left: second.panesFile.state.panes,
		}, {
			saved: [1, [
				['1b780c2005e24c7adab28a00c48fd437c37580c140f7b9585d87f54e78b59cff', 'chat'],
				['595738e51f96f4da3b0bd4c0fa10ee3a1519a6d53e5632f5419c215b3d1740c4', 'chat'],
			]],
			tokenNotSaved: false,
			beforeSeen: ['stopped', 'stopped'],
			stolen: false,
			// 2 件目は Bot を消したときの止める依頼
			stopped: [true, [
				{ botId: 'id3', paneHashes: ['595738e51f96f4da3b0bd4c0fa10ee3a1519a6d53e5632f5419c215b3d1740c4'] },
				{ botId: 'id3', paneHashes: ['595738e51f96f4da3b0bd4c0fa10ee3a1519a6d53e5632f5419c215b3d1740c4'] },
			]],
			listed: ['A の項目'],
			afterSeen: [['A', 'idle'], ['B', 'working']],
			left: [],
		});
	});

	test('あなたの番: Bot の行の件数と「聞く・答える」の Bot の件数が一致する', async () => {
		const h = harness(store);
		await h.bot('A');
		const paused = await h.bot('B');
		await h.call('pane-A', 'bot_item_add', { title: '聞く項目' });
		await h.call('pane-A', 'bot_item_update', ASK_ARGS);
		const own = await h.call('pane-A', 'bot_item_add', { title: '持ち主が Needs you にする項目' });
		await h.service.ownerSetStatus(h.service.listItems().find(item => item.number === own.number)!.uid, 'needs_you');
		await h.call('pane-B', 'bot_item_add', { title: '止める Bot の項目' });
		await h.call('pane-B', 'bot_item_update', { ...ASK_ARGS, number: 3 });
		await h.service.updateBot(paused, { paused: true });
		const rows = h.service.getSnapshot().bots.map(bot => [bot.name, bot.needsYou]);
		assert.deepStrictEqual({ rows, ask: h.humanAsk.getSnapshot().counts.bot }, { rows: [['A', 1], ['B', 0]], ask: 1 });
	});

	test('Bot でないペイン・確かめられない接続元・ほかの Bot の項目を断る', async () => {
		const h = harness(store);
		await h.bot('A');
		await h.bot('B');
		await h.call('pane-A', 'bot_item_add', { title: 'A の項目' });
		const error = async (pane: string, name: string, args: unknown, caller?: ParadisMcpCallerKind | 'none') => String((await h.call(pane, name, args, caller)).error ?? 'ok').slice(0, 44);
		assert.deepStrictEqual({
			stranger: [await error('pane-other', 'bot_item_list', {}), await error('pane-other', 'bot_item_add', { title: '偽の項目' }), await error('', 'bot_item_update', { number: 1, status: 'done' })],
			unverified: [await error('pane-A', 'bot_item_update', { number: 1, comment: 'x' }, 'unverified'), await error('pane-A', 'bot_item_add', { title: 'x' }, 'tunnel'), await error('pane-A', 'bot_item_add', { title: 'x' }, 'none'), await error('pane-A', 'bot_item_list', {}, 'unverified')],
			// Bot は手元だけなので、読む道具も SSH の戻り経路からは通さない
			tunnelRead: await error('pane-A', 'bot_item_show', { number: 1 }, 'tunnel'),
			otherBot: [await error('pane-B', 'bot_item_update', { number: 1, status: 'done' }), await error('pane-B', 'bot_item_show', { number: 1 }), (await h.call('pane-B', 'bot_item_list')).items],
			// 引数で Bot を名乗っても通らない
			spoofedArgument: await error('pane-B', 'bot_item_add', { title: 'x', bot_id: 'id1' }),
			notOurs: await h.tools.callTool('pane-A', 'take_snapshot', {}),
			unchanged: h.service.listItems().map(item => [item.botId, item.title, item.status, item.events.length]),
		}, {
			stranger: ['This terminal is not a Para Code bot, so the', 'This terminal is not a Para Code bot, so the', 'This terminal is not a Para Code bot, so the'],
			unverified: ['Para Code could not confirm that this reques', 'Para Code could not confirm that this reques', 'Para Code could not confirm that this reques', 'Para Code could not confirm that this reques'],
			tunnelRead: 'Para Code could not confirm that this reques',
			otherBot: ['Item #1 belongs to another bot. (not_owner)', 'Item #1 belongs to another bot. (not_owner)', []],
			spoofedArgument: 'Unknown argument "bot_id". Allowed: title, d',
			notOurs: undefined,
			unchanged: [['id1', 'A の項目', 'working', 1]],
		});
	});

	test('結び付けは発行した番号の 1 回だけ: 偽の番号・2 回目・使用中のトークン・期限切れを断る', async () => {
		const h = harness(store);
		const created = await h.service.createBot({ name: 'A', agent: 'claude' });
		const other = await h.service.createBot({ name: 'B', agent: 'codex' });
		assert.ok(created.ok && other.ok);
		const launchA = h.service.issueLaunch(created.value.id, 'chat')!;
		const launchB = h.service.issueLaunch(other.value.id, 'patrol')!;
		const expired = h.service.issueLaunch(created.value.id, 'chat')!;
		const results = {
			forged: h.service.reportLaunch('not-issued', 'pane-x'),
			first: h.service.reportLaunch(launchA, 'pane-a'),
			replay: h.service.reportLaunch(launchA, 'pane-y'),
			// B の番号で、A のペインを B に付け替えることはできない
			tokenTaken: h.service.reportLaunch(launchB, 'pane-a'),
			emptyToken: h.service.reportLaunch(h.service.issueLaunch(other.value.id, 'chat')!, ''),
			unknownBot: h.service.issueLaunch('nope', 'chat'),
		};
		h.clock.now += PARADIS_BOT_LAUNCH_TTL_MS + 1;
		const late = h.service.reportLaunch(expired, 'pane-late');
		await h.service.updateBot(other.value.id, { paused: true });
		assert.deepStrictEqual({ ...results, late, pausedBot: h.service.issueLaunch(other.value.id, 'chat'), bound: ['pane-a', 'pane-x', 'pane-y', 'pane-late'].map(token => h.service.botOfPane(token)?.name) }, {
			forged: false, first: true, replay: false, tokenTaken: false, emptyToken: false, unknownBot: undefined,
			late: false, pausedBot: undefined, bound: ['A', undefined, undefined, undefined],
		});
	});

	test('一覧の値: あなたの番の件数・様子・最後に動いた時刻と、変更の知らせ', async () => {
		const h = harness(store);
		const seen: IParadisBotsSnapshot[] = [];
		store.add(h.service.onDidChange(snapshot => seen.push(snapshot)));
		const created = await h.service.createBot({ name: 'A', agent: 'claude' });
		assert.ok(created.ok);
		const row = () => {
			const bot = h.service.getSnapshot().bots[0];
			return [bot.activity, bot.needsYou, bot.openItems, bot.lastActivityAt];
		};
		const stopped = row();
		h.clock.now = 2_000;
		assert.ok(h.service.reportLaunch(h.service.issueLaunch(created.value.id, 'chat')!, 'pane-chat'));
		const idle = row();
		h.clock.now = 3_000;
		h.hooks.fire({ token: 'pane-chat', event: 'UserPromptSubmit' });
		h.hooks.fire({ token: 'pane-stranger', event: 'UserPromptSubmit' });
		const working = row();
		h.clock.now = 4_000;
		await h.call('pane-chat', 'bot_item_add', { title: '項目' });
		await h.call('pane-chat', 'bot_item_update', { number: 1, status: 'needs_you' });
		h.hooks.fire({ token: 'pane-chat', event: 'Stop' });
		const waiting = row();
		assert.ok(h.service.reportLaunch(h.service.issueLaunch(created.value.id, 'patrol')!, 'pane-patrol'));
		h.clock.now = 5_000;
		// Codex の hook の名前でも同じ正規化を通る
		h.hooks.fire({ token: 'pane-patrol', event: 'task_started' });
		const patrolling = row();
		// ターミナルを閉じると結び付けが外れ、「停止」へ戻る
		h.hooks.fire({ token: 'pane-patrol', event: 'TerminalExit' });
		h.hooks.fire({ token: 'pane-chat', event: 'TerminalExit' });
		const released = row();
		await timeout(80);
		const revisions = seen.map(snapshot => snapshot.revision);
		assert.deepStrictEqual({ stopped, idle, working, waiting, patrolling, released, notified: seen.length > 0 && revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]), last: seen.at(-1)?.revision === h.service.getSnapshot().revision }, {
			stopped: ['stopped', 0, 0, 1_000],
			idle: ['idle', 0, 0, 2_000],
			working: ['working', 0, 0, 3_000],
			waiting: ['idle', 1, 1, 4_000],
			patrolling: ['patrolling', 1, 1, 5_000],
			released: ['stopped', 1, 1, 4_000],
			notified: true,
			last: true,
		});
	});

	test('保存できなければ断り、中身を元へ戻す', async () => {
		const h = harness(store);
		await h.bot('A');
		await h.call('pane-A', 'bot_item_add', { title: '項目' });
		h.itemsFile.failing = true;
		const failed = await h.call('pane-A', 'bot_item_update', { number: 1, status: 'done' });
		const ownerFailed = await h.service.ownerComment('id3', { text: 'x' });
		h.itemsFile.failing = false;
		assert.deepStrictEqual({
			failed, ownerFailed,
			after: h.service.listItems().map(item => [item.status, item.events.length]),
			writes: h.itemsFile.writes,
		}, {
			failed: { error: 'Para Code could not save the change. (storage)' },
			ownerFailed: { ok: false, code: 'storage', message: 'Para Code could not save the change.' },
			after: [['working', 1]],
			writes: 1,
		});
	});
});
