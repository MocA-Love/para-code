/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { join } from '../../../../../base/common/path.js';
import { tmpdir } from 'os';
import { promises as fs } from 'fs';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisHumanAskLedger } from '../../../humanAsk/common/paradisHumanAskLedger.js';
import { ParadisHumanAskService } from '../../../humanAsk/node/paradisHumanAskChannel.js';
import { EMPTY_PARADIS_BOT_ITEMS_STATE, IParadisBotItemsState } from '../../common/paradisBotItems.js';
import { EMPTY_PARADIS_BOTS_STATE, IParadisBotsState } from '../../common/paradisBots.js';
import { paradisBotStatusLine } from '../../common/paradisBotsBandModel.js';
import { IParadisBotStopRequest, PARADIS_BOT_IDLE_STOP_MS } from '../../common/paradisBotsApi.js';
import { paradisBotResumeArgs } from '../../common/paradisBotTools.js';
import { ParadisBotHomes } from '../../node/paradisBotHomes.js';
import { EMPTY_PARADIS_BOT_PANES_STATE, IParadisBotPanesState, paradisBotPaneTokenHash, paradisParseBotPanesState, ParadisBotPanes } from '../../node/paradisBotPanes.js';
import { ParadisBotsService } from '../../node/paradisBotsService.js';
import { ParadisBotMessageToolProvider } from '../../node/paradisBotMessageToolProvider.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpToolCallContext } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisBotGroupMessageRecord } from '../../common/paradisBotMessages.js';
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
		// ペインを閉じても会話は残る（止めた・30 分で止めた・再読み込みの前に隠したペインを閉じた後も、眠った会話として続けられる）
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

	test('何もしないまま 30 分たった会話のペインを止める候補にする。作業中のまま hook が途絶えたもの（Esc の中断）も数え、答え待ち・見回り・まだ使っていると知らされたものは除く', () => {
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
		bind('l6', 'used', 'used-token', 'chat');
		panes.noteActive('used-token', PARADIS_BOT_IDLE_STOP_MS);
		assert.deepStrictEqual(panes.idleChatTokens(PARADIS_BOT_IDLE_STOP_MS + 10), [{ botId: 'idle', token: 'idle-token' }, { botId: 'working', token: 'working-token' }]);
	});

	test('続きを開いて読んだだけで終えた（hook は来た）なら、眠った会話は残す', () => {
		const panes = new ParadisBotPanes();
		panes.loadSessions([{ botId: 'b1', agent: 'claude', sessionId: SESSION, at: 0 }]);
		panes.issue('l1', 'b1', 'chat', 1, 'claude', true);
		panes.report('l1', 'token-1', 1);
		panes.noteHook('token-1', 'SessionStart', 2, SESSION);
		panes.noteCommand('token-1', 0, true, 3);
		assert.strictEqual(panes.chatSessionOf('b1')?.sessionId, SESSION);
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
		// ウィンドウを再読み込みする前に隠したペインを閉じた（終わりの知らせより先にウィンドウが外す）。眠った会話として残る
		first.service.releasePane('pane-1');
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
			stops: [{ botId, paneHashes: [paradisBotPaneTokenHash('pane-1')], idle: true }],
			afterStop: '眠っています',
			sleeping: ['stopped', true, '眠っています'],
			resumed: [`--resume ${SESSION}`, true],
			afterAgentChange: [undefined, undefined],
		});
	});

	test('終了の印と眠る・隠す・30 分の停止・設定のオフ: 本物の終了だけで外れ、偽の終了・隠したペインでは制限も会話も残る', async () => {
		const disposables = store.add(new DisposableStore());
		const clock = { now: 1_000 };
		const homes = { ensure: async () => '/tmp/bot-home', read: async () => undefined, existingFolders: async () => [] } as unknown as ParadisBotHomes;
		const hooks = disposables.add(new Emitter<{ token: string; event: string; sessionId?: string; observedExit?: true }>());
		const settings = { enabled: true };
		const service = disposables.add(new ParadisBotsService(new MemoryFile<IParadisBotsState>(EMPTY_PARADIS_BOTS_STATE), new MemoryFile<IParadisBotItemsState>(EMPTY_PARADIS_BOT_ITEMS_STATE), disposables.add(new ParadisHumanAskService(new ParadisHumanAskLedger(() => clock.now))), new NullLogService(), {
			now: () => clock.now, hookEvents: hooks.event, panesFile: new MemoryFile<IParadisBotPanesState>(EMPTY_PARADIS_BOT_PANES_STATE), homes, enabled: () => settings.enabled,
		}));
		await service.ready;
		const created = await service.createBot({ name: 'A', agent: 'claude' });
		assert.ok(created.ok, created.ok ? '' : created.message);
		const botId = created.value.id;
		const bind = async (token: string) => {
			const launch = await service.requestLaunch(botId, 'chat');
			assert.ok(launch.ok);
			assert.ok(service.reportLaunch(launch.value.launchId, token));
			for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
				hooks.fire({ token, event, sessionId: SESSION });
			}
		};
		const stops: IParadisBotStopRequest[] = [];
		disposables.add(service.onDidRequestStop(request => stops.push(request)));
		await bind('pane-1');
		// 隠した（タブを閉じても裏で動き続ける）ペインには終了が届かない。エージェントの偽の TerminalExit も外さない
		hooks.fire({ token: 'pane-1', event: 'TerminalExit' });
		const hiddenOrForged = service.isBotPane('pane-1');
		// 何もしない 30 分: 窓へ止める依頼（idle）を出し、窓が閉じたら本物の終了として外れ、眠った会話として残る
		clock.now += PARADIS_BOT_IDLE_STOP_MS;
		service.stopIdleChats();
		const idleStop = stops.map(stop => [stop.paneHashes, stop.idle]);
		hooks.fire({ token: 'pane-1', event: 'TerminalExit', observedExit: true });
		const afterIdleStop = [service.isBotPane('pane-1'), paradisBotStatusLine(service.getSnapshot().bots[0])];
		// 起こした会話を、窓の再読み込みの前に窓が外す（releasePane はウィンドウだけが呼べる口）
		await bind('pane-2');
		service.releasePane('pane-2');
		const afterWindowRelease = [service.isBotPane('pane-2'), paradisBotStatusLine(service.getSnapshot().bots[0])];
		// 設定のオフ: 結び付いたペインは Bot のまま（制限が残る）。窓が閉じるペインのハッシュに載る
		await bind('pane-3');
		settings.enabled = false;
		const off = [service.isBotPane('pane-3'), service.allPaneHashes().includes(paradisBotPaneTokenHash('pane-3'))];
		assert.deepStrictEqual({ hiddenOrForged, idleStop, afterIdleStop, afterWindowRelease, off }, {
			hiddenOrForged: true,
			idleStop: [[[paradisBotPaneTokenHash('pane-1')], true]],
			afterIdleStop: [false, '眠っています'],
			afterWindowRelease: [false, '眠っています'],
			off: [true, true],
		});
	});

	test('前に出す依頼に応えが無かった（detach した）会話のペインが実は終わっていても行き止まりにならない: 眠っていると出し、前の会話を読め、話しかければ続けて起こせる。本物の終了の後も同じ', async () => {
		const disposables = store.add(new DisposableStore());
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-bot-detached-')));
		disposables.add({ dispose: () => void fs.rm(root, { recursive: true, force: true }) });
		await fs.mkdir(join(root, 'claude', 'projects', '-bot-home'), { recursive: true });
		await fs.writeFile(join(root, 'claude', 'projects', '-bot-home', `${SESSION}.jsonl`), JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: '前の返事' }] }, uuid: 'a1', timestamp: '2026-11-28T03:06:01.000Z', sessionId: SESSION }) + '\n');
		const clock = { now: 1_000 };
		const homes = { ensure: async () => '/tmp/bot-home', read: async () => undefined, existingFolders: async () => [] } as unknown as ParadisBotHomes;
		const hooks = disposables.add(new Emitter<{ token: string; event: string; sessionId?: string; observedExit?: true }>());
		const humanAsk = disposables.add(new ParadisHumanAskService(new ParadisHumanAskLedger(() => clock.now)));
		const service = disposables.add(new ParadisBotsService(new MemoryFile<IParadisBotsState>(EMPTY_PARADIS_BOTS_STATE), new MemoryFile<IParadisBotItemsState>(EMPTY_PARADIS_BOT_ITEMS_STATE), humanAsk, new NullLogService(), {
			now: () => clock.now, hookEvents: hooks.event, panesFile: new MemoryFile<IParadisBotPanesState>(EMPTY_PARADIS_BOT_PANES_STATE), homes, revealTimeoutMs: 10,
			transcriptRoots: { claudeConfigDir: join(root, 'claude'), codexHomes: [] },
		}));
		await service.ready;
		const created = await service.createBot({ name: 'A', agent: 'claude' });
		assert.ok(created.ok, created.ok ? '' : created.message);
		const botId = created.value.id;
		const launch = await service.requestLaunch(botId, 'chat');
		assert.ok(launch.ok);
		service.reportLaunch(launch.value.launchId, 'pane-1');
		hooks.fire({ token: 'pane-1', event: 'SessionStart', sessionId: SESSION });
		hooks.fire({ token: 'pane-1', event: 'UserPromptSubmit', sessionId: SESSION });
		hooks.fire({ token: 'pane-1', event: 'Stop', sessionId: SESSION });
		const whileBound = await service.sleepingChat(botId);
		// どのウィンドウも前に出す依頼に応えない（ペインのあったウィンドウが応えないまま終わった）
		const answered = await service.requestReveal(botId);
		const look = async () => {
			const summary = service.getSnapshot().bots[0];
			const chat = await service.sleepingChat(botId);
			const wake = await service.requestLaunch(botId, 'chat');
			if (wake.ok) {
				service.cancelLaunch(wake.value.launchId);
			}
			return {
				status: [summary.activity, summary.sleeping ?? false, paradisBotStatusLine(summary)],
				read: chat?.messages.map(message => message.text),
				wake: wake.ok ? wake.value.extraFlags : wake.code,
				// 止める依頼では、応えの無かったペインも一緒に閉じる（#1266）
				stopsIt: service.paneHashesOf(botId, 'chat').includes(paradisBotPaneTokenHash('pane-1')),
			};
		};
		const detached = await look();
		// 本物の終了が届いた後も同じ（終了の知らせが来なくても上のとおり行き止まりにならない）
		hooks.fire({ token: 'pane-1', event: 'TerminalExit', observedExit: true });
		const exited = await look();
		assert.deepStrictEqual({ whileBound, answered, detached, exited }, {
			whileBound: undefined,
			answered: false,
			detached: { status: ['stopped', true, '眠っています'], read: ['前の返事'], wake: `--resume ${SESSION}`, stopsIt: true },
			exited: { status: ['stopped', true, '眠っています'], read: ['前の返事'], wake: `--resume ${SESSION}`, stopsIt: false },
		});
	});

	test('応えの無かった会話のペインのエージェントが動いている・分からないときは同じ会話を新しく起こさない。終わっていれば起こす。「止めて起こし直す」は止める依頼を出してから起こす。ウィンドウで見つかったら結び付け直す', async () => {
		const disposables = store.add(new DisposableStore());
		const clock = { now: 1_000 };
		const homes = { ensure: async () => '/tmp/bot-home', read: async () => undefined, existingFolders: async () => [] } as unknown as ParadisBotHomes;
		const alive = new Map<string, boolean | undefined>();
		const start = async () => {
			const hooks = disposables.add(new Emitter<{ token: string; event: string; sessionId?: string; observedExit?: true }>());
			const humanAsk = disposables.add(new ParadisHumanAskService(new ParadisHumanAskLedger(() => clock.now)));
			const service = disposables.add(new ParadisBotsService(new MemoryFile<IParadisBotsState>(EMPTY_PARADIS_BOTS_STATE), new MemoryFile<IParadisBotItemsState>(EMPTY_PARADIS_BOT_ITEMS_STATE), humanAsk, new NullLogService(), {
				now: () => clock.now, hookEvents: hooks.event, panesFile: new MemoryFile<IParadisBotPanesState>(EMPTY_PARADIS_BOT_PANES_STATE), homes, revealTimeoutMs: 10,
				paneAlive: async token => alive.get(token),
			}));
			await service.ready;
			const created = await service.createBot({ name: 'A', agent: 'claude' });
			assert.ok(created.ok, created.ok ? '' : created.message);
			const botId = created.value.id;
			const launch = await service.requestLaunch(botId, 'chat');
			assert.ok(launch.ok);
			service.reportLaunch(launch.value.launchId, 'pane-1');
			hooks.fire({ token: 'pane-1', event: 'SessionStart', sessionId: SESSION });
			hooks.fire({ token: 'pane-1', event: 'UserPromptSubmit', sessionId: SESSION });
			hooks.fire({ token: 'pane-1', event: 'Stop', sessionId: SESSION });
			// どのウィンドウも前に出す依頼に応えない
			assert.strictEqual(await service.requestReveal(botId), false);
			return { service, botId };
		};
		const launchCode = async (service: ParadisBotsService, botId: string) => {
			const result = await service.requestLaunch(botId, 'chat');
			if (result.ok) {
				service.cancelLaunch(result.value.launchId);
			}
			return result.ok ? result.value.extraFlags : result.code;
		};

		// 動いている・分からない: 起こさない（同じ会話が 2 つ動く）
		const a = await start();
		alive.set('pane-1', true);
		const whileAlive = await launchCode(a.service, a.botId);
		alive.set('pane-1', undefined);
		const whileUnknown = await launchCode(a.service, a.botId);
		// 「止めて起こし直す」: 応えの無かったペインへ止める依頼を出してから、確かめずに起こす（制限は本物の終了まで残す）
		const stops: IParadisBotStopRequest[] = [];
		disposables.add(a.service.onDidRequestStop(request => stops.push(request)));
		a.service.restartChat(a.botId);
		const afterRestart = await launchCode(a.service, a.botId);
		const restrictedAfterRestart = a.service.isBotPane('pane-1');

		// 終わっていた: 起こす（そのペインの制限は本物の終了まで残す）
		const b = await start();
		alive.set('pane-1', false);
		const whenEnded = await launchCode(b.service, b.botId);
		const restrictedWhenEnded = b.service.isBotPane('pane-1');

		// このウィンドウで見つかった（生きていた）: 会話のペインとして結び付け直し、新しく起こさない
		const c = await start();
		alive.set('pane-1', true);
		c.service.reclaimPane('pane-1');
		const reclaimed = [c.service.getSnapshot().bots[0].activity, await launchCode(c.service, c.botId)];
		// 応えの無かったペインでないなら何もしない
		c.service.reclaimPane('pane-x');

		assert.deepStrictEqual({ whileAlive, whileUnknown, stops, afterRestart, restrictedAfterRestart, whenEnded, restrictedWhenEnded, reclaimed, stray: c.service.isBotPane('pane-x') }, {
			whileAlive: 'detached_alive',
			whileUnknown: 'detached_alive',
			stops: [{ botId: a.botId, paneHashes: [paradisBotPaneTokenHash('pane-1')] }],
			afterRestart: `--resume ${SESSION}`,
			restrictedAfterRestart: true,
			whenEnded: `--resume ${SESSION}`,
			restrictedWhenEnded: true,
			reclaimed: ['idle', 'already_open'],
			stray: false,
		});
	});

	test('bot_tell: 宛先が止まっていても起こさない（受け箱に入れるだけ。利用者の居ない所で頼まれたことを実行させない）', async () => {
		const disposables = store.add(new DisposableStore());
		let ids = 0;
		const service = disposables.add(new ParadisBotsService(new MemoryFile<IParadisBotsState>(EMPTY_PARADIS_BOTS_STATE), new MemoryFile<IParadisBotItemsState>(EMPTY_PARADIS_BOT_ITEMS_STATE), disposables.add(new ParadisHumanAskService()), new NullLogService(), { uuid: () => `id${++ids}` }));
		for (const name of ['A', 'B']) {
			assert.ok((await service.createBot({ name, agent: 'claude' })).ok);
		}
		const bind = (botId: string, token: string) => {
			const launchId = service.issueLaunch(botId, 'chat');
			assert.ok(launchId !== undefined && service.reportLaunch(launchId, token));
		};
		bind('id1', 'pane-a');
		const port = {
			groupsOf: async () => [{ id: 'g1', memberIds: ['id1', 'id2'] }],
			appendRecord: async (_groupId: string, _record: IParadisBotGroupMessageRecord) => ({ ok: true, recordId: 'r1' }),
			inboxOf: async () => [],
			markRead: async () => true,
		};
		let clock = 1_000_000;
		const tools = new ParadisBotMessageToolProvider(service, () => true, () => port, () => clock);
		const windowCalls: unknown[] = [];
		const context: IParadisMcpToolCallContext = {
			callOwningWindow: async <T>(request: IParadisMcpOwningWindowRequest) => {
				windowCalls.push([request.channelName, request.method, request.args]);
				return { ok: true, value: { ok: true, data: {} } as T };
			},
			getPaneAgentStatus: () => undefined,
			getUnconfirmedRelease: () => undefined,
			hasAgentHookHistory: () => false,
			classifyCaller: async () => 'pane',
		};
		const tell = async () => JSON.parse(((await tools.callTool('pane-a', 'bot_tell', { to: 'B', text: 'x' }, undefined, context)) as { content: { text: string }[] }).content[0].text).inbox.slice(0, 40);
		const asleep = await tell();
		bind('id2', 'pane-b');
		clock += 61_000;
		const awake = await tell();
		assert.deepStrictEqual({ asleep, awake, windowCalls }, {
			asleep: 'Put in the inbox of "B". It reads it the',
			awake: 'Put in the inbox of "B". It reads it the',
			windowCalls: [],
		});
	});
});
