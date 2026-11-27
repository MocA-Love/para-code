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
import { paradisPrepareBotTaskLaunch } from '../../node/paradisBotPatrolLaunch.js';
import { ParadisBotsService } from '../../node/paradisBotsService.js';
import { createParadisBotItemsFile, createParadisBotsFile } from '../../node/paradisBotsStore.js';

const READ_ONLY = new Set(['take_snapshot', 'get_text']);

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

	test('段ごとの起動の引数: 読むだけ・読む＋Web（Claude Code は Web の道具を --tools と --allowedTools の両方に足し、Codex は --search）', () => {
		const claude = { agent: 'claude', settingsFile: '/d/s.json', mcpConfigFile: '/d/m.json' } as const;
		const codex = { agent: 'codex', disabledServers: [{ name: 'gh', transport: 'url' }] } as const;
		assert.deepStrictEqual({
			claudeRead: paradisBotTaskLaunchArgs(claude, 'read', READ_ONLY),
			claudeWeb: paradisBotTaskLaunchArgs(claude, 'web', READ_ONLY),
			codexRead: paradisBotTaskLaunchArgs(codex, 'read', READ_ONLY).slice(0, 5),
			codexWeb: paradisBotTaskLaunchArgs(codex, 'web', READ_ONLY).slice(0, 6),
		}, {
			claudeRead: [
				'--permission-mode', 'dontAsk', '--settings=/d/s.json', '--setting-sources=user', '--strict-mcp-config', '--mcp-config=/d/m.json',
				'--tools=Read,Grep,Glob',
				'--allowedTools=mcp__para-browser__bot_item_list,mcp__para-browser__bot_item_show,mcp__para-browser__bot_suggest,mcp__para-browser__bot_github_news,mcp__para-browser__bot_inbox,mcp__para-browser__take_snapshot,mcp__para-browser__get_text',
			],
			claudeWeb: [
				'--permission-mode', 'dontAsk', '--settings=/d/s.json', '--setting-sources=user', '--strict-mcp-config', '--mcp-config=/d/m.json',
				'--tools=Read,Grep,Glob,WebFetch,WebSearch',
				'--allowedTools=WebFetch,WebSearch,mcp__para-browser__bot_item_list,mcp__para-browser__bot_item_show,mcp__para-browser__bot_suggest,mcp__para-browser__bot_github_news,mcp__para-browser__bot_inbox,mcp__para-browser__take_snapshot,mcp__para-browser__get_text',
			],
			codexRead: ['-s', 'read-only', '-a', 'never', '-c'],
			codexWeb: ['-s', 'read-only', '-a', 'never', '--search', '-c'],
		});
	});

	test('用意: 専用フォルダにエージェントが読む設定があれば断り、Claude Code は制限の設定ファイルを書く', async () => {
		const home = join(root, 'bot');
		await fs.mkdir(join(home, '.claude', 'skills'), { recursive: true });
		const environment = { folder: join(root, '..', 'data'), runsFolder: join(root, '..', 'runs'), stopFolder: root, gatewayPort: async () => 4567, codexConfigFiles: () => [] };
		const ok = await paradisPrepareBotTaskLaunch(environment, 'claude', 'b1', home);
		await fs.writeFile(join(home, 'AGENTS.override.md'), 'x');
		const refused = await paradisPrepareBotTaskLaunch(environment, 'codex', 'b1', home);
		assert.deepStrictEqual({
			ok: typeof ok === 'string' ? ok : [ok.agent, JSON.parse(await fs.readFile((ok as { settingsFile: string }).settingsFile, 'utf8'))],
			refused: typeof refused === 'string' && refused.includes('AGENTS.override.md'),
		}, {
			ok: ['claude', { permissions: { disableBypassPermissionsMode: 'disable' } }],
			refused: true,
		});
	});

	test('起こし方: 制限した段は制限の引数と続ける会話・権限の設定を使わない。Bot の権限は会話と同じ。会話のペインがあれば門が busy', async () => {
		const userData = join(root, '..', 'userData');
		const service = store.add(new ParadisBotsService(createParadisBotsFile(userData), createParadisBotItemsFile(userData), store.add(new ParadisHumanAskService()), new NullLogService(), {
			homes, enabled: () => true,
			prepareTask: async agent => agent === 'claude' ? { agent, settingsFile: '/d/s.json', mcpConfigFile: '/d/m.json' } : 'no',
			agentTemplate: id => ({ id, label: id, command: 'claude {prompt}' }),
		}));
		const created = await service.createBot({ name: '天気係', agent: 'claude', permissionId: 'skip-permissions' });
		assert.ok(created.ok);
		const id = created.value.id;
		const gateBefore = service.taskGateState(id, 'web');
		const web = await service.requestLaunch(id, 'chat', { task: 'web' });
		assert.ok(web.ok);
		// 起動中の会話がある間は、次の定期実行も会話も起こさない
		const gateLaunching = service.taskGateState(id, 'web');
		const again = await service.requestLaunch(id, 'chat', { task: 'bot' });
		await service.cancelLaunch(web.value.launchId);
		const bot = await service.requestLaunch(id, 'chat', { task: 'bot' });
		assert.ok(bot.ok);
		await service.cancelLaunch(bot.value.launchId);
		const patrolOption = await service.requestLaunch(id, 'patrol', { task: 'web' });
		if (patrolOption.ok) {
			await service.cancelLaunch(patrolOption.value.launchId);
		}
		assert.deepStrictEqual({
			gateBefore,
			gateLaunching,
			again: !again.ok && again.code,
			web: [web.value.permissionId, web.value.task, Array.isArray(web.value.extraFlags) && (web.value.extraFlags as string[]).includes('--tools=Read,Grep,Glob,WebFetch,WebSearch'), web.value.cwd.startsWith(root)],
			bot: [bot.value.permissionId, bot.value.task, bot.value.extraFlags],
			// 見回りの口では段を受けない（見回りのまま）
			patrolOption: patrolOption.ok ? patrolOption.value.task : patrolOption.code,
		}, {
			gateBefore: 'ok',
			gateLaunching: 'busy',
			again: 'launching',
			web: [undefined, 'web', true, true],
			bot: ['skip-permissions', 'bot', undefined],
			patrolOption: 'patrol_unavailable',
		});
	});
});
