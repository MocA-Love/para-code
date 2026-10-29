/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { fireParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { ParadisMobileAgentChat } from '../../node/paradisMobileAgentChat.js';

// Codex の承認のカードを待つこと（自動の審査が先に決める）と、モデルが混み合って止まったターンを自動で続けること。
// rollout の行の形は codex-cli 0.165.0 を偽の API サーバーで動かして写したもの（2026-10-29）。

const THREAD = '01a18692-2cd8-7230-848e-c3681f9fe6bc';

interface IMessage { readonly role: string; readonly kind: string; readonly text: string; readonly tool?: string; readonly notice?: true }
interface ITailerAccess {
	readonly ready: Promise<void>;
	readonly epoch: string;
	readonly messages: readonly IMessage[];
	currentInteraction(): { readonly kind: string; readonly id: string } | null;
	hasPendingApproval(): boolean;
}
interface IChatAccess {
	codexApprovalHoldMs: number;
	codexOverloadRetryDelaysMs: readonly number[];
	readonly tailers: Map<string, ITailerAccess>;
	readonly hookProcessing: Map<string, Promise<void>>;
	readonly codexRolloutOrigins: Map<string, string>;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
}

function line(type: string, payload: Record<string, unknown>): string {
	return `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
}

interface IHarness {
	readonly token: string;
	readonly rollout: string;
	readonly chat: ParadisMobileAgentChat;
	readonly access: IChatAccess;
	readonly actions: Record<string, unknown>[];
	tailer(): ITailerAccess;
	hook(event: string, extra?: Record<string, unknown>): Promise<void>;
	append(...lines: string[]): Promise<void>;
}

async function withCodexHarness(run: (harness: IHarness) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-codex-overload-')));
	const previous = process.env['CODEX_HOME'];
	process.env['CODEX_HOME'] = root;
	const folder = join(root, 'sessions', '2026', '10', '29');
	await mkdir(folder, { recursive: true });
	const rollout = join(folder, `rollout-2026-10-29T16-31-29-${THREAD}.jsonl`);
	await writeFile(rollout, line('session_meta', { id: THREAD, cwd: '/workspace', originator: 'codex-tui', cli_version: '0.165.0', source: 'cli' }));
	const token = 'pane-codex-overload';
	const actions: Record<string, unknown>[] = [];
	const chat = new ParadisMobileAgentChat(
		() => { },
		(_mobileId, _windowId, _windowSession, _generation, payload) => actions.push(JSON.parse(new TextDecoder().decode(payload))),
		() => { }, new NullLogService(),
	);
	const access = chat as unknown as IChatAccess;
	access.codexApprovalHoldMs = 80;
	access.codexOverloadRetryDelaysMs = [40, 40, 2_000];
	const harness: IHarness = {
		token, rollout, chat, access, actions,
		tailer: () => access.tailers.get(token)!,
		hook: async (event, extra) => {
			fireParadisAgentHookEvent({ token, event, sessionId: THREAD, transcriptPath: rollout, cwd: '/workspace', at: Date.now(), ...extra });
			await waitFor(() => !access.hookProcessing.has(token), `${event} was not processed`);
		},
		append: async (...lines) => appendFile(rollout, lines.join('')),
	};
	try {
		chat.setEagerTailing(true);
		assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
		access.codexRolloutOrigins.set(rollout, 'root');
		await harness.hook('UserPromptSubmit', { payload: { prompt: 'ログインして' } });
		await waitFor(() => access.tailers.has(token), 'the pane session was not established');
		await harness.tailer().ready;
		await run(harness);
	} finally {
		chat.dispose();
		if (previous === undefined) {
			delete process.env['CODEX_HOME'];
		} else {
			process.env['CODEX_HOME'] = previous;
		}
		await rm(root, { recursive: true, force: true });
	}
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const approvalCards = (tailer: ITailerAccess) => tailer.messages.filter(message => message.tool === 'approval_request').length;

suite('ParadisMobileAgentChat with Codex', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('holds a Codex approval card until the auto-reviewer had time, and never shows one it settled', () => withCodexHarness(async harness => {
		const tool = { toolName: 'mcp__para_browser__click_by', toolInput: { role: 'button', name: 'ログイン' } };
		// 自動の審査が数秒で許可した（PostToolUse が来た）
		await harness.hook('PreToolUse', { ...tool, toolUseId: 'call_1' });
		await harness.hook('PermissionRequest', tool);
		const notifyHold = harness.chat.codexApprovalNotifyHold(harness.token);
		const whileHeld = { card: harness.tailer().currentInteraction(), pending: harness.tailer().hasPendingApproval(), notifyHeld: notifyHold !== undefined };
		await harness.hook('PostToolUse', { ...tool, toolUseId: 'call_1' });
		await sleep(160);
		const settled = {
			card: harness.tailer().currentInteraction(), cards: approvalCards(harness.tailer()), pending: harness.tailer().hasPendingApproval(),
			settledWhileHeld: harness.chat.codexHeldApprovalSettledSince(harness.token, notifyHold?.since ?? 0),
			notifyHeldAfter: harness.chat.codexApprovalNotifyHold(harness.token) !== undefined,
		};

		// 審査が決めないまま待ち終えた → カードを出す。その後、審査の拒否が rollout に書かれたら消える（hook は来ない）
		await harness.hook('PreToolUse', { ...tool, toolUseId: 'call_2' });
		await harness.hook('PermissionRequest', tool);
		await waitFor(() => harness.tailer().currentInteraction()?.kind === 'approval', 'the held approval was never shown');
		const shown = harness.tailer().currentInteraction()?.id;
		await harness.append(
			line('response_item', { type: 'function_call', name: 'click_by', namespace: 'mcp__para_browser', arguments: '{"role":"button","name":"ログイン"}', call_id: 'call_2' }),
			line('response_item', { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'This action was rejected due to unacceptable risk.\nReason: fake deny' }] }),
		);
		await waitFor(() => harness.tailer().currentInteraction() === null, 'the denied approval stayed on the card');

		assert.deepStrictEqual({ whileHeld, settled, shown, cards: approvalCards(harness.tailer()), pending: harness.tailer().hasPendingApproval() }, {
			whileHeld: { card: null, pending: true, notifyHeld: true },
			settled: { card: null, cards: 0, pending: false, settledWhileHeld: true, notifyHeldAfter: false },
			shown: 'call_2',
			cards: 1,
			pending: false,
		});
	}));

	test('sends continue to the owning window after a capacity error and says so in the conversation', () => withCodexHarness(async harness => {
		const overloaded = line('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: null, error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' } });
		await harness.append(line('event_msg', { type: 'task_started', turn_id: 'turn-1' }), overloaded);
		await waitFor(() => harness.chat.isCodexAutoContinueWaiting(harness.token), 'the continue was not scheduled');
		await waitFor(() => harness.actions.some(action => action.t === 'action/autoContinue'), 'the window was not asked to send');
		const request = harness.actions.find(action => action.t === 'action/autoContinue')!;
		// 持ち主でないウィンドウの引き受けは断り、持ち主の 1 回目だけを受ける
		const claims = [
			harness.chat.reportCodexAutoContinue(harness.token, request.requestId as string, 'claim', 2, 'window-session'),
			harness.chat.reportCodexAutoContinue(harness.token, request.requestId as string, 'claim', 1, 'window-session'),
			harness.chat.reportCodexAutoContinue(harness.token, request.requestId as string, 'claim', 1, 'window-session'),
		];
		// 送った continue のターン（取りやめない）がまた混み合いで終わる → もう一度待つ
		await harness.append(line('event_msg', { type: 'task_started', turn_id: 'turn-2' }), overloaded);
		await waitFor(() => harness.actions.filter(action => action.t === 'action/autoContinue').length === 2, 'the second continue was not asked');
		// 待つ間にユーザーが送ったターンが始まる → 取りやめる
		const second = harness.actions.filter(action => action.t === 'action/autoContinue')[1];
		harness.chat.reportCodexAutoContinue(harness.token, second.requestId as string, 'claim', 1, 'window-session');
		await harness.append(line('event_msg', { type: 'task_started', turn_id: 'turn-3' }), overloaded);
		await waitFor(() => harness.chat.isCodexAutoContinueWaiting(harness.token), 'the third wait did not start');
		await harness.append(line('event_msg', { type: 'task_started', turn_id: 'turn-4' }));
		await waitFor(() => !harness.chat.isCodexAutoContinueWaiting(harness.token), 'the wait was not cancelled');
		await sleep(80);
		const notices = harness.tailer().messages.filter(message => message.notice === true).map(message => message.text);
		assert.deepStrictEqual({
			request: { t: request.t, id: request.id, token: request.token, since: typeof request.since },
			claims,
			asked: harness.actions.filter(action => action.t === 'action/autoContinue').length,
			notices,
		}, {
			request: { t: 'action/autoContinue', id: 1, token: harness.token, since: 'number' },
			claims: [false, true, false],
			asked: 2,
			notices: [
				'モデルが混み合っていて止まりました。0 秒後に自動で「continue」を送ります（1/3 回目）',
				'自動で「continue」を送りました（1/3 回目）',
				'モデルが混み合っていて止まりました。0 秒後に自動で「continue」を送ります（2/3 回目）',
				'自動で「continue」を送りました（2/3 回目）',
				'モデルが混み合っていて止まりました。2 秒後に自動で「continue」を送ります（3/3 回目）',
				'ほかの入力があったので、自動で続けるのをやめました',
			],
		});
	}));
});
