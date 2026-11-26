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
import { ParadisBotHomeError, ParadisBotHomes, PARADIS_BOT_HOME_FILE_LIMIT } from '../../node/paradisBotHomes.js';
import { ParadisBotsChannel } from '../../node/paradisBotsChannel.js';
import { ParadisBotsService } from '../../node/paradisBotsService.js';
import { createParadisBotItemsFile, createParadisBotsFile } from '../../node/paradisBotsStore.js';

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
				await code(() => homes.write(BOT, 'memory/big.md', 'x'.repeat(PARADIS_BOT_HOME_FILE_LIMIT + 1))),
				await code(() => homes.write(BOT, 'memory/deep/note.md', 'x')),
			],
			outsideUntouched: [(await fs.readdir(outside)).sort(), await fs.readFile(join(outside, 'secret.txt'), 'utf8')],
			badFolder: await code(() => homes.ensure({ id: 'x', name: 'x', folder: '../escape' })),
		}, {
			read: ['outside', 'outside', 'outside', 'outside', 'outside', 'outside', 'ok'],
			write: ['outside', 'outside', 'outside', 'outside', 'reserved', 'too_large', 'ok'],
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
		await channel.call('window:1', 'updateBot', [second.value.id, { paused: true }]);
		assert.deepStrictEqual({
			folders: [first.value.folder, second.value.folder],
			memory,
			soul: await service.readHomeFile(second.value.id, 'SOUL.md'),
			launch: { ...launch.value, launchId: typeof launch.value.launchId },
			bound: [forged, reported, again, service.botOfPane('pane-1')?.name, service.botOfPane('pane-2')?.name, activity],
			stops: [stopped, stops],
			paused: await channel.call('window:1', 'requestLaunch', [second.value.id, 'chat']),
			outside: await channel.call('window:1', 'writeHomeFile', [second.value.id, '../../escape.md', 'x']),
			badArgs: [await channel.call('window:1', 'requestLaunch', [second.value.id, 'root']), await channel.call('window:1', 'ownerSetStatus', ['uid', 'waiting']), await channel.call('window:1', 'createBot', ['x'])],
			// Bot の名義の書き込みは、チャネルには無い
			botWrites: await Promise.all(['botAddItem', 'botUpdateItem', 'issueLaunch', 'releasePane'].map(command => channel.call('window:1', command, ['id3', { title: 'x' }]).then(() => 'reachable', () => 'not found'))),
		}, {
			folders: ['bot', 'bot-2'],
			memory: { ok: true, value: '# Memory\n\nOne line per fact, each starting with its date (YYYY-MM-DD). Details go in memory/<topic>.md. No secrets.\n' },
			soul: { ok: true, value: 'レビューをする係\n' },
			launch: { launchId: 'string', botId: 'id2', purpose: 'chat', cwd: join(root, 'bot-2'), name: 'レビュー係', agent: 'codex' },
			bound: [false, true, false, 'レビュー係', undefined, 'idle'],
			stops: [true, ['id1', 'id2']],
			paused: { ok: false, code: 'paused', message: 'The bot is paused.' },
			outside: { ok: false, code: 'outside', message: 'The path must be a relative path inside the bot\'s home folder.' },
			badArgs: [{ ok: false, code: 'invalid_argument', message: 'The arguments are not valid.' }, { ok: false, code: 'invalid_argument', message: 'The arguments are not valid.' }, { ok: false, code: 'invalid_argument', message: 'The arguments are not valid.' }],
			botWrites: ['not found', 'not found', 'not found', 'not found'],
		});
	});
});
