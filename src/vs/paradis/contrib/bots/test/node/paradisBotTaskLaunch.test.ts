/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisHumanAskService } from '../../../humanAsk/node/paradisHumanAskChannel.js';
import { paradisBotTaskLaunchArgs } from '../../common/paradisBotTools.js';
import { ParadisBotHomes } from '../../node/paradisBotHomes.js';
import { ParadisBotPanes } from '../../node/paradisBotPanes.js';
import { ParadisBotsService } from '../../node/paradisBotsService.js';
import { paradisBotPatrolToolRefusal } from '../../node/paradisBotManageToolProvider.js';
import { createParadisBotItemsFile, createParadisBotPanesFile, createParadisBotsFile, paradisBotsDataFolder } from '../../node/paradisBotsStore.js';

const READ_ONLY = new Set(['take_snapshot', 'get_text']);
const CLAUDE = { agent: 'claude', runFolder: '/data/runs/b-task', homeFolder: '/home/bot', instructionsFile: '/data/runs/b-task/AGENTS.md', settingsFile: '/d/s.json', mcpConfigFile: '/d/m.json' } as const;

suite('Paradis bot scheduled tasks: launching', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let homes: ParadisBotHomes;

	setup(async () => {
		root = join(await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-bot-task-'))), 'bots');
		homes = new ParadisBotHomes(root);
	});

	teardown(async () => {
		await fs.rm(join(root, '..'), { recursive: true, force: true });
	});

	test('段ごとの起動の引数: Web だけは Web の道具だけで MCP も手元を読む道具も渡さない。読む＋Web は見回りの引数に Web を足す', () => {
		const codex = { agent: 'codex', runFolder: '/data/runs/b-task', disabledServers: [{ name: 'gh', transport: 'url' }] } as const;
		const readWeb = paradisBotTaskLaunchArgs(CLAUDE, 'readWeb', READ_ONLY);
		assert.deepStrictEqual({
			web: paradisBotTaskLaunchArgs(CLAUDE, 'web', READ_ONLY),
			readWebTools: readWeb.filter(arg => arg.startsWith('--tools=') || arg.startsWith('--add-dir=') || arg.startsWith('--allowedTools=WebFetch,WebSearch,mcp__para-browser__bot_item_list')).length,
			codexReadWeb: paradisBotTaskLaunchArgs(codex, 'readWeb', READ_ONLY).slice(0, 5),
			codexWeb: (() => { try { paradisBotTaskLaunchArgs(codex, 'web', READ_ONLY); return 'built'; } catch { return 'refused'; } })(),
		}, {
			web: ['--permission-mode', 'dontAsk', '--settings=/d/s.json', '--setting-sources=user', '--strict-mcp-config', '--tools=WebFetch,WebSearch', '--allowedTools=WebFetch,WebSearch'],
			readWebTools: 3,
			codexReadWeb: ['-s', 'read-only', '-a', 'never', '--search'],
			codexWeb: 'refused',
		});
	});

	test('起こし方: 定期実行は会話とは別の会話（眠った会話があっても --resume しない）で、空の作業フォルダ。Bot の権限だけ会話の権限。会話が開いていても門は開く', async () => {
		const userData = join(root, '..', 'userData');
		await fs.mkdir(paradisBotsDataFolder(userData), { recursive: true });
		await fs.writeFile(join(paradisBotsDataFolder(userData), 'bots.json'), JSON.stringify({ version: 1, bots: [{ id: 'id1', name: '天気係', folder: 'tenki', agent: 'claude', permissionId: 'skip-permissions', paused: false, pinned: false, faceColor: 'blue', faceShape: 'blob', createdAt: 1, updatedAt: 1 }] }));
		await fs.writeFile(join(paradisBotsDataFolder(userData), 'panes.json'), JSON.stringify({ version: 1, panes: [], sessions: [{ botId: 'id1', agent: 'claude', sessionId: '38032a17-8d2f-4e54-8032-9913ffa81623', at: 1 }], boardTasks: [], boardPanes: [] }));
		let ids = 0;
		const prepared: string[] = [];
		const service = store.add(new ParadisBotsService(createParadisBotsFile(userData), createParadisBotItemsFile(userData), store.add(new ParadisHumanAskService()), new NullLogService(), {
			homes, enabled: () => true, uuid: () => `launch${++ids}`, panesFile: createParadisBotPanesFile(userData),
			preparePatrol: async (agent, key, home) => {
				prepared.push(`${key}:${home.files.map(file => file.name).join(',')}`);
				return CLAUDE;
			},
			agentTemplate: id => ({ id, label: id, command: 'claude {prompt}' }),
		}));
		// 会話を開いておく（結び付けが残っていても定期実行は見送らない）
		const chat = await service.requestLaunch('id1', 'chat');
		assert.ok(chat.ok && service.reportLaunch(chat.value.launchId, 'pane-chat'));
		const gateWithChat = service.taskGateState('id1', 'web');
		const web = await service.requestLaunch('id1', 'task', { task: 'web' });
		assert.ok(web.ok);
		const gateLaunching = service.taskGateState('id1', 'web');
		const second = await service.requestLaunch('id1', 'task', { task: 'readWeb' });
		await service.cancelLaunch(web.value.launchId);
		const readWeb = await service.requestLaunch('id1', 'task', { task: 'readWeb' });
		assert.ok(readWeb.ok);
		await service.cancelLaunch(readWeb.value.launchId);
		const bot = await service.requestLaunch('id1', 'task', { task: 'bot' });
		assert.ok(bot.ok);
		await service.cancelLaunch(bot.value.launchId);
		const noTools = await service.requestLaunch('id1', 'task');
		const flags = web.value.extraFlags as readonly string[];
		assert.deepStrictEqual({
			gateWithChat, gateLaunching,
			second: !second.ok && second.code,
			web: [web.value.purpose, web.value.permissionId, web.value.resumed, flags.includes('--resume'), web.value.cwd],
			readWeb: [readWeb.value.cwd, (readWeb.value.extraFlags as readonly string[]).includes('--resume')],
			bot: [bot.value.purpose, bot.value.permissionId, bot.value.resumed, bot.value.cwd.startsWith(root)],
			noTools: !noTools.ok && noTools.code,
			prepared,
		}, {
			gateWithChat: 'ok',
			gateLaunching: 'busy',
			second: 'task_busy',
			web: ['task', undefined, undefined, false, '/data/runs/b-task'],
			readWeb: ['/data/runs/b-task', false],
			bot: ['task', 'skip-permissions', undefined, true],
			noTools: 'invalid',
			// Web だけは指示文（記憶を含む）を写さず、読む＋Web は写す。作業フォルダは見回りとは別の鍵
			prepared: ['id1-task:', 'id1-task:AGENTS.md,SOUL.md,MEMORY.md'],
		});
	});

	test('Codex の Bot は「Web だけ」で起動しない（読むコマンドで手元を読めるため）', async () => {
		const userData = join(root, '..', 'userData');
		const service = store.add(new ParadisBotsService(createParadisBotsFile(userData), createParadisBotItemsFile(userData), store.add(new ParadisHumanAskService()), new NullLogService(), {
			homes, enabled: () => true, preparePatrol: async () => CLAUDE,
		}));
		const created = await service.createBot({ name: 'C', agent: 'codex' });
		assert.ok(created.ok);
		const web = await service.requestLaunch(created.value.id, 'task', { task: 'web' });
		assert.deepStrictEqual([!web.ok && web.code, service.taskGateState(created.value.id, 'web'), service.taskGateState(created.value.id, 'readWeb')], ['unsupported', 'unsupported', 'ok']);
	});

	test('制限した段のペインは見回りと同じく読む道具だけを通し、印は台帳に残って起動し直しても戻る。Bot の権限の段は絞らない', async () => {
		const userData = join(root, '..', 'userData');
		const service = store.add(new ParadisBotsService(createParadisBotsFile(userData), createParadisBotItemsFile(userData), store.add(new ParadisHumanAskService()), new NullLogService(), {
			homes, enabled: () => true, preparePatrol: async () => CLAUDE,
		}));
		const created = await service.createBot({ name: '天気係', agent: 'claude' });
		assert.ok(created.ok);
		const limited = await service.requestLaunch(created.value.id, 'task', { task: 'readWeb' });
		assert.ok(limited.ok && service.reportLaunch(limited.value.launchId, 'pane-limited'));
		const refusal = paradisBotPatrolToolRefusal(service);
		const limitedAnswers = [await refusal('pane-limited', 'get_text'), (await refusal('pane-limited', 'click_by'))?.slice(0, 40), service.isReadOnlyPane('pane-limited')];
		service.releasePane('pane-limited');
		const full = await service.requestLaunch(created.value.id, 'task', { task: 'bot' });
		assert.ok(full.ok && service.reportLaunch(full.value.launchId, 'pane-full'));
		const fullAnswers = [await refusal('pane-full', 'click_by'), service.isReadOnlyPane('pane-full')];
		// 台帳に残る印（shared process を起動し直した後、hook で現れたペインに戻す）
		const before = new ParadisBotPanes();
		before.issue('l1', created.value.id, 'task', 1, 'claude', false, true);
		before.report('l1', 'pane-restart', 2);
		const after = new ParadisBotPanes();
		after.loadRemembered(before.rememberedPanes());
		after.restore('pane-restart', () => true, 3);
		assert.deepStrictEqual({ limitedAnswers, fullAnswers, saved: before.rememberedPanes().map(record => [record.purpose, record.limited]), restored: after.isLimited('pane-restart') }, {
			limitedAnswers: [undefined, 'This is a scheduled task that your owner', true],
			fullAnswers: [undefined, false],
			saved: [['task', true]],
			restored: true,
		});
	});
});
