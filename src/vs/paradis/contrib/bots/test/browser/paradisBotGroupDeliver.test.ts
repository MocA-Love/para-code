/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisAgentChatSendOutcome } from '../../../agentChat/browser/paradisAgentChatInput.js';
import { IParadisBotGroupDeliverDependencies, ParadisBotGroupDeliverQueue, paradisBotGroupDeliver, paradisWaitForLoaded } from '../../browser/paradisBotGroupDeliver.js';
import { ParadisBotGroupRelayLimiter } from '../../common/paradisBotGroups.js';

const HASH_A = 'a'.repeat(64);

suite('Paradis bot group deliver', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function deps(overrides: Partial<IParadisBotGroupDeliverDependencies> & { activity?: 'idle' | 'working' | 'patrolling'; outcome?: ParadisAgentChatSendOutcome } = {}): IParadisBotGroupDeliverDependencies & { sent: string[] } {
		const sent: string[] = [];
		return {
			sent,
			waitForLoaded: async () => true,
			groups: () => [{ members: ['a', 'b'] }],
			bot: botId => botId === 'b' ? { paused: false, activity: overrides.activity ?? 'idle' } : botId === 'a' ? { paused: false, activity: 'idle' } : undefined,
			botIdByPaneHash: async hash => hash === HASH_A ? 'a' : undefined,
			whereIs: async () => 'here',
			send: async (botId, text, options) => {
				sent.push(`${botId}:${text}:${options.working ? 'working' : 'idle'}:${options.refuseDraft}`);
				return overrides.outcome ?? { kind: 'sent' };
			},
			limiter: new ParadisBotGroupRelayLimiter(),
			now: () => 0,
			...overrides,
		};
	}

	test('種類ごとの戻り値: 届けた・作業中は順番待ち・受け取らなかった・届いたか分からない。断ったら何も送らない', async () => {
		const notMember = deps();
		const elsewhereNone = deps({ whereIs: async () => 'none' });
		assert.deepStrictEqual({
			delivered: await paradisBotGroupDeliver(deps(), HASH_A, 'b', '/model x'),
			patrolling: await paradisBotGroupDeliver(deps({ activity: 'patrolling' }), HASH_A, 'b', 'x'),
			queued: await paradisBotGroupDeliver(deps({ activity: 'working' }), HASH_A, 'b', 'x'),
			cannotQueue: await paradisBotGroupDeliver(deps({ activity: 'working', outcome: { kind: 'refused', code: 'working', message: '作業中' } }), HASH_A, 'b', 'x'),
			drafting: await paradisBotGroupDeliver(deps({ outcome: { kind: 'refused', code: 'draft', message: '書きかけ' } }), HASH_A, 'b', 'x'),
			prompt: await paradisBotGroupDeliver(deps({ outcome: { kind: 'refused', message: '質問' } }), HASH_A, 'b', 'x'),
			pastedNotSent: await paradisBotGroupDeliver(deps({ outcome: { kind: 'unknown', message: 'Enter なし' } }), HASH_A, 'b', 'x'),
			notMember: await paradisBotGroupDeliver(notMember, 'b'.repeat(64), 'b', 'x'),
			notRunning: await paradisBotGroupDeliver(elsewhereNone, HASH_A, 'b', 'x'),
			sentWhenRefused: [...notMember.sent, ...elsewhereNone.sent],
		}, {
			delivered: { kind: 'delivered' },
			patrolling: { kind: 'delivered' },
			queued: { kind: 'queued' },
			cannotQueue: { kind: 'refused', reason: 'that bot is working, and its agent cannot hold messages until its next turn' },
			drafting: { kind: 'refused', reason: 'its owner is typing in that bot\'s input' },
			prompt: { kind: 'refused', reason: 'that bot cannot take a message now, for example while a question or permission prompt is open' },
			pastedNotSent: { kind: 'unknown', reason: 'Para Code may have typed the message into that bot\'s input without sending it' },
			notMember: { kind: 'refused', reason: 'you and that bot are not in the same group, so do not send it again' },
			notRunning: { kind: 'refused', reason: 'that bot is not running, or its chat is no longer open in this Para Code window' },
			sentWhenRefused: [],
		});
	});

	test('先頭の / を全角にして送り、受け取らなかった伝言は宛先の回数に数えない', async () => {
		const refusing = deps({ outcome: { kind: 'refused', message: '質問' } });
		for (let i = 0; i < 4; i++) {
			await paradisBotGroupDeliver(refusing, HASH_A, 'b', 'x');
		}
		const accepting = deps();
		const results = [];
		for (let i = 0; i < 4; i++) {
			results.push((await paradisBotGroupDeliver(accepting, HASH_A, 'b', i === 0 ? '/model x' : 'x')).kind);
		}
		assert.deepStrictEqual({ refusedSends: refusing.sent.length, results, first: accepting.sent[0] }, { refusedSends: 4, results: ['delivered', 'delivered', 'delivered', 'refused'], first: 'b:\uFF0Fmodel x:idle:true' });
	});

	test('同じ宛先へ並んで来た伝言は 1 つずつ送る（前の送信が終わるまで次を始めない）。別の宛先は待たない', async () => {
		const log: string[] = [];
		let release: () => void = () => { };
		const first = new Promise<void>(resolve => { release = resolve; });
		const queue = new ParadisBotGroupDeliverQueue(deps({
			groups: () => [{ members: ['a', 'b', 'c'] }],
			bot: () => ({ paused: false, activity: 'idle' }),
			send: async (botId, text) => {
				log.push(`start ${botId}:${text}`);
				if (text === '1') {
					await first;
				}
				log.push(`end ${botId}:${text}`);
				return { kind: 'sent' };
			},
		}));
		const one = queue.deliver(HASH_A, 'b', '1');
		const two = queue.deliver(HASH_A, 'b', '2');
		const other = queue.deliver(HASH_A, 'c', '3');
		await other;
		release();
		await Promise.all([one, two]);
		assert.deepStrictEqual(log, ['start b:1', 'start c:3', 'end c:3', 'end b:1', 'start b:2', 'end b:2']);
	});

	test('台帳を読み込む前に来た最初の伝言は、読み込みを待ってから照らす。読めなければ「同じグループでない」にしない', async () => {
		const bots = store.add(new Emitter<void>());
		const groups = store.add(new Emitter<void>());
		const botsLedger = { snapshot: { revision: 0 }, onDidChange: bots.event };
		const groupsLedger = { snapshot: { revision: 0 }, onDidChange: groups.event };
		let members: string[] = [];
		const waiting = paradisBotGroupDeliver(deps({
			waitForLoaded: () => paradisWaitForLoaded([botsLedger, groupsLedger], 1000),
			groups: () => [{ members }],
		}), HASH_A, 'b', 'x');
		botsLedger.snapshot.revision = 1;
		bots.fire();
		members = ['a', 'b'];
		groupsLedger.snapshot.revision = 1;
		groups.fire();
		const notLoaded = await paradisBotGroupDeliver(deps({ waitForLoaded: () => paradisWaitForLoaded([{ snapshot: { revision: 0 }, onDidChange: groups.event }], 1) }), HASH_A, 'b', 'x');
		assert.deepStrictEqual({ first: await waiting, notLoaded }, {
			first: { kind: 'delivered' },
			notLoaded: { kind: 'refused', reason: 'Para Code in that bot\'s window has not finished loading the bot groups yet' },
		});
	});
});
