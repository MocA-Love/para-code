/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisHumanAskService } from '../../../humanAsk/node/paradisHumanAskChannel.js';
import { PARADIS_BOT_CLAUDE_BODY, PARADIS_BOT_GENERATED_BEGIN, PARADIS_BOT_GENERATED_END, paradisBotInstructions, paradisBotOwnerFile, paradisMergeBotGeneratedFile, paradisParseBotOwnerFile } from '../../common/paradisBotHome.js';
import { IParadisBotLaunch } from '../../common/paradisBotsApi.js';
import { PARADIS_READ_ONLY_MCP_TOOL_NAMES } from '../../../agentBrowser/common/paradisMcpReadOnlyTools.js';
import { paradisBotPatrolLaunchFlags } from '../../common/paradisBotTools.js';
import { ParadisBotHomeError, ParadisBotHomes, PARADIS_BOT_HOME_FILE_LIMIT } from '../../node/paradisBotHomes.js';
import { ParadisBotsChannel } from '../../node/paradisBotsChannel.js';
import { ParadisBotsService } from '../../node/paradisBotsService.js';
import { ParadisBotMemorySnapshots } from '../../node/paradisBotMemorySnapshots.js';
import { createParadisBotItemsFile, createParadisBotsFile, createParadisBotSuggestionsFile } from '../../node/paradisBotsStore.js';

const BOT = { id: 'b1', name: 'リリース係', folder: 'bot' };
const block = (body: string) => `${PARADIS_BOT_GENERATED_BEGIN}\n${body}\n${PARADIS_BOT_GENERATED_END}`;

async function code(operation: () => Promise<unknown>): Promise<string> {
	try {
		await operation();
		return 'ok';
	} catch (error) {
		return error instanceof ParadisBotHomeError ? error.code : `threw ${String(error)}`;
	}
}

suite('Paradis bot homes', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let homes: ParadisBotHomes;

	setup(async () => {
		// macOS の /tmp は symlink なので、実際の場所にしておく
		root = join(await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-bot-homes-'))), 'bots');
		homes = new ParadisBotHomes(root);
	});

	teardown(async () => {
		await fs.rm(join(root, '..'), { recursive: true, force: true });
	});

	test('生成の範囲だけを書き直し、印の外に書いたものは残す', () => {
		const first = paradisMergeBotGeneratedFile(undefined, '古い指示');
		const edited = `# 自分のメモ\n\n${first}\n## 追記\n- 毎朝 9 時に報告する\n`;
		assert.deepStrictEqual([
			first,
			paradisMergeBotGeneratedFile('  \n', '指示'),
			paradisMergeBotGeneratedFile(edited, '新しい指示\n'),
			// 利用者が自分で書いたファイル（印なし）は、先頭に範囲を足して中身を残す
			paradisMergeBotGeneratedFile('自分で書いた AGENTS.md\n', '指示'),
			// 前の版の印（後ろの説明の文が違う）も見つける
			paradisMergeBotGeneratedFile(`<!-- PARA-CODE-BOT:BEGIN (old wording) -->\n古い\n${PARADIS_BOT_GENERATED_END}\n後ろ\n`, '指示'),
			paradisMergeBotGeneratedFile(first, '古い指示') === first,
		], [
			`${block('古い指示')}\n`,
			`${block('指示')}\n`,
			`# 自分のメモ\n\n${block('新しい指示')}\n\n## 追記\n- 毎朝 9 時に報告する\n`,
			`${block('指示')}\n\n自分で書いた AGENTS.md\n`,
			`${block('指示')}\n後ろ\n`,
			true,
		]);
	});

	test('名前に印の文字列を含めても、何度書き直しても本文の長さが変わらない', async () => {
		const named = { ...BOT, name: 'x<!-- PARA-CODE-BOT:END -->y' };
		const lengths: number[] = [];
		for (let i = 0; i < 4; i++) {
			await homes.ensure(named);
			lengths.push((await fs.readFile(join(root, 'bot', 'AGENTS.md'), 'utf8')).length);
		}
		const agents = await fs.readFile(join(root, 'bot', 'AGENTS.md'), 'utf8');
		assert.deepStrictEqual({
			stable: lengths.every(length => length === lengths[0]),
			endMarkers: agents.split(PARADIS_BOT_GENERATED_END).length - 1,
			// 行の途中の印の文字列では範囲を区切らない
			inline: paradisMergeBotGeneratedFile(`前 ${PARADIS_BOT_GENERATED_END}\n${block('古い')}\n後ろ\n`, '新しい'),
		}, {
			stable: true,
			endMarkers: 1,
			inline: `前 ${PARADIS_BOT_GENERATED_END}\n${block('新しい')}\n後ろ\n`,
		});
	});

	test('持ち主の印の行き来', () => {
		assert.deepStrictEqual(
			[paradisParseBotOwnerFile(paradisBotOwnerFile({ id: 'b1' })), paradisParseBotOwnerFile('{}'), paradisParseBotOwnerFile('not json'), paradisParseBotOwnerFile('{"id":7}')],
			['b1', undefined, undefined, undefined]);
	});

	test('専用フォルダを整える: 種は無いときだけ、指示文は範囲だけ書き直す', async () => {
		const home = await homes.ensure(BOT, 'PR を見て危ない変更を挙げる係');
		const files = (await fs.readdir(home)).sort();
		const soul = await homes.read(BOT, 'SOUL.md');
		// 利用者と Bot が書き足す
		await homes.write(BOT, 'SOUL.md', '# 書き直した人格\n');
		await homes.write(BOT, 'memory/review.md', '- 2026-11-27 レビューは日本語で\n');
		await fs.writeFile(join(home, 'AGENTS.md'), `${await fs.readFile(join(home, 'AGENTS.md'), 'utf8')}\n## 自分のメモ\n- 触らないで\n`);
		await homes.ensure({ ...BOT, name: '改名した係' }, '使われない種');
		const agents = await fs.readFile(join(home, 'AGENTS.md'), 'utf8');
		assert.deepStrictEqual({
			home, files, soul,
			claude: await homes.read(BOT, 'CLAUDE.md'),
			soulAfter: await homes.read(BOT, 'SOUL.md'),
			memoryFile: await homes.read(BOT, 'memory/review.md'),
			agents: agents === `${block(paradisBotInstructions({ name: '改名した係' }))}\n\n## 自分のメモ\n- 触らないで\n`,
			namesTheBot: agents.includes('You are 改名した係, a bot that runs in Para Code.') && agents.includes('bot_item_update'),
			missing: await homes.read(BOT, 'memory/none.md'),
			existing: await homes.existingFolders(),
		}, {
			home: join(root, 'bot'),
			files: ['.para-bot.json', 'AGENTS.md', 'CLAUDE.md', 'MEMORY.md', 'SOUL.md', 'memory'],
			soul: 'PR を見て危ない変更を挙げる係\n',
			claude: `${block(PARADIS_BOT_CLAUDE_BODY)}\n`,
			soulAfter: '# 書き直した人格\n',
			memoryFile: '- 2026-11-27 レビューは日本語で\n',
			agents: true,
			namesTheBot: true,
			missing: undefined,
			existing: ['bot'],
		});
	});

	test('フォルダの外のパスを断る（字面・symlink・持ち主の印・大きすぎる文）', async () => {
		const home = await homes.ensure(BOT);
		const outside = join(root, '..', 'outside');
		await fs.mkdir(outside);
		await fs.writeFile(join(outside, 'secret.txt'), '外の秘密');
		await fs.symlink(outside, join(home, 'link'));
		await fs.symlink(join(outside, 'secret.txt'), join(home, 'file-link.md'));
		assert.deepStrictEqual({
			read: [
				await code(() => homes.read(BOT, '../outside/secret.txt')),
				await code(() => homes.read(BOT, join(outside, 'secret.txt'))),
				await code(() => homes.read(BOT, 'link/secret.txt')),
				await code(() => homes.read(BOT, 'file-link.md')),
				await code(() => homes.read(BOT, '')),
				await code(() => homes.read(BOT, 7)),
				await code(() => homes.read(BOT, 'MEMORY.md')),
			],
			write: [
				await code(() => homes.write(BOT, '../outside/new.txt', 'x')),
				await code(() => homes.write(BOT, 'link/new.txt', 'x')),
				await code(() => homes.write(BOT, 'link/sub/new.txt', 'x')),
				await code(() => homes.write(BOT, 'file-link.md', 'x')),
				await code(() => homes.write(BOT, '.para-bot.json', '{"id":"other"}')),
				await code(() => homes.write(BOT, '.Para-Bot.json', '{"id":"other"}')),
				await code(() => homes.write(BOT, 'memory/big.md', 'x'.repeat(PARADIS_BOT_HOME_FILE_LIMIT + 1))),
				await code(() => homes.write(BOT, 'memory/deep/note.md', 'x')),
			],
			outsideUntouched: [(await fs.readdir(outside)).sort(), await fs.readFile(join(outside, 'secret.txt'), 'utf8')],
			badFolder: await code(() => homes.ensure({ id: 'x', name: 'x', folder: '../escape' })),
		}, {
			read: ['outside', 'outside', 'outside', 'outside', 'outside', 'outside', 'ok'],
			write: ['outside', 'outside', 'outside', 'outside', 'reserved', 'reserved', 'too_large', 'ok'],
			outsideUntouched: [['secret.txt'], '外の秘密'],
			badFolder: 'outside',
		});
	});

	test('ほかの Bot のフォルダ・印の無い中身のあるフォルダは使わない', async () => {
		await homes.ensure(BOT);
		await fs.mkdir(join(root, 'manual'), { recursive: true });
		await fs.writeFile(join(root, 'manual', 'SOUL.md'), '利用者が置いたもの');
		assert.deepStrictEqual([
			await code(() => homes.ensure({ id: 'b2', name: '別の係', folder: 'bot' })),
			await code(() => homes.ensure({ id: 'b3', name: '手で作った', folder: 'manual' })),
			await code(() => homes.ensure(BOT)),
			await fs.readFile(join(root, 'manual', 'SOUL.md'), 'utf8'),
		], ['not_owner', 'not_owner', 'ok', '利用者が置いたもの']);
	});

	test('サービス: 消した Bot のフォルダを別の Bot が引き継がない。起動の依頼はフォルダを返し、報告で結び付く', async () => {
		const userData = join(root, '..', 'userData');
		const humanAsk = store.add(new ParadisHumanAskService());
		let ids = 0;
		const service = store.add(new ParadisBotsService(createParadisBotsFile(userData), createParadisBotItemsFile(userData), humanAsk, new NullLogService(), { homes, uuid: () => `id${++ids}` }));
		const channel = new ParadisBotsChannel(service);
		const stops: string[] = [];
		store.add((channel.listen<{ botId: string }>('window:1', 'onDidRequestStop'))(event => stops.push(event.botId)));

		const first = await service.createBot({ name: 'リリース係', agent: 'claude' });
		assert.ok(first.ok);
		await service.writeHomeFile(first.value.id, 'MEMORY.md', '- 2026-11-27 リリース係だけが知っていること\n');
		await service.removeBot(first.value.id);
		// 日本語の名前はどれもフォルダ名が `bot` になる。前の Bot のフォルダは残っているので、別の名前を予約する
		const second = await channel.call<{ ok: true; value: { id: string; folder: string } }>('window:1', 'createBot', [{ name: 'レビュー係', agent: 'codex' }, 'レビューをする係']);
		assert.ok(second.ok);
		const memory = await channel.call('window:1', 'readHomeFile', [second.value.id, 'MEMORY.md']);
		const launch = await channel.call<{ ok: true; value: IParadisBotLaunch }>('window:1', 'requestLaunch', [second.value.id]);
		assert.ok(launch.ok);
		const forged = await channel.call('window:1', 'reportLaunch', ['not-issued', 'pane-x']);
		const reported = await channel.call('window:1', 'reportLaunch', [launch.value.launchId, 'pane-1']);
		const again = await channel.call('window:1', 'reportLaunch', [launch.value.launchId, 'pane-2']);
		const activity = service.getSnapshot().bots[0].activity;
		const stopped = await channel.call('window:1', 'requestStop', [second.value.id]);
		await channel.call('window:1', 'updateBot', [second.value.id, { paused: true, pinned: true, faceShape: 'hex' }]);
		const badPin = await channel.call('window:1', 'updateBot', [second.value.id, { pinned: 'yes' }]);
		const badFace = await channel.call('window:1', 'updateBot', [second.value.id, { faceColor: '#3b82f6' }]);
		assert.deepStrictEqual({
			folders: [first.value.folder, second.value.folder],
			memory,
			soul: await service.readHomeFile(second.value.id, 'SOUL.md'),
			launch: { ...launch.value, launchId: typeof launch.value.launchId },
			bound: [forged, reported, again, service.botOfPane('pane-1')?.name, service.botOfPane('pane-2')?.name, activity],
			stops: [stopped, stops],
			paused: await channel.call('window:1', 'requestLaunch', [second.value.id, 'chat']),
			// ピン留めと顔はチャネルから変えられ、一覧の値に載る（色は選べる名前だけ）
			pinned: [service.getSnapshot().bots.map(bot => [bot.pinned, bot.faceColor, bot.faceShape]), badPin, badFace],
			outside: await channel.call('window:1', 'writeHomeFile', [second.value.id, '../../escape.md', 'x']),
			badArgs: [await channel.call('window:1', 'requestLaunch', [second.value.id, 'root']), await channel.call('window:1', 'ownerSetStatus', ['uid', 'blocked']), await channel.call('window:1', 'createBot', ['x'])],
			// Bot の名義の書き込みは、チャネルには無い
			botWrites: await Promise.all(['botAddItem', 'botUpdateItem', 'issueLaunch', 'releasePane'].map(command => channel.call('window:1', command, ['id3', { title: 'x' }]).then(() => 'reachable', () => 'not found'))),
		}, {
			folders: ['bot', 'bot-2'],
			memory: { ok: true, value: '# 記憶\n\n1 行に 1 つの事実を書き、行の頭に日付（YYYY-MM-DD）を付けます。詳しいことは memory/<話題>.md に書きます。秘密は書きません。\n' },
			soul: { ok: true, value: 'レビューをする係\n' },
			launch: {
				launchId: 'string', botId: 'id2', purpose: 'chat', cwd: join(root, 'bot-2'), name: 'レビュー係', agent: 'codex',
				// Codex の Bot だけ、道具の許可をこの起動の引数で渡す（利用者の config.toml には書かない）
				extraFlags: '-c \'mcp_servers.para-browser.tools.bot_item_list.approval_mode=approve\' -c \'mcp_servers.para-browser.tools.bot_item_show.approval_mode=approve\' -c \'mcp_servers.para-browser.tools.bot_item_add.approval_mode=approve\' -c \'mcp_servers.para-browser.tools.bot_item_update.approval_mode=approve\' -c \'mcp_servers.para-browser.tools.bot_suggest.approval_mode=approve\'',
			},
			bound: [false, true, false, 'レビュー係', undefined, 'idle'],
			stops: [true, ['id1', 'id2']],
			paused: { ok: false, code: 'paused', message: 'The bot is paused.' },
			pinned: [[[true, 'teal', 'hex']], { ok: false, code: 'invalid_argument', message: 'The change to the bot is not valid.' }, { ok: false, code: 'invalid_argument', message: 'The change to the bot is not valid.' }],
			outside: { ok: false, code: 'outside', message: 'The path must be a relative path inside the bot\'s home folder.' },
			badArgs: [{ ok: false, code: 'invalid_argument', message: 'The arguments are not valid.' }, { ok: false, code: 'invalid_argument', message: 'The arguments are not valid.' }, { ok: false, code: 'invalid_argument', message: 'The arguments are not valid.' }],
			botWrites: ['not found', 'not found', 'not found', 'not found'],
		});
	});

	test('サービス: 作成の後に他人のフォルダができていたら、別の名前を取り直す（起動できない Bot を残さない）', async () => {
		const userData = join(root, '..', 'userData');
		// 一覧を読んだ後に `bot` ができた（読み終えた時点では無かった）ことにする
		class LateFolderHomes extends ParadisBotHomes {
			override async existingFolders(): Promise<string[]> {
				const names = await super.existingFolders();
				await fs.mkdir(join(root, 'bot'), { recursive: true });
				await fs.writeFile(join(root, 'bot', 'notes.txt'), '利用者のメモ');
				return names;
			}
		}
		await fs.mkdir(join(root, 'Report'), { recursive: true });
		let ids = 0;
		const service = store.add(new ParadisBotsService(createParadisBotsFile(userData), createParadisBotItemsFile(userData), store.add(new ParadisHumanAskService()), new NullLogService(), { homes: new LateFolderHomes(root), uuid: () => `id${++ids}` }));
		const created = await service.createBot({ name: 'リリース係', agent: 'claude' });
		const report = await service.createBot({ name: 'report', agent: 'codex' });
		assert.deepStrictEqual({
			folders: [created.ok && created.value.folder, report.ok && report.value.folder],
			launch: (await service.requestLaunch('id1', 'chat')).ok,
			notes: await fs.readFile(join(root, 'bot', 'notes.txt'), 'utf8'),
			existing: (await homes.existingFolders()).sort(),
		}, {
			folders: ['bot-2', 'report-2'],
			launch: true,
			notes: '利用者のメモ',
			existing: ['bot', 'bot-2', 'report', 'report-2'],
		});
	});

	test('サービス: 提案は見回りのペインだけが出せ、記憶の整理は写しから取り消せる（写しは専用フォルダの外）', async () => {
		const userData = join(root, '..', 'userData');
		let ids = 0;
		const service = store.add(new ParadisBotsService(createParadisBotsFile(userData), createParadisBotItemsFile(userData), store.add(new ParadisHumanAskService()), new NullLogService(), {
			homes,
			uuid: () => `id${++ids}`,
			suggestionsFile: createParadisBotSuggestionsFile(userData),
			memorySnapshots: new ParadisBotMemorySnapshots(join(userData, 'snapshots'), homes, () => 5000),
		}));
		const created = await service.createBot({ name: 'リリース係', agent: 'claude' });
		assert.ok(created.ok);
		const botId = created.value.id;
		const patrol = service.issueLaunch(botId, 'patrol');
		const chat = service.issueLaunch(botId, 'chat');
		assert.ok(patrol !== undefined && chat !== undefined && service.reportLaunch(patrol, 'pane-p') && service.reportLaunch(chat, 'pane-c'));
		const fromChat = await service.botSuggest(botId, 'pane-c', 'PR の返事', '返事を書いて');
		const fromPatrol = await service.botSuggest(botId, 'pane-p', 'PR の返事', '返事を書いて');
		const open = service.getSnapshot().bots[0].openSuggestions;
		const started = await service.startSuggestion(service.listSuggestions(botId)[0].id);
		service.releasePane('pane-p');

		await service.writeHomeFile(botId, 'MEMORY.md', '- 2026-11-27 古い記憶\n');
		const taken = await service.snapshotMemory(botId);
		await service.writeHomeFile(botId, 'MEMORY.md', '- 整理した記憶\n');
		await service.writeHomeFile(botId, 'memory/release.md', '細かい話\n');
		const undone = await service.undoMemoryTidy(botId);
		assert.deepStrictEqual({
			fromChat: fromChat.ok ? 'ok' : fromChat.code,
			fromPatrol: fromPatrol.ok ? fromPatrol.value.title : fromPatrol.code,
			open,
			started: started.ok ? [started.value.state, started.value.request] : started.code,
			afterStart: service.getSnapshot().bots[0].openSuggestions,
			taken,
			undone,
			memory: await service.readHomeFile(botId, 'MEMORY.md'),
			// 写しは専用フォルダの中に無い
			homeFiles: (await fs.readdir(join(root, created.value.folder))).filter(name => name.endsWith('.json')),
		}, {
			fromChat: 'not_patrol',
			fromPatrol: 'PR の返事',
			open: 1,
			started: ['started', '返事を書いて'],
			afterStart: 0,
			taken: { ok: true, value: { takenAt: 5000, files: 1 } },
			undone: { ok: true, value: { restored: ['MEMORY.md'], added: ['memory/release.md'], takenAt: 5000 } },
			memory: { ok: true, value: '- 2026-11-27 古い記憶\n' },
			homeFiles: ['.para-bot.json'],
		});
	});

	test('人格メモの雛形は日本語（利用者が開いて書き足す）', async () => {
		await homes.ensure(BOT);
		assert.strictEqual(await homes.read(BOT, 'SOUL.md'), '# リリース係\n\n（この Bot が何をするのかを、ここに 1 文で書いてください）\n\n## 仕事の進め方\n\n- （どこを見て、どこへ知らせるか）\n');
	});

	test('見回りの起動: 読むだけの引数で、Bot の権限の設定を使わない。設定がオフ・制限できないエージェントは断る', async () => {
		const userData = join(root, '..', 'userData');
		const settings = { enabled: true };
		let ids = 0;
		const service = store.add(new ParadisBotsService(createParadisBotsFile(userData), createParadisBotItemsFile(userData), store.add(new ParadisHumanAskService()), new NullLogService(), { homes, uuid: () => `id${++ids}`, enabled: () => settings.enabled }));
		const claude = await service.createBot({ name: 'リリース係', agent: 'claude', permissionId: 'skip-permissions' });
		const other = await service.createBot({ name: 'B', agent: 'opencode' });
		assert.ok(claude.ok && other.ok);
		const patrol = await service.requestLaunch(claude.value.id, 'patrol');
		const chat = await service.requestLaunch(claude.value.id, 'chat');
		const unsupported = await service.requestLaunch(other.value.id, 'patrol');
		settings.enabled = false;
		const off = await service.requestLaunch(claude.value.id, 'patrol');
		assert.deepStrictEqual({
			patrol: patrol.ok && [patrol.value.permissionId, patrol.value.extraFlags === paradisBotPatrolLaunchFlags('claude', PARADIS_READ_ONLY_MCP_TOOL_NAMES)],
			chat: chat.ok && chat.value.permissionId,
			unsupported: !unsupported.ok && unsupported.code,
			off: !off.ok && off.code,
		}, { patrol: [undefined, true], chat: 'skip-permissions', unsupported: 'unsupported', off: 'disabled' });
	});
});
