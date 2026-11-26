/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpToolCallContext, ParadisMcpCallerKind, ParadisMcpOwningWindowResult } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import type { IParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisInboxPaneKey } from '../../../notificationInbox/common/paradisNotificationInbox.js';
import { ParadisHumanAskLedger } from '../../common/paradisHumanAskLedger.js';
import { IParadisHumanAskPaneAnswerRequest } from '../../common/paradisHumanAskPane.js';
import { PARADIS_ASK_HUMAN_RATE_PER_MINUTE } from '../../common/paradisAskHumanTool.js';
import { ParadisAskHumanChannel, ParadisAskHumanToolProvider } from '../../node/paradisAskHumanToolProvider.js';
import { ParadisHumanAskService } from '../../node/paradisHumanAskChannel.js';

const TOKEN = 'pane-token-1';
const PANE_KEY = paradisInboxPaneKey(TOKEN);
const ASK = { context: 'Cookie の SameSite が原因。', questions: [{ question: 'ログアウトさせますか?', options: [{ label: 'させる' }, { label: '残す' }], recommended: 1 }] };

function text(result: unknown): string {
	return (result as { content: { text: string }[] }).content[0].text;
}

function isError(result: unknown): boolean {
	return (result as { isError?: boolean }).isError === true;
}

suite('Paradis human ask: ask_human provider', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(settleTimeoutMs = 60_000) {
		let now = 1_000;
		let id = 0;
		const service = store.add(new ParadisHumanAskService(new ParadisHumanAskLedger(() => now)));
		const provider = store.add(new ParadisAskHumanToolProvider(service, { now: () => now, newId: () => String(++id), settleTimeoutMs }));
		const channel = new ParadisAskHumanChannel(provider);
		const toOwnerWindow: IParadisHumanAskPaneAnswerRequest[] = [];
		const toOtherWindow: IParadisHumanAskPaneAnswerRequest[] = [];
		store.add(channel.listen<IParadisHumanAskPaneAnswerRequest>('window:7', 'onDidRequestPaneAnswer', 7)(request => toOwnerWindow.push(request)));
		store.add(channel.listen<IParadisHumanAskPaneAnswerRequest>('window:8', 'onDidRequestPaneAnswer', 8)(request => toOtherWindow.push(request)));
		const windowCalls: IParadisMcpOwningWindowRequest[] = [];
		const context = (caller: ParadisMcpCallerKind = 'pane', label: unknown = { windowId: 7, space: 'api', tab: 'codex' }): IParadisMcpToolCallContext => ({
			callOwningWindow: async <T>(request: IParadisMcpOwningWindowRequest): Promise<ParadisMcpOwningWindowResult<T>> => {
				windowCalls.push(request);
				return { ok: true, value: label as T };
			},
			getPaneAgentStatus: () => undefined,
			getUnconfirmedRelease: () => undefined,
			hasAgentHookHistory: () => true,
			classifyCaller: async () => caller,
			getCursorIdentity: () => ({ cli: 'codex' }),
		});
		const hook = (event: string, prompt?: string, extra: Partial<IParadisAgentHookEvent> = {}): IParadisAgentHookEvent => ({ token: TOKEN, event, sessionId: 's', transcriptPath: undefined, cwd: undefined, at: now, ...(prompt !== undefined ? { payload: { prompt } } : {}), ...extra });
		const entries = () => service.getSnapshot().entries.map(entry => `${entry.state}${entry.pending ? ' pending' : ''}${entry.failedAt !== undefined ? ' failed' : ''}${entry.resolution?.surface ? ` by ${entry.resolution.surface}` : ''}`);
		return { service, provider, channel, context, hook, entries, windowCalls, toOwnerWindow, toOtherWindow, advance: (ms: number) => { now += ms; } };
	}

	test('only a caller inside the pane can ask; the entry is a question named by the window, not by the agent', async () => {
		const t = setup();
		const refusals = await Promise.all([
			t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, undefined),
			t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context('tunnel')),
			t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context('unverified')),
		]);
		const notMine = await t.provider.callTool(TOKEN, 'board_ask_human', ASK, undefined, t.context());
		const badLabel = await t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context('pane', { windowId: 7 }));
		const asked = await t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context());
		const entry = t.service.getSnapshot().entries.find(candidate => candidate.state === 'waiting');
		assert.deepStrictEqual({
			refusals: refusals.map(isError),
			notMine,
			badLabel: isError(badLabel),
			asked: text(asked).split('.')[0],
			window: t.windowCalls.map(call => [call.channelName, call.method, call.args]),
			entry: entry && { source: entry.source, owner: entry.owner, kind: entry.kind, actions: entry.actions, from: entry.from, paneKey: entry.paneKey === PANE_KEY, windowId: entry.windowId, preface: entry.preface, options: entry.questions[0].options },
		}, {
			refusals: [true, true, true],
			notMine: undefined,
			badLabel: true,
			asked: 'Asked',
			window: [['paradisAskHumanWindow', 'describePane', [TOKEN]], ['paradisAskHumanWindow', 'describePane', [TOKEN]]],
			entry: {
				source: 'pane', owner: 'askHuman', kind: 'question', actions: [], from: { title: 'api', detail: 'codex ／ Codex' }, paneKey: true, windowId: 7,
				preface: 'Cookie の SameSite が原因。', options: [{ id: '0', label: 'させる' }, { id: '1', label: '残す', recommended: true }],
			},
		});
	});

	test('one waiting question per pane: a new one replaces the earlier; a pane cannot flood the inbox', async () => {
		const t = setup();
		await t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context());
		await t.provider.callTool(TOKEN, 'ask_human', { questions: [{ question: '次は?' }] }, undefined, t.context());
		const afterReplace = t.entries();
		const results: boolean[] = [];
		for (let index = 0; index < PARADIS_ASK_HUMAN_RATE_PER_MINUTE; index++) {
			results.push(isError(await t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context())));
		}
		t.advance(60_000);
		const afterAMinute = isError(await t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context()));
		assert.deepStrictEqual({ afterReplace, results, afterAMinute, waiting: t.service.getSnapshot().counts.total }, {
			afterReplace: ['waiting', 'withdrawn'],
			// 最初の 2 回と合わせて 1 分に 6 回まで
			results: [false, false, false, false, true, true],
			afterAMinute: false,
			waiting: 1,
		});
	});

	test('withdrawn when the person types in the pane, the conversation ends or the terminal closes; notices, /model and unverified hooks do not count', async () => {
		const t = setup();
		const cases: [string, string | undefined, Partial<IParadisAgentHookEvent>][] = [
			['UserPromptSubmit', '<task-notification>done</task-notification>', {}],
			['UserPromptSubmit', '/model gpt-5', {}],
			['UserPromptSubmit', 'サブエージェントへ', { payload: { prompt: 'x', agent_id: 'a1' } }],
			['UserPromptSubmit', 'やっぱり B で', { ownerUnverified: true }],
			['UserPromptSubmit', 'やっぱり B で', {}],
			['SessionEnd', undefined, {}],
			['TerminalExit', undefined, {}],
		];
		const states: boolean[] = [];
		for (const [event, prompt, extra] of cases) {
			await t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context());
			t.provider.onHookEvent(t.hook(event, prompt, extra));
			states.push(t.entries().includes('waiting'));
			t.advance(20_000);
		}
		assert.deepStrictEqual(states, [true, true, true, true, false, false, false]);
	});

	test('an answer goes only to the window that owns the pane, as the next message; only that window can settle it', async () => {
		const t = setup();
		await t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context());
		const key = t.service.getSnapshot().entries[0].key;
		const answered = t.service.answer(key, { type: 'answers', answers: [{ questionId: 'q0', optionIds: ['1'] }] }, 'inbox');
		const request = t.toOwnerWindow[0];
		// 別のウィンドウからの知らせ・違う依頼の番号は無視する
		await t.channel.call('window:8', 'settle', [request.claim, key, true]);
		await t.channel.call('window:7', 'settle', ['999', key, true]);
		const beforeSettle = t.entries();
		// 届けている間に、同じペインから次の問いは出せない
		const busy = isError(await t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context()));
		// 届けた発言そのものの UserPromptSubmit で取り下げない
		t.provider.onHookEvent(t.hook('UserPromptSubmit', 'The person answered'));
		await t.channel.call('window:7', 'settle', [request.claim, key, true]);
		assert.deepStrictEqual({ answered: answered.ok, delivery: request.delivery, otherWindow: t.toOtherWindow.length, beforeSettle, busy, after: t.entries() }, {
			answered: true,
			delivery: { kind: 'message', text: 'The person answered your ask_human question in Para Code:\nQ: ログアウトさせますか?\nA: 残す' },
			otherWindow: 0,
			beforeSettle: ['waiting pending'],
			busy: true,
			after: ['answered by inbox'],
		});
	});

	test('when the window does not reply, the answer counts as delivered only if the pane got a message meanwhile', async () => {
		const t = setup(30);
		const answer = { type: 'answers', answers: [{ questionId: 'q0', optionIds: ['0'] }] };
		await t.provider.callTool(TOKEN, 'ask_human', ASK, undefined, t.context());
		t.service.answer(t.service.getSnapshot().entries[0].key, answer, 'inbox');
		await timeout(60);
		const silent = t.entries();
		const refusedAgain = t.service.answer(t.service.getSnapshot().entries[0].key, answer, 'inbox');
		t.provider.onHookEvent(t.hook('UserPromptSubmit', 'The person answered'));
		await timeout(60);
		assert.deepStrictEqual({ silent, refusedAgain: refusedAgain.ok, prompted: t.entries() }, {
			silent: ['waiting failed'],
			refusedAgain: true,
			prompted: ['answered by inbox'],
		});
	});
});
