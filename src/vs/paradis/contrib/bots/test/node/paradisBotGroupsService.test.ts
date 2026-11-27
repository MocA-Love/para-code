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
import { EMPTY_PARADIS_BOT_GROUPS_STATE, IParadisBotGroupsState, paradisParseBotGroupsState } from '../../common/paradisBotGroups.js';
import { ParadisBotGroupsChannel } from '../../node/paradisBotGroupsChannel.js';
import { createParadisBotGroupsFile, IParadisBotGroupsFile, ParadisBotGroupsService, paradisBotGroupsMessagePort } from '../../node/paradisBotGroupsService.js';

class MemoryFile implements IParadisBotGroupsFile {
	written: IParadisBotGroupsState[] = [];
	failNext = false;
	constructor(private readonly initial: IParadisBotGroupsState = EMPTY_PARADIS_BOT_GROUPS_STATE) { }
	async read() {
		return { state: this.initial };
	}
	async write(state: IParadisBotGroupsState) {
		if (this.failNext) {
			this.failNext = false;
			throw new Error('disk full');
		}
		this.written.push(state);
	}
}

suite('Paradis bot groups service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function service(file: IParadisBotGroupsFile): ParadisBotGroupsService {
		let id = 0;
		return store.add(new ParadisBotGroupsService(file, new NullLogService(), () => 100, () => `g${++id}`));
	}

	test('作って記録を足し、書けなかった変更は取り消す', async () => {
		const file = new MemoryFile();
		const groups = service(file);
		const created = await groups.createGroup({ name: '班', members: ['a', 'b'] });
		const recorded = await groups.appendRecord('g1', { kind: 'told', from: 'a', to: ['b'], text: '終わった' });
		file.failNext = true;
		const failed = await groups.updateGroup('g1', { name: '別名' });
		assert.deepStrictEqual({
			created: created.ok && created.value.id,
			recorded: recorded.ok && recorded.value.id,
			failed: failed.ok ? 'ok' : failed.code,
			name: groups.getGroup('g1')?.name,
			groupsOfB: groups.groupsOf('b').map(group => group.id),
			groupsOfZ: groups.groupsOf('z').length,
			writes: file.written.length,
		}, { created: 'g1', recorded: 1, failed: 'storage', name: '班', groupsOfB: ['g1'], groupsOfZ: 0, writes: 2 });
	});

	test('伝言の道具の口: 記録の id を文字列で返し、その id で届かなかった理由の印を付ける。印は読み直しても残る', async () => {
		const file = new MemoryFile();
		const groups = service(file);
		await groups.createGroup({ name: '班', members: ['a', 'b'] });
		await groups.createGroup({ name: '別', members: ['a', 'b'] });
		const sent = await groups.appendRecord('g1', { kind: 'sent', from: 'owner', to: ['a'], text: 'どうぞ' });
		const port = paradisBotGroupsMessagePort(groups);
		const told = await port.appendRecord('g1', { kind: 'told', from: 'a', to: 'b', text: '終わった' });
		const refused = await port.appendRecord('g1', { kind: 'told', from: 'a', to: 'z', text: 'x' });
		// 別のグループ・知らない id・数字でない id・あなたの sent の id は何も変えない
		for (const [groupId, recordId] of [['g2', '2'], ['g1', '99'], ['g1', '2.0'], ['g1', '02'], ['g1', 'x'], ['g1', String(sent.ok && sent.value.id)]]) {
			await port.markUndelivered!(groupId, recordId);
		}
		const asked = await port.appendRecord('g1', { kind: 'asked', from: 'b', to: 'a', text: 'どう?' });
		const writesBefore = file.written.length;
		await port.markUndelivered!('g1', told.recordId!, 'refused');
		await port.markUndelivered!('g1', told.recordId!, 'unknown');
		await port.markUndelivered!('g1', asked.recordId!, 'unknown');
		const queued = await port.appendRecord('g1', { kind: 'told', from: 'a', to: 'b', text: 'あとで読んで' });
		await port.markQueued('g1', queued.recordId!);
		await port.markUndelivered!('g1', queued.recordId!, 'refused');
		const reread = paradisParseBotGroupsState(JSON.parse(JSON.stringify(file.written.at(-1))));
		assert.deepStrictEqual({
			told,
			refused: refused.ok,
			writes: file.written.length - writesBefore,
			records: groups.getSnapshot().records.map(record => [record.id, record.kind, record.undelivered ?? false, record.queued ?? false]),
			reread: reread?.records.map(record => [record.id, record.undelivered ?? false, record.queued ?? false]),
		}, {
			told: { ok: true, recordId: '2' },
			refused: false,
			writes: 4,
			records: [[1, 'sent', false, false], [2, 'told', 'refused', false], [3, 'asked', 'unknown', false], [4, 'told', false, true]],
			reread: [[1, false, false], [2, 'refused', false], [3, 'unknown', false], [4, false, true]],
		});
	});

	test('伝言の道具の口: 受け箱は宛先の未読を返し、markRead で既読にする（保存して読み直しても既読のまま）', async () => {
		const file = new MemoryFile();
		const groups = service(file);
		await groups.createGroup({ name: '班', members: ['a', 'b'] });
		const port = paradisBotGroupsMessagePort(groups);
		const first = await port.appendRecord('g1', { kind: 'told', from: 'a', to: 'b', text: '終わった' });
		await port.appendRecord('g1', { kind: 'asked', from: 'a', to: 'b', text: 'どう?' });
		const before = (await port.inboxOf('b')).map(message => [message.recordId, message.kind, message.from, message.text]);
		await port.markRead('a', [first.recordId!]);
		await port.markRead('b', [first.recordId!]);
		const after = (await port.inboxOf('b')).map(message => message.recordId);
		const reread = paradisParseBotGroupsState(JSON.parse(JSON.stringify(file.written.at(-1))));
		assert.deepStrictEqual({ before, after, readAt: reread?.records[0].readAt, inboxA: (await port.inboxOf('a')).length }, {
			before: [['1', 'told', 'a', '終わった'], ['2', 'asked', 'a', 'どう?']],
			after: ['2'],
			readAt: 100,
			inboxA: 0,
		});
	});

	test('ウィンドウからは あなたの sent だけ書ける', async () => {
		const groups = service(new MemoryFile());
		const channel = new ParadisBotGroupsChannel(groups);
		await channel.call('', 'createGroup', [{ name: '班', members: ['a', 'b'] }]);
		const sent = await channel.call<{ ok: boolean; value?: { kind: string; from: string } }>('', 'recordSent', ['g1', ['a'], 'まとめて']);
		await assert.rejects(() => channel.call('', 'appendRecord', ['g1', { kind: 'told', from: 'a', to: ['b'], text: 'x' }]));
		assert.deepStrictEqual([sent.ok, sent.value?.kind, sent.value?.from, groups.getSnapshot().records.length], [true, 'sent', 'owner', 1]);
	});

	test('ファイル: 壊れた中身は退避して空で始め、書いた中身を読み戻せる', async () => {
		const folder = await fs.mkdtemp(join(tmpdir(), 'paradis-bot-groups-'));
		try {
			const path = join(folder, 'paradis', 'bots', 'groups.json');
			await fs.mkdir(join(folder, 'paradis', 'bots'), { recursive: true });
			await fs.writeFile(path, '{ not json');
			const file = createParadisBotGroupsFile(folder, () => 7);
			const broken = await file.read();
			await file.write({ ...EMPTY_PARADIS_BOT_GROUPS_STATE, groups: [{ id: 'g', name: '班', members: ['a', 'b'], replyMode: 'all', createdAt: 1, updatedAt: 1 }] });
			const again = await file.read();
			assert.deepStrictEqual([broken.quarantined, broken.state.groups.length, again.state.groups.map(group => group.name), (await fs.readdir(join(folder, 'paradis', 'bots'))).sort()],
				[`${path}.broken-7`, 0, ['班'], ['groups.json', 'groups.json.broken-7']]);
		} finally {
			await fs.rm(folder, { recursive: true, force: true });
		}
	});
});
