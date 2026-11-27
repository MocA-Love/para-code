/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IParadisHumanAskService, ParadisHumanAskAnswer, ParadisHumanAskClientResult } from '../../../humanAsk/common/paradisHumanAsk.js';
import { ParadisHumanAskLedger } from '../../../humanAsk/common/paradisHumanAskLedger.js';
import { IParadisMobileHumanAskAnswerReply } from '../../common/paradisMobileHumanAsks.js';
import { ParadisMobileOpResults } from '../../common/paradisMobileOpResults.js';
import { paradisCreateMobileHumanAskAnswerHandler, paradisCreateMobileHumanAsksHandler } from '../../electron-browser/paradisMobileHumanAskRequests.js';
import { IParadisMobileRequest, IParadisMobileRequestContext } from '../../electron-browser/paradisMobileRequestHandlers.js';

suite('ParadisMobileHumanAskRequests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists the phone-visible asks and answers only those, once per opId, as the phone', async () => {
		const ledger = new ParadisHumanAskLedger(() => 10);
		ledger.upsert('board:1', { source: 'board', id: 'b1', kind: 'question', from: { title: '#415' }, questions: [{ id: 'q0', text: 'どちら?', options: [{ id: '0', label: 'A' }], allowText: true }], actions: [], canSkip: false });
		ledger.upsert('panes', { source: 'pane', id: 'p1', kind: 'permission', from: { title: 'api' }, preface: 'Bash: npm test', questions: [], actions: [{ id: 'yes', label: '許可' }], canSkip: false, paneKey: 'k' });
		const answered: string[] = [];
		const service = {
			get snapshot() { return ledger.snapshot(); },
			async answer(key: string, answer: ParadisHumanAskAnswer, surface?: string): Promise<ParadisHumanAskClientResult> {
				answered.push(`${key} ${surface}`);
				const result = ledger.claim(key, answer, 'mobile');
				return result.ok ? { ok: true } : { ok: false, reason: result.reason };
			},
		} as Pick<IParadisHumanAskService, 'snapshot' | 'answer'>;
		const replies: unknown[] = [];
		const send = async (mobileId: string | undefined, body: Record<string, unknown>, handler = answer) => {
			const context = { channel: 'fs', mobileId, root: undefined, reply: (reply: object) => replies.push(reply) } as unknown as IParadisMobileRequestContext;
			await handler.handle({} as ServicesAccessor, { id: 'r', ...body } as IParadisMobileRequest, context);
		};
		const answer = paradisCreateMobileHumanAskAnswerHandler(() => service, new ParadisMobileOpResults<IParadisMobileHumanAskAnswerReply>());
		await send('phone', { t: 'humanAsks' }, paradisCreateMobileHumanAsksHandler(() => service));
		const pick = { type: 'answers', answers: [{ questionId: 'q0', optionIds: ['0'] }] };
		await send('phone', { t: 'humanAskAnswer', opId: 'op-1', key: 'board:b1', answer: pick });
		await send('phone', { t: 'humanAskAnswer', opId: 'op-1', key: 'board:b1', answer: pick });
		await send('phone', { t: 'humanAskAnswer', opId: 'op-2', key: 'board:b1', answer: pick });
		// busy で断った opId の再送は busy のまま（「答えた」と返さない。台帳にも 2 回目を渡さない）
		await send('phone', { t: 'humanAskAnswer', opId: 'op-2', key: 'board:b1', answer: pick });
		// 許可はスマホの既存の許可カードで答える（この口からは答えさせない）
		await send('phone', { t: 'humanAskAnswer', opId: 'op-3', key: 'pane:p1', answer: { type: 'action', actionId: 'yes' } });
		await send('phone', { t: 'humanAskAnswer', opId: 'op-3', key: 'pane:p1', answer: { type: 'action', actionId: 'yes' } });
		// 別のモバイルの同じ opId は別の操作
		await send('tablet', { t: 'humanAskAnswer', opId: 'op-1', key: 'board:b1', answer: pick });
		await send(undefined, { t: 'humanAskAnswer', opId: 'op-4', key: 'board:b1', answer: pick });
		await send('phone', { t: 'humanAskAnswer', opId: 'op-5', key: 'board:b1' });
		const list = replies[0] as { t: string; asks: { key: string }[]; signature: string };
		assert.deepStrictEqual({ list: [list.t, list.asks.map(ask => ask.key), typeof list.signature], rest: replies.slice(1), answered }, {
			list: ['humanAsks', ['board:b1'], 'string'],
			rest: [
				{ t: 'humanAskAnswer', ok: true },
				{ t: 'humanAskAnswer', ok: true, duplicate: true },
				{ t: 'humanAskAnswer', ok: false, reason: 'busy' },
				{ t: 'humanAskAnswer', ok: false, reason: 'busy' },
				{ t: 'humanAskAnswer', ok: false, reason: 'gone' },
				{ t: 'humanAskAnswer', ok: false, reason: 'gone' },
				{ t: 'humanAskAnswer', ok: false, reason: 'busy' },
				{ error: 'unknown device', code: 'forbidden' },
				{ error: 'invalid human ask answer', code: 'invalid' },
			],
			answered: ['board:b1 mobile', 'board:b1 mobile', 'board:b1 mobile'],
		});
	});

	test('a resend while the first answer is still being delivered waits for it; a first answer that threw can be retried', async () => {
		const ledger = new ParadisHumanAskLedger(() => 10);
		ledger.upsert('board:1', { source: 'board', id: 'b1', kind: 'approval', from: { title: '#415' }, questions: [], actions: [{ id: 'ok', label: '承認して次へ' }], canSkip: false });
		let release: (result: ParadisHumanAskClientResult) => void = () => { };
		let calls = 0;
		const service: Pick<IParadisHumanAskService, 'snapshot' | 'answer'> = {
			get snapshot() { return ledger.snapshot(); },
			answer(): Promise<ParadisHumanAskClientResult> {
				calls++;
				// 2 回目（op-2 の 1 回目）は届ける途中で例外になる
				return calls === 2 ? Promise.reject(new Error('channel closed')) : new Promise(resolve => release = resolve);
			},
		};
		const handler = paradisCreateMobileHumanAskAnswerHandler(() => service, new ParadisMobileOpResults<IParadisMobileHumanAskAnswerReply>());
		const replies: unknown[] = [];
		const send = async (opId: string) => {
			const context = { channel: 'fs', mobileId: 'phone', root: undefined, reply: (reply: object) => replies.push(reply) } as unknown as IParadisMobileRequestContext;
			try {
				await handler.handle({} as ServicesAccessor, { id: 'r', t: 'humanAskAnswer', opId, key: 'board:b1', answer: { type: 'action', actionId: 'ok' } } as IParadisMobileRequest, context);
			} catch (error) {
				replies.push(`threw ${(error as Error).message}`);
			}
		};
		const first = send('op-1');
		const resend = send('op-1');
		await Promise.resolve();
		release({ ok: true });
		await Promise.all([first, resend]);
		await send('op-2');
		const retried = send('op-2');
		await Promise.resolve();
		release({ ok: false, reason: 'busy' });
		await retried;
		assert.deepStrictEqual({ replies, calls }, {
			replies: [
				{ t: 'humanAskAnswer', ok: true },
				{ t: 'humanAskAnswer', ok: true, duplicate: true },
				'threw channel closed',
				{ t: 'humanAskAnswer', ok: false, reason: 'busy' },
			],
			calls: 3,
		});
	});
});
