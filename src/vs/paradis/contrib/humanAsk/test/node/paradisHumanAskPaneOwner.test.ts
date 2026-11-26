/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisAgentChatMessage } from '../../../agentChat/common/paradisAgentChat.js';
import { paradisInboxPaneKey } from '../../../notificationInbox/common/paradisNotificationInbox.js';
import { ParadisHumanAskLedger } from '../../common/paradisHumanAskLedger.js';
import { IParadisHumanAskPaneAnswerRequest, IParadisHumanAskPaneState } from '../../common/paradisHumanAskPane.js';
import { ParadisHumanAskService } from '../../node/paradisHumanAskChannel.js';
import { ParadisHumanAskPaneChannel, ParadisHumanAskPaneOwner } from '../../node/paradisHumanAskPaneOwner.js';

const TOKEN = 'pane-token-1';
const PANE_KEY = paradisInboxPaneKey(TOKEN);

function question(text: string, options: readonly string[]): IParadisAgentChatMessage {
	return { rev: 0, role: 'assistant', kind: 'question', text, options: options.map(label => ({ label })), toolUseId: 'q0', questionGroup: 'g1', questionIndex: 0 };
}

function permission(id: string, detail: string, extra: Partial<IParadisHumanAskPaneState> = {}): IParadisHumanAskPaneState {
	return {
		paneKey: PANE_KEY, agent: 'claude', epoch: 'e1', questions: [], personOnly: false,
		interaction: { kind: 'approval', id, detail, choices: [{ id: 'yes', label: '許可', tone: 'approve' }, { id: 'no', label: '拒否', tone: 'deny' }] },
		...extra,
	};
}

suite('Paradis human ask: pane owner', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(settleTimeoutMs = 60_000) {
		let now = 1_000;
		const service = store.add(new ParadisHumanAskService(new ParadisHumanAskLedger(() => now, { claimTimeoutMs: 20_000 })));
		const changed = store.add(new Emitter<void>());
		const labelsChanged = store.add(new Emitter<void>());
		const world: { panes: IParadisHumanAskPaneState[]; labelled: boolean } = { panes: [], labelled: true };
		const owner = store.add(new ParadisHumanAskPaneOwner(
			{ onDidChange: listener => changed.event(listener), read: () => world.panes },
			{ onDidChange: labelsChanged.event, get: paneKey => world.labelled && paneKey === PANE_KEY ? { windowId: 7, space: 'api', tab: 'claude' } : undefined },
			service,
			{ trace: () => { } },
			settleTimeoutMs,
		));
		const channel = new ParadisHumanAskPaneChannel(owner);
		// ペインを持っているウィンドウ（7）と、別のウィンドウ（8）
		const toOwnerWindow: IParadisHumanAskPaneAnswerRequest[] = [];
		const toOtherWindow: IParadisHumanAskPaneAnswerRequest[] = [];
		store.add(channel.listen<IParadisHumanAskPaneAnswerRequest>('window:7', 'onDidRequestPaneAnswer', 7)(request => toOwnerWindow.push(request)));
		store.add(channel.listen<IParadisHumanAskPaneAnswerRequest>('window:8', 'onDidRequestPaneAnswer', 8)(request => toOtherWindow.push(request)));
		const entries = () => service.getSnapshot().entries.map(entry => `${entry.kind} ${entry.state}${entry.pending ? ' pending' : ''}${entry.failedAt !== undefined ? ' failed' : ''}${entry.resolution?.surface ? ` by ${entry.resolution.surface}: ${entry.resolution.summary}` : ''}`);
		return {
			service, owner, channel, world, toOwnerWindow, toOtherWindow, entries,
			advance: (ms: number) => { now += ms; },
			changePanes: async (panes: IParadisHumanAskPaneState[]) => { world.panes = panes; changed.fire(); await timeout(80); },
			changeLabels: async (labelled: boolean) => { world.labelled = labelled; labelsChanged.fire(); await timeout(80); },
			key: () => service.getSnapshot().entries[0].key,
		};
	}

	test('lists what the relay is waiting for, and a pane without a label is not listed until its label is known', async () => {
		const t = setup();
		t.world.labelled = false;
		await t.changePanes([permission('toolu_1', 'Bash: npm test')]);
		const withoutLabel = t.entries();
		await t.changeLabels(true);
		const listed = t.service.getSnapshot().entries.map(entry => ({ id: entry.id, from: entry.from, windowId: entry.windowId, actions: entry.actions.map(action => action.id) }));
		// ターミナルで答えた（中継の待ちが消えた）: 取り下げになる
		await t.changePanes([]);
		assert.deepStrictEqual({ withoutLabel, listed, after: t.entries(), counts: t.service.getSnapshot().counts.total }, {
			withoutLabel: [],
			listed: [{ id: `${PANE_KEY}:e1:toolu_1`, from: { title: 'api', detail: 'claude ／ Claude Code' }, windowId: 7, actions: ['yes', 'no'] }],
			after: ['permission withdrawn'],
			counts: 0,
		});
	});

	test('an answer from the inbox goes to the window that has the pane, and its result settles the entry', async () => {
		const t = setup();
		await t.changePanes([permission('toolu_1', 'Bash: npm test')]);
		const key = t.key();
		const first = t.service.answer(key, { type: 'action', actionId: 'yes' }, 'inbox');
		// 届けている最中は、ほかの場所（スマホ）の答えを通さない
		const second = t.service.answer(key, { type: 'action', actionId: 'no' }, 'mobile');
		const request = t.toOwnerWindow[0];
		const pending = t.entries();
		// 古い依頼の番号の結果は無視する
		t.channel.call('window:7', 'settle', ['stale-claim', key, false]);
		const afterStale = t.entries();
		await t.channel.call('window:7', 'settle', [request.claim, key, true]);
		assert.deepStrictEqual({
			results: [first.ok, second.ok ? 'ok' : second.reason], toOtherWindow: t.toOtherWindow.length,
			request: { paneKey: request.paneKey, windowId: request.windowId, interactionId: request.interactionId, delivery: request.delivery, hasToken: JSON.stringify(request).includes(TOKEN) },
			pending, afterStale, after: t.entries(),
		}, {
			results: [true, 'busy'], toOtherWindow: 0,
			request: { paneKey: PANE_KEY, windowId: 7, interactionId: 'toolu_1', delivery: { kind: 'approval', choiceId: 'yes' }, hasToken: false },
			pending: ['permission waiting pending'], afterStale: ['permission waiting pending'],
			after: ['permission answered by inbox: 許可'],
		});
	});

	test('an answer to an ask that changed or can no longer be allowed here is not delivered', async () => {
		const t = setup();
		const asked = (options: readonly string[]): IParadisHumanAskPaneState => ({ paneKey: PANE_KEY, agent: 'claude', epoch: 'e1', personOnly: false, interaction: { kind: 'question', id: 'g1' }, questions: [question('どちら?', options)] });
		await t.changePanes([asked(['残す', 'ログアウト'])]);
		const key = t.key();
		// 受信箱が古い一覧を見ている間に、同じ id のまま選択肢の並びが変わった（台帳へはまだ知らせが届いていない）
		t.world.panes = [asked(['ログアウト', '残す'])];
		const reordered = t.service.answer(key, { type: 'answers', answers: [{ questionId: '0', optionIds: ['0'] }] }, 'inbox');
		const afterReordered = t.entries();
		await timeout(80);

		// 許可の確認が、端末の確認の画面でしか許可できないものに変わった（mod の知らせが後から届いた）
		await t.changePanes([permission('toolu_2', 'Bash: rm -rf build')]);
		const permissionKey = t.key();
		t.world.panes = [permission('toolu_2', 'Bash: rm -rf build', { personOnly: true })];
		const personOnly = t.service.answer(permissionKey, { type: 'action', actionId: 'yes' }, 'inbox');
		const afterPersonOnly = t.entries();
		await timeout(80);
		assert.deepStrictEqual({
			claimed: [reordered.ok, personOnly.ok], delivered: t.toOwnerWindow.length, afterReordered, afterPersonOnly,
			// 知らせ直した後は、押せるものが無い 1 件になる
			actions: t.service.getSnapshot().entries.filter(entry => entry.state === 'waiting').map(entry => entry.actions.length),
		}, {
			claimed: [true, true], delivered: 0,
			afterReordered: ['question waiting failed'],
			afterPersonOnly: ['permission waiting failed', 'question withdrawn'],
			actions: [0],
		});
	});

	test('a request that no window answers ends as failed while the ask still waits, and as answered when it is gone', async () => {
		const t = setup(30);
		await t.changePanes([permission('toolu_1', 'Bash: npm test')]);
		const key = t.key();
		t.service.answer(key, { type: 'action', actionId: 'yes' }, 'inbox');
		// 返事が来ないまま、台帳の時間切れ（20 秒）を過ぎた。持ち主が一覧を知らせ直す
		t.advance(21_000);
		await timeout(120);
		const stillWaiting = t.entries();

		// もう一度答え、今度は返事が来る前にペインの待ちが消えた（キーは届いて先へ進んだ）。台帳は持ち主の知らせを待ち、
		// 返事が来ないまま時間切れを過ぎた後の一覧で回答済みにする
		t.service.answer(key, { type: 'action', actionId: 'yes' }, 'inbox');
		t.world.panes = [];
		await timeout(120);
		t.advance(21_000);
		await t.changePanes([]);
		assert.deepStrictEqual({ stillWaiting, gone: t.entries(), requests: t.toOwnerWindow.length }, {
			stillWaiting: ['permission waiting failed'],
			gone: ['permission answered by inbox: 許可'],
			requests: 2,
		});
	});
});
