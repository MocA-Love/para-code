/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHumanAskSnapshot, paradisSanitizeHumanAskInput } from '../../../humanAsk/common/paradisHumanAsk.js';
import { ParadisHumanAskLedger } from '../../../humanAsk/common/paradisHumanAskLedger.js';
import { ParadisHumanAskService } from '../../../humanAsk/node/paradisHumanAskChannel.js';
import { ITaskBoardFlow, ITaskBoardPaneAsk, ITaskBoardTask } from '../../common/paradisTaskBoard.js';
import { taskBoardAskOf } from '../../common/paradisTaskBoardAsks.js';
import { IParadisTaskBoardWindowDescription, ParadisTaskBoardWindowMethod } from '../../common/paradisTaskBoardBridge.js';
import { TASK_BOARD_DEFAULT_FLOW } from '../../common/paradisTaskBoardFlow.js';
import { IParadisTaskBoardWindowRouter, ParadisTaskBoardBridgeService } from '../../node/paradisTaskBoardBridgeService.js';

const TERMINAL = 't_0123456789ab';
const PANE_KEY = '0123456789abcdef0123456789abcdef01234567';
const BOARD_A = 'a'.repeat(64);
const BOARD_B = 'b'.repeat(64);
const LEDGER = '0123456789abcdef';

class FakeRouter implements IParadisTaskBoardWindowRouter {
	windows(): readonly string[] {
		return ['window:3'];
	}
	async call<T>(_ctx: string, method: ParadisTaskBoardWindowMethod): Promise<T> {
		if (method === 'describe') {
			const description: IParadisTaskBoardWindowDescription = { focused: true, repositories: [{ path: '/repo', name: 'repo' }], spaces: [{ path: '/repo', name: 'repo' }] };
			return description as T;
		}
		return { ok: true, value: { terminal: TERMINAL, paneKey: PANE_KEY } } as T;
	}
}

function question(id: string, extra: object = {}): object {
	return {
		id, kind: 'question', from: { title: '#415 計画', detail: '調査・計画' }, canSkip: false, askedAt: 500,
		questions: [{ id: 'q1', text: 'どちらにしますか?', options: [{ id: '0', label: '残す' }, { id: '1', label: '消す' }], allowText: true }], actions: [],
		...extra,
	};
}

function approval(id: string): object {
	return { id, kind: 'approval', from: { title: '#416 承認' }, canSkip: false, askedAt: 600, questions: [], actions: [{ id: 'approve', label: '承認して次へ', allowText: true }, { id: 'sendBack', label: '差し戻す', allowText: true }] };
}

function task(extra: Partial<ITaskBoardTask>): ITaskBoardTask {
	return {
		id: 'gh:o/r#7', title: 'Issue 7', source: 'github', issue: { owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/issues/7' }, labels: [], assignees: [],
		flowId: 'default', step: 'plan', status: 'working', stepSince: 900, attempt: 3, createdAt: 1, updatedAt: 1, activities: [], history: [], artifacts: [], log: [],
		...extra,
	};
}

suite('ParadisTaskBoardAskBridge', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let now = 0;
	let service: ParadisTaskBoardBridgeService;
	let ledger: ParadisHumanAskService;

	setup(() => {
		now = 1_000;
		ledger = store.add(new ParadisHumanAskService(new ParadisHumanAskLedger(() => now)));
		service = store.add(new ParadisTaskBoardBridgeService(new FakeRouter(), { directoryExists: async () => true, ignorePathCase: false, newId: () => 'id', asks: ledger }, undefined));
	});

	/** SSE をつなぎ、届いた `ask-answer` を返す。 */
	function connect(keyHash: string, remote = false) {
		const events: { type: string; claim: string; id: string; answer: unknown }[] = [];
		const client = service.addEventClient(chunk => {
			if (chunk.startsWith('data: ')) {
				const event = JSON.parse(chunk.slice('data: '.length));
				if (event.type === 'ask-answer') {
					events.push(event);
				}
			}
		}, { keyHash, remote })!;
		return { events, client };
	}

	const put = (keyHash: string | undefined, body: unknown, remote = false) => service.handle('PUT', '/v1/asks', new URLSearchParams(), body, keyHash, remote).then(response => `${response.status} ${JSON.stringify(response.body)}`);
	const settle = (keyHash: string, body: unknown) => service.handle('POST', '/v1/asks/settle', new URLSearchParams(), body, keyHash).then(response => response.status);
	const summary = (snapshot: IParadisHumanAskSnapshot = ledger.getSnapshot()) => snapshot.entries.map(entry => `${entry.key} ${entry.state}${entry.pending ? ' pending' : ''}${entry.failedAt !== undefined ? ' failed' : ''}${entry.resolution?.surface ? ` by ${entry.resolution.surface}` : ''}`);

	test('the board\'s turns are written to the ledger as board entries of that board, with the pane of the terminal it started', async () => {
		await service.handle('POST', '/v1/launch', new URLSearchParams(), { launchId: 'L1', repoPath: '/repo', agent: 'claude', prompt: 'go' }, BOARD_A);
		const withoutEvents = await put(BOARD_A, { asks: [question('L:t1:q1')] });
		const board = connect(BOARD_A);
		const results = [
			// 出どころ・ペインの鍵・窓は、ボードの言い分を使わない（ペインや Bot の待ちを名乗らせない）
			await put(BOARD_A, { asks: [question('L:t1:q1', { source: 'pane', terminal: TERMINAL, paneKey: 'f'.repeat(40), windowId: 99, canSkip: true }), approval('L:t2:approval:1'), { id: 'broken' }] }),
			await put(BOARD_A, { asks: 'no' }),
		];
		const entries = ledger.getSnapshot().entries.map(entry => ({ key: entry.key, owner: entry.owner, source: entry.source, kind: entry.kind, paneKey: entry.paneKey, windowId: entry.windowId, canSkip: entry.canSkip }));
		const counts = ledger.getSnapshot().counts;
		board.client.dispose();
		assert.deepStrictEqual({ withoutEvents, results, entries, counts }, {
			withoutEvents: '503 {"error":"unavailable","message":"Connect to /v1/events before reporting asks."}',
			results: ['200 {"ok":true,"refused":1}', `400 {"error":"invalid","message":"asks must be an array of up to 500 entries."}`],
			entries: [
				// 持ち主の名前にボードの鍵（の hash）は出ない
				{ key: 'board:L:t2:approval:1', owner: 'board:1', source: 'board', kind: 'approval', paneKey: undefined, windowId: undefined, canSkip: false },
				{ key: 'board:L:t1:q1', owner: 'board:1', source: 'board', kind: 'question', paneKey: PANE_KEY, windowId: 3, canSkip: false },
			],
			counts: { total: 2, pane: 0, board: 2, bot: 0 },
		});
	});

	test('an answer from the ledger reaches only the owning board, and its result settles the entry', async () => {
		const a = connect(BOARD_A);
		const b = connect(BOARD_B);
		await put(BOARD_A, { asks: [question('L:t1:q1'), approval('L:t2:approval:1')] });
		await put(BOARD_B, { asks: [question('M:t9:q9')] });
		const answer = { type: 'answers', answers: [{ questionId: 'q1', optionIds: ['1'], text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] };
		const first = ledger.answer('board:L:t1:q1', answer, 'inbox');
		const second = ledger.answer('board:L:t1:q1', answer, 'mobile');
		const whileDelivering = summary();
		const statuses = [
			// ほかのボード・知らない番号の結果は受けない
			await settle(BOARD_B, { claim: a.events[0].claim, ok: true }),
			await settle(BOARD_A, { claim: 'nope', ok: true }),
			await settle(BOARD_A, { claim: a.events[0].claim }),
			await settle(BOARD_A, { claim: a.events[0].claim, ok: true }),
			// 同じ結果を二度は受けない
			await settle(BOARD_A, { claim: a.events[0].claim, ok: false }),
		];
		const afterDelivered = summary();
		// 届かなかった答えは待ちへ戻り、もう一度答えられる
		ledger.answer('board:L:t2:approval:1', { type: 'action', actionId: 'approve' }, 'inbox');
		const failed = await settle(BOARD_A, { claim: a.events[1].claim, ok: false });
		const afterFailed = summary();
		const again = ledger.answer('board:L:t2:approval:1', { type: 'action', actionId: 'sendBack', text: 'もう少し詳しく' }, 'mobile');
		a.client.dispose();
		b.client.dispose();
		assert.deepStrictEqual({
			results: [first.ok, second.ok ? 'ok' : second.reason, again.ok],
			toBoardA: a.events.map(event => [event.id, event.answer]),
			toBoardB: b.events,
			whileDelivering,
			statuses,
			afterDelivered,
			failed,
			afterFailed,
		}, {
			results: [true, 'busy', true],
			// 答えの本文は伏せずに、持ち主のボードにだけ届く
			toBoardA: [['L:t1:q1', answer], ['L:t2:approval:1', { type: 'action', actionId: 'approve' }], ['L:t2:approval:1', { type: 'action', actionId: 'sendBack', text: 'もう少し詳しく' }]],
			toBoardB: [],
			whileDelivering: ['board:L:t2:approval:1 waiting', 'board:M:t9:q9 waiting', 'board:L:t1:q1 waiting pending'],
			statuses: [404, 404, 400, 200, 404],
			afterDelivered: ['board:L:t2:approval:1 waiting', 'board:M:t9:q9 waiting', 'board:L:t1:q1 answered by inbox'],
			failed: 200,
			afterFailed: ['board:L:t2:approval:1 waiting failed', 'board:M:t9:q9 waiting', 'board:L:t1:q1 answered by inbox'],
		});
	});

	test('a turn answered on the board leaves the ledger as answered, one that just goes away as withdrawn, and a board that stops withdraws all of its turns', async () => {
		const a = connect(BOARD_A);
		const b = connect(BOARD_B);
		await put(BOARD_A, { asks: [question('L:t1:q1'), approval('L:t2:approval:1'), question('L:t3:q3')] });
		await put(BOARD_B, { asks: [question('M:t9:q9')] });
		// ほかのボードの 1 件は、回答済みにも取り下げにもできない
		await put(BOARD_B, { asks: [question('M:t9:q9')], answered: ['L:t3:q3'] });
		await put(BOARD_A, { asks: [question('L:t3:q3')], answered: ['L:t1:q1'] });
		const afterBoardAnswer = summary().sort();
		// 届けている最中に一覧から消えたら、答えが届いて先へ進んだとみなす（結果の知らせが落ちても回答済みになる）
		ledger.answer('board:L:t3:q3', { type: 'answers', answers: [{ questionId: 'q1', optionIds: ['0'] }] }, 'mobile');
		await put(BOARD_A, { asks: [] });
		const afterDelivered = summary().sort();
		// 「報告を促す」の後にまた止まった等、同じ id で出直した問いは、回答済みの守りが明けた後の一覧で待ちに戻る
		const guarded = await put(BOARD_A, { asks: [question('L:t3:q3')] }).then(() => summary().filter(line => line.startsWith('board:L:t3:q3')));
		now += 11_000;
		const revived = await put(BOARD_A, { asks: [question('L:t3:q3')] }).then(() => summary().filter(line => line.startsWith('board:L:t3:q3')));
		// つなぎ直しが重なっている間は取り下げない。最後の 1 本が切れたら取り下げ、知らせ直せば待ちに戻る
		const reconnecting = connect(BOARD_A);
		a.client.dispose();
		const whileReconnecting = summary().filter(line => line.includes('waiting')).sort();
		reconnecting.client.dispose();
		const afterStop = summary().filter(line => line.startsWith('board:L:t3:q3') || line.startsWith('board:M:')).sort();
		const back = connect(BOARD_A);
		await put(BOARD_A, { asks: [question('L:t3:q3')] });
		const afterReturn = summary().filter(line => line.startsWith('board:L:t3:q3'));
		back.client.dispose();
		b.client.dispose();
		assert.deepStrictEqual({ afterBoardAnswer, afterDelivered, guarded, revived, whileReconnecting, afterStop, afterReturn }, {
			afterBoardAnswer: ['board:L:t1:q1 answered by board', 'board:L:t2:approval:1 withdrawn', 'board:L:t3:q3 waiting', 'board:M:t9:q9 waiting'],
			afterDelivered: ['board:L:t1:q1 answered by board', 'board:L:t2:approval:1 withdrawn', 'board:L:t3:q3 answered by mobile', 'board:M:t9:q9 waiting'],
			guarded: ['board:L:t3:q3 answered by mobile'],
			revived: ['board:L:t3:q3 waiting'],
			whileReconnecting: ['board:L:t3:q3 waiting', 'board:M:t9:q9 waiting'],
			afterStop: ['board:L:t3:q3 withdrawn', 'board:M:t9:q9 waiting'],
			afterReturn: ['board:L:t3:q3 waiting'],
		});
	});

	test('a task board for an SSH window reports its turns, without the pane of a terminal on this PC', async () => {
		await service.handle('POST', '/v1/launch', new URLSearchParams(), { launchId: 'L1', repoPath: '/repo', agent: 'claude', prompt: 'go' }, BOARD_A);
		const remote = connect(BOARD_B, true);
		const result = await put(BOARD_B, { asks: [question('R:t1:q1', { terminal: TERMINAL })] }, true);
		const entry = ledger.get('board:R:t1:q1');
		remote.client.dispose();
		assert.deepStrictEqual([result, entry?.state, entry?.paneKey, entry?.windowId], ['200 {"ok":true,"refused":0}', 'waiting', undefined, undefined]);
	});

	test('every ask the board builds from a task passes the ledger\'s checks unchanged', () => {
		const flow: ITaskBoardFlow = TASK_BOARD_DEFAULT_FLOW;
		const asked = { id: 'q7', text: 'どちらにしますか?', allowText: true, askedAt: 800 };
		const tasks: ITaskBoardTask[] = [
			task({ status: 'question', question: { ...asked, kind: 'question', options: Array.from({ length: 9 }, (_, index) => ({ label: `案 ${index}`, detail: index === 0 ? '既定' : undefined })), origin: 'agent' } }),
			task({ status: 'question', question: { ...asked, kind: 'question', options: [] } }),
			task({ status: 'permission', question: { ...asked, kind: 'permission', text: 'Bash: npm test', options: [{ label: '許可する' }, { label: '拒否する' }], allowText: false, origin: 'screen' } }),
			// 台帳の上限を超える・選択肢の名前が空のものは、切らずに「ここからは答えられない」1 件にする
			task({ status: 'permission', question: { ...asked, kind: 'permission', options: Array.from({ length: 7 }, (_, index) => ({ label: `o${index}` })) } }),
			task({ status: 'question', question: { ...asked, kind: 'question', options: [{ label: ' ' }] } }),
			task({ status: 'approval', step: 'approve' }),
			task({ status: 'failed', step: 'review', error: 'checks-failed' }),
			task({ status: 'stalled' }),
			task({ status: 'stalled', error: 'restarted' }),
			task({ status: 'ready', step: 'merge', pr: { owner: 'o', repo: 'r', number: 9, url: 'https://github.com/o/r/pull/9', state: 'open', checks: 'success', review: 'approved' } }),
			task({ status: 'working' }),
			task({ id: 'x'.repeat(400), status: 'approval', step: 'approve' }),
		];
		const asks = tasks.map(entry => taskBoardAskOf(entry, flow, LEDGER));
		const checked = asks.map(ask => {
			if (ask === undefined) {
				return 'none';
			}
			const sanitized = paradisSanitizeHumanAskInput({ ...ask, source: 'board' });
			if (sanitized === undefined) {
				return 'refused';
			}
			// 検めた後も、ボードが作った値のまま（切られた・伏せられた・足された欄が無い）
			const built = { source: 'board', id: ask.id, kind: ask.kind, from: ask.from, preface: ask.preface, questions: ask.questions, actions: ask.actions, canSkip: ask.canSkip, askedAt: ask.askedAt };
			const same = JSON.stringify(sanitized) === JSON.stringify(built);
			return `${sanitized.kind} q${sanitized.questions.map(entry => entry.options.length).join(',')} a${sanitized.actions.map(action => action.id).join(',')} ${same ? 'same' : 'changed'}`;
		});
		assert.deepStrictEqual(checked, [
			'question q9 a same',
			'question q0 a same',
			'permission q a0,1 same',
			'permission q a same',
			'question q a same',
			'approval q aapprove,sendBack same',
			'stalled q asendBack,retry same',
			'stalled q anudge,complete same',
			'stalled q aretry,complete same',
			'approval q a same',
			'none',
			'none',
		]);
	});
	test('waits of panes outside the board reach only boards on this computer, which can answer only a single-pick question', async () => {
		await service.handle('POST', '/v1/launch', new URLSearchParams(), { launchId: 'L1', repoPath: '/repo', agent: 'claude', prompt: 'go' }, BOARD_A);
		const seen: { local: ITaskBoardPaneAsk[][]; remote: number } = { local: [], remote: 0 };
		const local = service.addEventClient(chunk => {
			const event = JSON.parse(chunk.slice('data: '.length));
			if (event.type === 'pane-asks') {
				seen.local.push(event.asks);
			}
		}, { keyHash: BOARD_A })!;
		const remote = service.addEventClient(chunk => {
			seen.remote += chunk.includes('pane-asks') ? 1 : 0;
		}, { keyHash: BOARD_B, remote: true })!;
		// 鍵の無い受け手（接続口の受け口は鍵を確かめてからつなぐので、本物には無い）にも流さない
		const keyless = service.addEventClient(chunk => {
			seen.remote += chunk.includes('pane-asks') ? 1 : 0;
		}, {})!;
		const pane = (id: string, paneKey: string, extra: object) => ({ source: 'pane', id, paneKey, windowId: 3, from: { title: 'api', detail: 'main ／ Codex' }, canSkip: false, askedAt: 700, questions: [], actions: [], ...extra });
		const yesNo = [{ id: 'yes', label: '許可' }, { id: 'no', label: '拒否' }];
		ledger.upsert('askHuman', pane('ask:1', 'c'.repeat(40), { kind: 'question', questions: [{ id: 'q0', text: '残しますか?', options: [{ id: '0', label: '残す' }, { id: '1', label: '消す', recommended: true }], allowText: true }] }));
		// ボードが起動したターミナルの待ちは、ボードのタスクの側に出る
		ledger.upsert('askHuman', pane('ask:2', PANE_KEY, { kind: 'question', questions: [{ id: 'q0', text: 'ボードの?', options: [], allowText: true }] }));
		ledger.upsert('panes', pane('perm:1', 'd'.repeat(40), { kind: 'permission', preface: 'Bash: rm -rf build', actions: yesNo }));
		ledger.upsert('panes', pane('perm:2', 'e'.repeat(40), { kind: 'permission', preface: 'Bash: npm test', actions: yesNo, inlineAllowed: true }));
		await timeout(80);
		const answer = (key: string, body: object, keyHash = BOARD_A, isRemote = false) => service.handle('POST', '/v1/asks/pane-answer', new URLSearchParams(), { key, answer: body }, keyHash, isRemote).then(response => `${response.status} ${JSON.stringify(response.body).slice(0, 40)}`);
		const pick = (optionId: string, extra: object = {}) => ({ type: 'answers', answers: [{ questionId: 'q0', optionIds: [optionId], ...extra }] });
		const responses = {
			fromRemote: await answer('pane:ask:1', pick('1'), BOARD_B, true),
			keyless: await service.handle('POST', '/v1/asks/pane-answer', new URLSearchParams(), { key: 'pane:ask:1', answer: pick('1') }, undefined, false).then(response => response.status),
			notAnOption: await answer('pane:ask:1', pick('7')),
			withText: await answer('pane:ask:1', pick('1', { text: 'rm -rf ~' })),
			boardTerminal: await answer('pane:ask:2', { type: 'answers', answers: [{ questionId: 'q0', text: 'x' }] }),
			notInlinePermission: await answer('pane:perm:1', { type: 'action', actionId: 'yes' }),
			option: await answer('pane:ask:1', pick('1')),
			again: await answer('pane:ask:1', pick('0')),
			permission: await answer('pane:perm:2', { type: 'action', actionId: 'yes' }),
		};
		await timeout(80);
		const last = seen.local.at(-1) ?? [];
		local.dispose();
		remote.dispose();
		keyless.dispose();
		assert.deepStrictEqual({
			responses,
			remote: seen.remote,
			// つないだ直後に空の一覧、台帳が変わったら今の一覧
			first: seen.local[0],
			listed: seen.local.find(asks => asks.length > 0)?.map(ask => [ask.key, ask.kind, ask.options?.map(option => option.label) ?? null]),
			busy: last.filter(ask => ask.busy).map(ask => ask.key),
			ledger: summary().filter(entry => entry.includes('pending')),
		}, {
			responses: {
				fromRemote: '403 {"error":"forbidden","message":"A task b',
				keyless: 503,
				notAnOption: '400 {"error":"invalid","message":"Answer wit',
				withText: '400 {"error":"invalid","message":"Answer wit',
				boardTerminal: '404 {"error":"not-found","message":"That que',
				notInlinePermission: '400 {"error":"invalid","message":"Answer wit',
				option: '200 {"ok":true}',
				again: '200 {"ok":false,"reason":"busy"}',
				// 受信箱の行で 1 押しで答えてよい許可でも、ボードからは答えさせない
				permission: '400 {"error":"invalid","message":"Answer wit',
			},
			remote: 0,
			first: [],
			listed: [
				['pane:perm:2', 'permission', null],
				['pane:perm:1', 'permission', null],
				['pane:ask:1', 'question', ['残す', '消す']],
			],
			busy: ['pane:ask:1'],
			ledger: ['pane:ask:1 waiting pending'],
		});
	});
});
