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
import { EMPTY_PARADIS_BOT_ITEMS_STATE, paradisBotItemAdd } from '../../common/paradisBotItems.js';
import { EMPTY_PARADIS_BOTS_STATE, paradisBotCreate } from '../../common/paradisBots.js';
import { createParadisBotItemsFile, createParadisBotPanesFile, createParadisBotsFile, paradisBotsDataFolder } from '../../node/paradisBotsStore.js';

suite('Paradis bots store', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let userData: string;

	setup(async () => {
		userData = await fs.mkdtemp(join(tmpdir(), 'paradis-bots-'));
	});

	teardown(async () => {
		await fs.rm(userData, { recursive: true, force: true });
	});

	test('無ければ空、保存して読み戻すと同じ中身', async () => {
		const bots = createParadisBotsFile(userData);
		const items = createParadisBotItemsFile(userData);
		const empty = [await bots.read(), await items.read()];
		const created = paradisBotCreate(EMPTY_PARADIS_BOTS_STATE, { id: 'b1', name: 'リリース係', agent: 'claude' }, 1000);
		const added = paradisBotItemAdd(EMPTY_PARADIS_BOT_ITEMS_STATE, { uid: 'u1', botId: 'b1', title: '題' }, 1000);
		assert.ok(created.ok && added.ok);
		await bots.write(created.state);
		await items.write(added.state);
		const folder = paradisBotsDataFolder(userData);
		const modes = process.platform === 'win32' ? [] : [(await fs.stat(folder)).mode & 0o777, (await fs.stat(join(folder, 'bots.json'))).mode & 0o777];
		assert.deepStrictEqual({ empty, read: [await createParadisBotsFile(userData).read(), await createParadisBotItemsFile(userData).read()], modes }, {
			empty: [{ state: EMPTY_PARADIS_BOTS_STATE }, { state: EMPTY_PARADIS_BOT_ITEMS_STATE }],
			read: [{ state: created.state }, { state: added.state }],
			modes: process.platform === 'win32' ? [] : [0o700, 0o600],
		});
	});

	test('壊れたファイルは別名へ退避してから空で始める（中身を消さない）', async () => {
		const folder = paradisBotsDataFolder(userData);
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(join(folder, 'bots.json'), '{ "version": 1, "bots": [');
		await fs.writeFile(join(folder, 'items.json'), '{ "items": "形が違う" }');
		const bots = await createParadisBotsFile(userData, () => 42).read();
		const items = await createParadisBotItemsFile(userData, () => 43).read();
		assert.deepStrictEqual({
			bots, items,
			files: (await fs.readdir(folder)).sort(),
			kept: await fs.readFile(join(folder, 'bots.json.broken-42'), 'utf8'),
		}, {
			bots: { state: EMPTY_PARADIS_BOTS_STATE, quarantined: join(folder, 'bots.json.broken-42') },
			items: { state: EMPTY_PARADIS_BOT_ITEMS_STATE, quarantined: join(folder, 'items.json.broken-43') },
			files: ['bots.json.broken-42', 'items.json.broken-43'],
			kept: '{ "version": 1, "bots": [',
		});
	});

	test('新しい版のファイルは読むだけで、書き込みを断る', async () => {
		const folder = paradisBotsDataFolder(userData);
		await fs.mkdir(folder, { recursive: true });
		const newer = JSON.stringify({ version: 2, nextNumber: 5, items: [], added: 'by a newer Para Code' });
		await fs.writeFile(join(folder, 'items.json'), newer);
		const file = createParadisBotItemsFile(userData);
		const loaded = await file.read();
		await assert.rejects(() => file.write(loaded.state), /newer Para Code/);
		assert.deepStrictEqual([loaded, await fs.readFile(join(folder, 'items.json'), 'utf8')], [{ state: { version: 2, nextNumber: 5, items: [] } }, newer]);
	});

	test('知らない状態の項目は、書き戻しても読んだ値のまま残る', async () => {
		const folder = paradisBotsDataFolder(userData);
		await fs.mkdir(folder, { recursive: true });
		const waiting = { uid: 'u1', number: 1, botId: 'b1', title: '待ち', status: 'waiting', wait: { text: 'CI', at: 5 }, links: [], events: [], lastEventId: 0, lastActivityAt: 1, createdAt: 1, updatedAt: 1 };
		await fs.writeFile(join(folder, 'items.json'), JSON.stringify({ version: 1, nextNumber: 2, items: [waiting] }));
		const file = createParadisBotItemsFile(userData);
		const added = paradisBotItemAdd((await file.read()).state, { uid: 'u2', botId: 'b1', title: '次' }, 1000);
		assert.ok(added.ok);
		await file.write(added.state);
		const written = JSON.parse(await fs.readFile(join(folder, 'items.json'), 'utf8'));
		assert.deepStrictEqual([written.nextNumber, written.items[0], written.items[1].number], [3, waiting, 2]);
	});

	test('ペインとの結び付け: 形の違う 1 件だけ捨て、新しい版は読まずに書き込みを断る', async () => {
		const folder = paradisBotsDataFolder(userData);
		await fs.mkdir(folder, { recursive: true });
		const hash = '1b780c2005e24c7adab28a00c48fd437c37580c140f7b9585d87f54e78b59cff';
		await fs.writeFile(join(folder, 'panes.json'), JSON.stringify({ version: 1, panes: [{ hash, botId: 'b1', purpose: 'chat', boundAt: 1000 }, { hash: 'pane-A', botId: 'b1', purpose: 'chat', boundAt: 1000 }, { hash, botId: 'b1', purpose: 'root', boundAt: 1000 }] }));
		const current = await createParadisBotPanesFile(userData).read();
		await fs.writeFile(join(folder, 'panes.json'), JSON.stringify({ version: 2, panes: [{ hash, botId: 'b1', purpose: 'chat', boundAt: 1000 }] }));
		const newer = await createParadisBotPanesFile(userData).read();
		const refused = await createParadisBotPanesFile(userData).write(newer.state).then(() => 'written', () => 'refused');
		assert.deepStrictEqual({ current, newer, refused }, {
			current: { state: { version: 1, panes: [{ hash, botId: 'b1', purpose: 'chat', boundAt: 1000 }] } },
			newer: { state: { version: 2, panes: [] } },
			refused: 'refused',
		});
	});

	test('フォルダを作れなかった書き込みの後も、次の書き込みでやり直す', async () => {
		// 台帳のフォルダの親（paradis）の場所にファイルがあると、フォルダを作れない
		await fs.writeFile(join(userData, 'paradis'), 'x');
		const bots = createParadisBotsFile(userData);
		const created = paradisBotCreate(EMPTY_PARADIS_BOTS_STATE, { id: 'b1', name: 'A', agent: 'claude' }, 1000);
		assert.ok(created.ok);
		const first = await bots.write(created.state).then(() => 'written', () => 'failed');
		await fs.rm(join(userData, 'paradis'));
		const second = await bots.write(created.state).then(() => 'written', () => 'failed');
		assert.deepStrictEqual({ first, second, read: (await bots.read()).state.bots.map(bot => bot.id) }, { first: 'failed', second: 'written', read: ['b1'] });
	});
});
