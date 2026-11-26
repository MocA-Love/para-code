/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHumanAskAnswerRequest, IParadisHumanAskSnapshot } from '../../common/paradisHumanAsk.js';
import { ParadisHumanAskLedger } from '../../common/paradisHumanAskLedger.js';
import { ParadisHumanAskChannel, ParadisHumanAskService } from '../../node/paradisHumanAskChannel.js';

const QUESTION = {
	source: 'board', id: 't1:q1', kind: 'question', from: { title: '#415 計画' },
	questions: [{ id: 'q1', text: 'どちらにしますか?', options: [{ id: 'a', label: '残す' }, { id: 'b', label: 'ログアウトさせる' }], allowText: true }],
};

const summary = (snapshot: IParadisHumanAskSnapshot) => snapshot.entries.map(entry => `${entry.key} ${entry.state}${entry.pending ? ' pending' : ''}${entry.resolution?.surface ? ` by ${entry.resolution.surface}: ${entry.resolution.summary}` : ''}`);

suite('Paradis human ask service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('an answer from one window reaches the owner once, and every subscriber sees the entry answered', async () => {
		const service = store.add(new ParadisHumanAskService(new ParadisHumanAskLedger(() => 1_000)));
		const channel = new ParadisHumanAskChannel(service);
		// 2 つのウィンドウが同じ台帳を見ている
		const seenByWindow1: string[][] = [];
		const seenByWindow2: string[][] = [];
		store.add(channel.listen<IParadisHumanAskSnapshot>('window:1', 'onDidChange')(snapshot => seenByWindow1.push(summary(snapshot))));
		store.add(channel.listen<IParadisHumanAskSnapshot>('window:2', 'onDidChange')(snapshot => seenByWindow2.push(summary(snapshot))));
		// 持ち主（ボードの取り込み役）は自分の分の依頼だけを拾い、届けたら回答済みにする
		const requests: IParadisHumanAskAnswerRequest[] = [];
		store.add(service.onDidRequestAnswer(request => requests.push(request)));

		// 形の合わない 1 件（出どころが無い）と、同じ鍵の 2 件目は入れない
		assert.strictEqual(service.sync('board', [QUESTION, { ...QUESTION, source: 'elsewhere' }, QUESTION]), 2);
		await timeout(80);

		const answer = { type: 'answers', answers: [{ questionId: 'q1', optionIds: ['a'], text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 は残す' }] };
		const [first, second, spoofed] = await Promise.all([
			channel.call('window:1', 'answer', ['board:t1:q1', answer, 'inbox']),
			channel.call('window:2', 'answer', ['board:t1:q1', answer, 'inbox']),
			channel.call('window:2', 'answer', ['board:nope', answer, 'mobile']),
		]);
		await timeout(80);
		service.resolve('board', 'board:t1:q1');
		await timeout(80);

		const resolution = service.get('board:t1:q1')?.resolution;
		assert.deepStrictEqual({
			results: [first, second, spoofed],
			// 持ち主へは 1 回だけ、答えの本文は伏せずに届く
			requests: requests.map(request => [request.owner, request.key, request.surface, request.answer]),
			seenByWindow1,
			sameForBoth: JSON.stringify(seenByWindow1) === JSON.stringify(seenByWindow2),
			// ほかの場所に出す要約は伏せ字済み
			summaryHidesToken: resolution?.summary?.startsWith('残す') && !resolution.summary.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
			counts: service.getSnapshot().counts,
		}, {
			results: [{ ok: true }, { ok: false, reason: 'busy' }, { ok: false, reason: 'gone' }],
			requests: [['board', 'board:t1:q1', 'inbox', answer]],
			seenByWindow1: [
				['board:t1:q1 waiting'],
				['board:t1:q1 waiting pending'],
				[`board:t1:q1 answered by inbox: ${resolution?.summary}`],
			],
			sameForBoth: true,
			summaryHidesToken: true,
			counts: { total: 0, pane: 0, board: 0, bot: 0 },
		});
	});

	test('a window can only read and answer: it cannot write entries or settle them', async () => {
		const service = store.add(new ParadisHumanAskService());
		const channel = new ParadisHumanAskChannel(service);
		service.upsert('board', QUESTION);

		const refused: string[] = [];
		for (const command of ['sync', 'upsert', 'resolve', 'reject', 'withdraw', 'removeOwner']) {
			await channel.call('window:1', command, ['board', 'board:t1:q1']).catch(() => refused.push(command));
		}
		assert.deepStrictEqual(
			{ refused, state: service.get('board:t1:q1')?.state, upsertInvalid: service.upsert('board', { source: 'board' }) },
			{ refused: ['sync', 'upsert', 'resolve', 'reject', 'withdraw', 'removeOwner'], state: 'waiting', upsertInvalid: false },
		);
	});
});
