/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as sinon from 'sinon';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { fireParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisClaudeConfigDir, paradisCodexHome } from '../../../agentBrowser/node/paradisAgentHome.js';
import { ParadisMobileAgentChat, paradisClaudeAgentIdFromTranscriptPath, paradisClaudeRootTranscriptPath, paradisClaudeSubagentTranscriptCandidates, paradisCliDiscoveryCandidateIsFresh, paradisCodexThreadTargetsForPaneSessions, paradisConfirmedAgentPaneTokens, paradisHasPendingDuplicateQuestion, paradisIsCodexDaemonApprovalInteraction, paradisIsCodexRootThreadSource, paradisIsValidAgentInboundForTest, paradisParseClaudeTranscriptLineForTest, paradisParseCodexDetailLinesForTest, paradisParseCodexSessionMeta, paradisParseCodexThreadSource, paradisIsLateHookAfterTurnEnd, paradisParseCodexTranscriptLineForTest, paradisPickCurrentInteraction, paradisResolveHookSessionTranscript, paradisSelectUnambiguousSessionCandidate, paradisTakeLiveQuestionSyntheticId } from '../../node/paradisMobileAgentChat.js';
import { paradisCodexApprovalResultForTest, paradisParseCodexApprovalRequestForTest } from '../../node/paradisCodexLiveClient.js';

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
}

suite('ParadisMobileAgentChat', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());

	test('publishes only live panes with a confirmed agent session', () => {
		assert.deepStrictEqual(
			paradisConfirmedAgentPaneTokens(['pane-b', 'closed-pane', 'pane-a'], ['pane-a', 'plain-pane', 'pane-b']),
			['pane-a', 'pane-b'],
		);
	});

	test('uses globally unique pane tokens instead of window-local terminal IDs', () => {
		assert.deepStrictEqual(
			paradisConfirmedAgentPaneTokens(['window-2-pane-1'], ['window-1-pane-1', 'window-2-pane-1']),
			['window-2-pane-1'],
		);
	});

	test('routes each Codex Mobile thread to its newest pane socket', () => {
		assert.deepStrictEqual(paradisCodexThreadTargetsForPaneSessions([
			['pane-old', { agent: 'codex', sessionId: 'thread-1' }],
			['pane-claude', { agent: 'claude', sessionId: 'claude-session' }],
			['pane-two', { agent: 'codex', sessionId: 'thread-2' }],
			['pane-new', { agent: 'codex', sessionId: 'thread-1' }],
		], token => `/user-data/pcx/${token}.sock`), [
			{ threadId: 'thread-1', socketPath: '/user-data/pcx/pane-new.sock' },
			{ threadId: 'thread-2', socketPath: '/user-data/pcx/pane-two.sock' },
		]);
	});

	test('validates each mobile agent inbound shape before dispatch', () => {
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, token: 'pane-1', epoch: 'epoch-1', afterRev: -1 }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, token: 'pane-1', liveEncoding: 'agent-live-append-v1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'model-catalog', id: 1, requestId: 'request-1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'command-catalog', id: 1, token: 'pane-1', requestId: 'request-1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'settings-update', id: 1, requestId: 'request-1', model: 'gpt-5', effort: 'high' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'activity-detail', id: 1, requestId: 'request-1', epoch: 'epoch-1', activityId: 'agent-1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'action/answerQuestion', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'question-1', answers: [{ kind: 'multi', indices: [0, 2] }] }), true);

		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, epoch: 1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, afterRev: -2 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, liveEncoding: 1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, liveEncoding: 'x'.repeat(101) }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'model-catalog', id: 1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'command-catalog', id: 1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'command-catalog', id: 1, requestId: 'request-1', path: '/tmp' }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'settings-update', id: 1, requestId: 'request-1', model: 'gpt-5', effort: 3 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'activity-detail', id: 1, requestId: 'request-1', epoch: 'epoch-1' }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'action/answerQuestion', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'question-1', answers: [{ kind: 'multi', indices: [0, '2'] }] }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'unknown', id: 1 }), false);
	});

	test('requests an owning renderer cwd sync and delivers a reconnect error without a subscriber', async () => {
		const sent: unknown[] = [];
		const syncRequests: unknown[] = [];
		const clock = sinon.useFakeTimers();
		const chat = new ParadisMobileAgentChat(
			(_mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
			() => { },
			() => { },
			new NullLogService(),
			undefined,
			async () => true,
			owner => syncRequests.push(owner),
		);
		try {
			assert.strictEqual(chat.syncPanes(1, 'window-session', 3, 1, [{ terminalId: 7, token: 'pane-7' }]), true);
			chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify({
				t: 'command-catalog', id: 7, token: 'pane-7', requestId: 'request-1'
			})));
			await clock.tickAsync(25);
			chat.removePanes(1, 'window-session', 3);
			await clock.tickAsync(1175);

			assert.deepStrictEqual(syncRequests, [{
				windowId: 1,
				windowSession: 'window-session',
				rendererGeneration: 3,
				terminalId: 7,
				token: 'pane-7',
			}]);
			assert.deepStrictEqual(sent, [{
				t: 'command-catalog-error',
				id: 7,
				token: 'pane-7',
				requestId: 'request-1',
				message: 'PC側のエージェント接続を同期中です。詳細画面を再接続してからお試しください'
			}]);
		} finally {
			chat.dispose();
			clock.restore();
		}
	});

	test('preserves AskUserQuestion when a later hook arrives during path validation', async () => {
		const token = 'pane-question-order';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'question-order.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			tailers: Map<string, { currentInteraction(): { readonly kind: string } | null }>;
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);

			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'session-question-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
				toolInput: { questions: [{ question: '進めますか？', header: '確認', options: [{ label: 'はい' }, { label: 'いいえ' }] }] },
			});
			fireParadisAgentHookEvent({
				token, event: 'PermissionRequest', sessionId: 'session-question-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
			});

			await waitFor(() => access.tailers.get(token)?.currentInteraction()?.kind === 'question', 'AskUserQuestion was discarded');
			assert.strictEqual(access.tailers.get(token)?.currentInteraction()?.kind, 'question');
		} finally {
			chat.dispose();
		}
	});

	test('preserves AskUserQuestion hooks that arrive before the pane sync', async () => {
		const token = 'pane-pending-question-order';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'pending-question-order.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			hookProcessing: Map<string, Promise<void>>;
			tailers: Map<string, { currentInteraction(): { readonly kind: string } | null }>;
		};
		try {
			chat.setEagerTailing(true);
			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'session-pending-question-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
				toolInput: { questions: [{ question: '同期後も表示しますか？', header: '確認', options: [{ label: 'はい' }] }] },
			});
			fireParadisAgentHookEvent({
				token, event: 'PermissionRequest', sessionId: 'session-pending-question-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'pending hooks did not finish validation');

			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			await waitFor(() => access.tailers.get(token)?.currentInteraction()?.kind === 'question', 'pending AskUserQuestion was discarded');
			assert.strictEqual(access.tailers.get(token)?.currentInteraction()?.kind, 'question');
		} finally {
			chat.dispose();
		}
	});

	test('applies complete turn cleanup when Stop is overtaken during path validation', async () => {
		const token = 'pane-stop-order';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'stop-order.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			activeTurnTokens: Set<string>;
			lastTurnEndedAt: Map<string, number>;
			tailers: Map<string, { currentInteraction(): { readonly kind: string } | null }>;
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({
				token, event: 'UserPromptSubmit', sessionId: 'session-stop-order', transcriptPath, cwd: '/workspace',
				payload: { prompt: '作業を開始して' }, at: Date.now(),
			});
			await waitFor(() => access.activeTurnTokens.has(token), 'turn did not start');
			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'session-stop-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
				toolInput: { questions: [{ question: '続けますか？', header: '確認', options: [{ label: '続ける' }] }] },
			});
			await waitFor(() => access.tailers.get(token)?.currentInteraction()?.kind === 'question', 'question was not injected');

			fireParadisAgentHookEvent({
				token, event: 'Stop', sessionId: 'session-stop-order', transcriptPath, cwd: '/workspace', at: Date.now(),
			});
			fireParadisAgentHookEvent({
				token, event: 'MessageDisplay', sessionId: 'session-stop-order', transcriptPath, cwd: '/workspace',
				messageId: 'late-message', messageIndex: 0, messageDelta: '完了', messageFinal: true, at: Date.now(),
			});

			await waitFor(() => access.lastTurnEndedAt.has(token), 'turn end was not applied');
			await waitFor(() => access.tailers.get(token)?.currentInteraction() === null, 'turn end did not clear the pending interaction');
			assert.deepStrictEqual({
				active: access.activeTurnTokens.has(token),
				interaction: access.tailers.get(token)?.currentInteraction(),
			}, {
				active: false,
				interaction: null,
			});
		} finally {
			chat.dispose();
		}
	});

	test('keeps the Codex thread ID discovered from rollout session metadata', () => {
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta',
			payload: { cwd: '/workspace', id: 'thread-1' },
		})), { cwd: '/workspace', sessionId: 'thread-1' });
	});

	test('preserves the exact Codex command approval choices and their response payloads', () => {
		const parsed = paradisParseCodexApprovalRequestForTest({
			method: 'item/commandExecution/requestApproval', id: 'approval-1', params: {
				threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: 1,
				command: 'git add src/file.ts', cwd: '/workspace', reason: 'Git indexへの書き込み',
				availableDecisions: [
					'accept',
					{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'add'] } },
					'decline',
				],
			},
		});
		assert.deepStrictEqual(parsed?.interaction, {
			kind: 'approval', id: 'codex:s:approval-1', title: 'コマンドの実行許可',
			detail: 'git add src/file.ts\nGit indexへの書き込み\n/workspace',
			choices: [
				{ id: '0', label: '今回だけ許可', tone: 'approve' },
				{ id: '1', label: '同じ種類のコマンドを今後許可', tone: 'neutral' },
				{ id: '2', label: '拒否', tone: 'deny' },
			],
		});
		assert.deepStrictEqual(paradisCodexApprovalResultForTest(parsed!, '1'), {
			decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'add'] } },
		});
		assert.deepStrictEqual(paradisCodexApprovalResultForTest(parsed!, 'yes'), { decision: 'accept' });
		assert.deepStrictEqual(paradisCodexApprovalResultForTest(parsed!, 'no'), { decision: 'decline' });
		assert.strictEqual(paradisCodexApprovalResultForTest(parsed!, 'missing'), undefined);
	});

	test('maps Codex permission approval to requested subsets and an explicit denial', () => {
		const parsed = paradisParseCodexApprovalRequestForTest({
			method: 'item/permissions/requestApproval', id: 61, params: {
				threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', environmentId: 'local',
				startedAtMs: 1, cwd: '/workspace', reason: '共有フォルダへの書き込み',
				permissions: { network: null, fileSystem: { write: ['/workspace', '/shared'] } },
			},
		});
		assert.deepStrictEqual(parsed?.interaction.choices, [
			{ id: '0', label: '今回だけ許可', tone: 'approve' },
			{ id: '1', label: 'セッション中は許可', tone: 'neutral' },
			{ id: '2', label: '拒否', tone: 'deny' },
		]);
		assert.deepStrictEqual(paradisCodexApprovalResultForTest(parsed!, '1'), {
			permissions: { fileSystem: { write: ['/workspace', '/shared'] } }, scope: 'session',
		});
		assert.deepStrictEqual(paradisCodexApprovalResultForTest(parsed!, '2'), { permissions: {}, scope: 'turn' });
	});

	test('never falls a resolved Codex daemon approval back to PTY key injection', () => {
		assert.strictEqual(paradisIsCodexDaemonApprovalInteraction('codex:s:approval-1'), true);
		assert.strictEqual(paradisIsCodexDaemonApprovalInteraction('codex-status:thread-1'), true);
		assert.strictEqual(paradisIsCodexDaemonApprovalInteraction('approval:epoch:1'), false);
	});

	test('keeps current Codex nested thread metadata', () => {
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: {
				cwd: '/workspace', id: 'child', parent_thread_id: 'parent', depth: 2,
				agent_path: '/root/planner/researcher', agent_nickname: 'researcher',
			},
		})), {
			cwd: '/workspace', sessionId: 'child', subagent: true, parentThreadId: 'parent', depth: 2,
			agentPath: '/root/planner/researcher', agentNickname: 'researcher',
		});
	});

	test('distinguishes Codex root threads from nested subagent sources', () => {
		assert.strictEqual(paradisIsCodexRootThreadSource('cli'), true);
		assert.strictEqual(paradisIsCodexRootThreadSource(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } })), false);
	});

	test('parses current Codex nested thread source', () => {
		assert.deepStrictEqual(paradisParseCodexThreadSource(JSON.stringify({
			subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 3, agent_nickname: 'verifier', agent_role: 'reviewer' } },
		})), { parentThreadId: 'parent', depth: 3, agentNickname: 'verifier', agentRole: 'reviewer' });
	});

	test('uses creation time for new sessions and update time for resumed sessions', () => {
		const oldButUpdated = { mtime: 200, createdAt: 50 };
		assert.strictEqual(paradisCliDiscoveryCandidateIsFresh(oldButUpdated, 100, 'new'), false);
		assert.strictEqual(paradisCliDiscoveryCandidateIsFresh(oldButUpdated, 100, 'fork'), false);
		assert.strictEqual(paradisCliDiscoveryCandidateIsFresh(oldButUpdated, 100, 'resume'), true);
	});

	test('rejects non-session metadata', () => {
		assert.strictEqual(paradisParseCodexSessionMeta('{"type":"event_msg","payload":{}}'), undefined);
	});

	test('keeps a completed Codex web search paired when the current rollout omits an id', () => {
		const parsed = paradisParseCodexTranscriptLineForTest(JSON.stringify({
			timestamp: '2026-07-13T00:00:00.000Z', type: 'response_item',
			payload: { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'Codex app-server' } },
		}));
		assert.deepStrictEqual(parsed.messages, [
			{ role: 'assistant', kind: 'tool_use', tool: 'web_search', text: 'Codex app-server', ts: 1783900800000, toolUseId: 'web:2026-07-13T00:00:00.000Z:19gx9vl' },
			{ role: 'tool', kind: 'tool_result', text: 'Codex app-server', ts: 1783900800000, toolUseId: 'web:2026-07-13T00:00:00.000Z:19gx9vl' },
		]);
	});

	test('extracts current Codex rollout sub_agent_activity for the activity tracker', () => {
		const parsed = paradisParseCodexTranscriptLineForTest(JSON.stringify({
			timestamp: '2026-07-13T00:00:00.000Z', type: 'event_msg',
			payload: { type: 'sub_agent_activity', event_id: 'event-1', occurred_at_ms: 1783900800123, agent_thread_id: 'thread-2', agent_path: '/root/reviewer', kind: 'started' },
		}));
		assert.deepStrictEqual(parsed.activity, {
			id: 'thread-2', agentPath: '/root/reviewer', kind: 'started', at: 1783900800123,
		});
	});

	test('extracts Codex task_started so the PC workspace can show working state without hooks', () => {
		const parsed = paradisParseCodexTranscriptLineForTest(JSON.stringify({
			timestamp: '2026-07-13T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' },
		}));
		assert.strictEqual(parsed.turn, 'started');
	});

	test('builds SubAgent detail from a persisted Codex child rollout', () => {
		assert.deepStrictEqual(paradisParseCodexDetailLinesForTest([
			JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '調査して' }] } }),
			JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '確認中' }] } }),
			JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完了しました' }] } }),
		]), [
			{ role: 'user', kind: 'text', text: '調査して' },
			{ role: 'assistant', kind: 'thinking', text: '確認中' },
			{ role: 'assistant', kind: 'text', text: '完了しました' },
		]);
	});

	test('prefers the current Claude SubagentStop agent_transcript_path', () => {
		assert.deepStrictEqual(paradisClaudeSubagentTranscriptCandidates(
			'/Users/test/.claude/projects/workspace/session.jsonl', 'abc-123', '/Users/test/.claude/projects/workspace/session/subagents/agent-abc-123.jsonl',
		), [
			'/Users/test/.claude/projects/workspace/session/subagents/agent-abc-123.jsonl',
			'/Users/test/.claude/projects/workspace/subagents/agent-abc-123.jsonl',
		]);
	});

	test('maps nested Claude hook transcripts back to their parent agent and root session', () => {
		const path = '/Users/test/.claude/projects/workspace/session/subagents/agent-parent-123.jsonl';
		assert.strictEqual(paradisClaudeAgentIdFromTranscriptPath(path), 'parent-123');
		assert.strictEqual(paradisClaudeRootTranscriptPath(path), '/Users/test/.claude/projects/workspace/session.jsonl');
		assert.strictEqual(paradisClaudeAgentIdFromTranscriptPath('/Users/test/.claude/projects/workspace/session.jsonl'), undefined);
	});

	test('keeps the pane session and epoch when a Codex subagent thread fires a hook', async () => {
		const token = 'pane-codex-subagent';
		const parentPath = join(paradisCodexHome(), 'sessions', 'para-code-tests', 'rollout-parent.jsonl');
		const childPath = join(paradisCodexHome(), 'sessions', 'para-code-tests', 'rollout-child.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			paneSessions: Map<string, { readonly transcriptPath: string; readonly sessionId?: string }>;
			codexRolloutOrigins: Map<string, string>;
			tailers: Map<string, { readonly epoch: string }>;
			hookProcessing: Map<string, Promise<void>>;
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			// rolloutの素性判定そのものは paradisParseCodexSessionMeta 側のテストで担保する。
			// ここは「子と分かっているhookがペインを乗っ取らないこと」だけを見る。
			access.codexRolloutOrigins.set(parentPath, 'root');
			access.codexRolloutOrigins.set(childPath, 'subagent');

			fireParadisAgentHookEvent({
				token, event: 'UserPromptSubmit', sessionId: 'thread-parent', transcriptPath: parentPath,
				cwd: '/workspace', payload: { prompt: 'テストを直して' }, at: Date.now(),
			});
			await waitFor(() => access.paneSessions.get(token)?.transcriptPath === parentPath, 'parent session was not confirmed');
			const epoch = access.tailers.get(token)?.epoch;

			// SubAgentのthreadが自分のrolloutを指すhookを撃つ（tool実行のたびに起きる）。
			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'thread-child', transcriptPath: childPath,
				cwd: '/workspace', toolName: 'Bash', toolUseId: 'tool-1', at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'child hook was not processed');

			assert.deepStrictEqual({
				transcriptPath: access.paneSessions.get(token)?.transcriptPath,
				sessionId: access.paneSessions.get(token)?.sessionId,
				epochChanged: access.tailers.get(token)?.epoch !== epoch,
			}, {
				transcriptPath: parentPath,
				sessionId: 'thread-parent',
				epochChanged: false,
			});
		} finally {
			chat.dispose();
		}
	});

	test('detects a Codex subagent rollout whose session_id names the parent thread', () => {
		// 現行Codexが実際に書く形。子rolloutの session_id は「親の」thread IDで、自分のIDは id 側。
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: {
				cwd: '/workspace', session_id: 'thread-parent', id: 'thread-child', parent_thread_id: 'thread-parent',
				thread_source: 'subagent',
				source: { subagent: { thread_spawn: { parent_thread_id: 'thread-parent', depth: 1, agent_path: '/root/tests', agent_nickname: 'Mill' } } },
			},
		})), {
			cwd: '/workspace', sessionId: 'thread-parent', subagent: true, parentThreadId: 'thread-parent',
			depth: 1, agentPath: '/root/tests', agentNickname: 'Mill',
		});
	});

	test('detects a Codex subagent rollout that only differs by its own thread id', () => {
		// source / thread_source が無い形。親を指すIDは、session_id（=親）ではなく id（=自分）と
		// 比べないと子だと分からない。この比較先がこの修正の本丸。
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: { cwd: '/workspace', session_id: 'thread-parent', id: 'thread-child', parent_thread_id: 'thread-parent' },
		})), { cwd: '/workspace', sessionId: 'thread-parent', subagent: true, parentThreadId: 'thread-parent' });
	});

	test('detects a Codex subagent rollout from either spawn marker alone', () => {
		const parse = (payload: object) => paradisParseCodexSessionMeta(JSON.stringify({ type: 'session_meta', payload: { cwd: '/workspace', ...payload } }));
		assert.deepStrictEqual([
			// thread_source だけ（親IDが読めなくても子と分かる）。
			parse({ id: 'thread-child', thread_source: 'subagent' }),
			// source.subagent.thread_spawn だけ。
			parse({ id: 'thread-child', source: { subagent: { thread_spawn: { parent_thread_id: 'thread-parent' } } } }),
		], [
			{ cwd: '/workspace', sessionId: 'thread-child', subagent: true },
			{ cwd: '/workspace', sessionId: 'thread-child', subagent: true, parentThreadId: 'thread-parent' },
		]);
	});

	test('keeps a root Codex rollout free of a subagent marker', () => {
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: { cwd: '/workspace', session_id: 'thread-root', id: 'thread-root' },
		})), { cwd: '/workspace', sessionId: 'thread-root' });
		// forkやresumeで自分自身を指す parent_thread_id が入っても root のまま。
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: { cwd: '/workspace', id: 'thread-root', parent_thread_id: 'thread-root' },
		})), { cwd: '/workspace', sessionId: 'thread-root' });
	});

	test('never lets a nested agent hook claim the pane session', () => {
		const claudeChild = '/Users/test/.claude/projects/workspace/session/subagents/agent-parent-123.jsonl';
		const claudeRoot = '/Users/test/.claude/projects/workspace/session.jsonl';
		const codexChild = '/Users/test/.codex/sessions/2026/07/29/rollout-child.jsonl';
		const codexParent = '/Users/test/.codex/sessions/2026/07/29/rollout-parent.jsonl';
		const resolve = (hookTranscriptPath: string, paneTranscriptPath: string | undefined, claudeNestedAgentId?: string, codexOrigin?: 'root' | 'subagent' | 'unknown') =>
			paradisResolveHookSessionTranscript({ hookTranscriptPath, paneTranscriptPath, claudeNestedAgentId, codexOrigin });

		assert.deepStrictEqual([
			// root threadのhookはそのままペインのセッションになる（未確定でも、別セッションからの切替でも）。
			resolve(codexParent, undefined, undefined, 'root'),
			resolve(codexParent, '/Users/test/.codex/sessions/2026/07/29/rollout-previous.jsonl', undefined, 'root'),
			// Claudeのsidechain: 既知rootを保ち、未確定ならpathからrootを復元する。
			resolve(claudeChild, claudeRoot, 'parent-123'),
			resolve(claudeChild, undefined, 'parent-123'),
			// 規約外のpathでrootを復元できないsidechainは、hookのpathへフォールバックする。
			resolve('/subagents/agent-parent-123.jsonl', undefined, 'parent-123'),
			// Codexのsubagent thread: 親のrolloutを保つ。親が未確定なら子で確定させない。
			resolve(codexChild, codexParent, undefined, 'subagent'),
			resolve(codexChild, undefined, undefined, 'subagent'),
			// 素性を読めなかったrollout: 確定済みペインではrebindを見送り、未確定なら確定させる。
			resolve(codexChild, codexParent, undefined, 'unknown'),
			resolve(codexChild, undefined, undefined, 'unknown'),
		], [
			{ kind: 'session', transcriptPath: codexParent, nested: undefined },
			{ kind: 'session', transcriptPath: codexParent, nested: undefined },
			{ kind: 'session', transcriptPath: claudeRoot, nested: 'claude' },
			{ kind: 'session', transcriptPath: claudeRoot, nested: 'claude' },
			{ kind: 'session', transcriptPath: '/subagents/agent-parent-123.jsonl', nested: 'claude' },
			{ kind: 'session', transcriptPath: codexParent, nested: 'codex' },
			{ kind: 'drop' },
			{ kind: 'session', transcriptPath: codexParent, nested: 'codex' },
			{ kind: 'session', transcriptPath: codexChild, nested: undefined },
		]);
	});

	test('does not guess when multiple fresh sessions match the same cwd', () => {
		assert.strictEqual(paradisSelectUnambiguousSessionCandidate([
			{ transcriptPath: '/sessions/a.jsonl', mtime: 20 },
			{ transcriptPath: '/sessions/b.jsonl', mtime: 21 },
		], 10, new Set()), undefined);
	});

	test('selects the sole unclaimed fresh session', () => {
		assert.deepStrictEqual(paradisSelectUnambiguousSessionCandidate([
			{ transcriptPath: '/sessions/a.jsonl', mtime: 20 },
			{ transcriptPath: '/sessions/b.jsonl', mtime: 21 },
		], 10, new Set(['/sessions/a.jsonl'])), { transcriptPath: '/sessions/b.jsonl', mtime: 21 });
	});

	test('classifies a teammate report separately from user input', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({
			type: 'user',
			message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="reviewer" summary="レビュー完了">問題はありません。</teammate-message>\nThis came from another Claude session.' },
		}));
		assert.strictEqual(parsed.userText, false);
		assert.deepStrictEqual(parsed.messages, [{
			role: 'assistant', kind: 'peer_message', text: '問題はありません。', peerName: 'reviewer', peerSummary: 'レビュー完了',
		}]);
	});

	test('hides teammate idle notifications', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({
			type: 'user',
			message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="reviewer">{"type":"idle_notification","from":"reviewer"}</teammate-message>' },
		}));
		assert.strictEqual(parsed.userText, false);
		assert.deepStrictEqual(parsed.messages, []);
	});

	test('keeps ordinary Claude transcript user text unchanged', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({ type: 'user', message: { content: '通常の質問です' } }));
		assert.strictEqual(parsed.userText, true);
		assert.deepStrictEqual(parsed.messages, [{ role: 'user', kind: 'text', text: '通常の質問です' }]);
	});

	test('does not misclassify a user asking about teammate markup', () => {
		const text = '<teammate-message teammate_id="example">とは何ですか？';
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({ type: 'user', message: { content: text } }));
		assert.strictEqual(parsed.userText, true);
		assert.deepStrictEqual(parsed.messages, [{ role: 'user', kind: 'text', text }]);
	});

	test('matches a transcript question to the injected live question by exact content key', () => {
		const liveQuestions = new Map([['進めますか？\0はい\x01いいえ', ['live:1:0']]]);
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }] }),
			remaining: liveQuestions.size,
		}, { taken: 'live:1:0', remaining: 0 });
	});

	test('falls back to a text-only match when one side lost its options (e.g. Windows hook mangling)', () => {
		// ライブ注入側は選択肢つき、transcript 側は選択肢欠落 → 内容キー完全一致は外れるが
		// 質問文のみで曖昧さなく1件に絞れるため間引く（逆方向も同じ経路で一致する）
		const liveQuestions = new Map([['進めますか？\0はい\x01いいえ', ['live:1:0']]]);
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？' }),
			remaining: liveQuestions.size,
		}, { taken: 'live:1:0', remaining: 0 });
	});

	test('does not text-match when multiple live questions share the same text (ambiguous)', () => {
		const liveQuestions = new Map([
			['進めますか？\0はい\x01いいえ', ['live:1:0']],
			['進めますか？\0A\x01B', ['live:1:1']],
		]);
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？' }),
			remaining: liveQuestions.size,
		}, { taken: undefined, remaining: 2 });
	});

	test('does not text-match a different question text or a partial prefix', () => {
		const liveQuestions = new Map([['進めますか？（詳細版）\0はい', ['live:1:0']]]);
		assert.deepStrictEqual({
			differentText: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '止めますか？' }),
			prefixText: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？' }),
			remaining: liveQuestions.size,
		}, { differentText: undefined, prefixText: undefined, remaining: 1 });
	});

	test('skips a live injection when the transcript already shows the same unanswered question', () => {
		// transcript が先着（選択肢つき）、hook 遅延側は選択肢欠落 → 質問文一致で重複注入を抑止。
		// 回答済みの同文質問しか無い場合は抑止しない（新しい質問として注入される）
		const messages = [
			{ kind: 'question' as const, text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }], toolUseId: 'tool-1' },
		];
		assert.deepStrictEqual({
			pending: paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '進めますか？' }),
			answered: paradisHasPendingDuplicateQuestion(messages, new Set(), { text: '進めますか？' }),
			differentText: paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '止めますか？' }),
		}, { pending: true, answered: false, differentText: false });
	});

	test('never text-matches when both sides carry different non-empty options (distinct questions)', () => {
		// 同文でも両側に選択肢が付いていて食い違う場合は別質問。誤 dedup で実在質問を隠したり、
		// 回答を別質問へ誤紐付けしたりしない
		const liveQuestions = new Map([['進めますか？\0A\x01B', ['live:1:0']]]);
		const messages = [
			{ kind: 'question' as const, text: '進めますか？', options: [{ label: 'A' }, { label: 'B' }], toolUseId: 'tool-1' },
		];
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？', options: [{ label: 'C' }, { label: 'D' }] }),
			remaining: liveQuestions.size,
			suppressed: paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '進めますか？', options: [{ label: 'C' }, { label: 'D' }] }),
		}, { taken: undefined, remaining: 1, suppressed: false });
	});

	test('text-matches in the reverse direction: existing question lost its options, incoming has them', () => {
		const liveQuestions = new Map([['進めますか？\0', ['live:1:0']]]);
		const messages = [
			{ kind: 'question' as const, text: '進めますか？', toolUseId: 'tool-1' },
		];
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }] }),
			suppressed: paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }] }),
		}, { taken: 'live:1:0', suppressed: true });
	});

	test('prefers the exact content-key match and shifts synthetic ids one at a time', () => {
		const liveQuestions = new Map([
			['進めますか？\0はい\x01いいえ', ['live:1:0', 'live:1:1']],
			['進めますか？\0', ['live:1:9']],
		]);
		const withOptions = { text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }] };
		assert.deepStrictEqual({
			first: paradisTakeLiveQuestionSyntheticId(liveQuestions, withOptions),
			sizeAfterFirst: liveQuestions.size,
			second: paradisTakeLiveQuestionSyntheticId(liveQuestions, withOptions),
			sizeAfterSecond: liveQuestions.size,
		}, { first: 'live:1:0', sizeAfterFirst: 2, second: 'live:1:1', sizeAfterSecond: 1 });
	});

	test('ignores non-question messages and questions without a toolUseId in the pending scan', () => {
		const messages = [
			{ kind: 'text' as const, text: '進めますか？' },
			{ kind: 'question' as const, text: '進めますか？' },
		];
		assert.strictEqual(paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '進めますか？' }), false);
	});

	// 承認と質問の優先順位は過去に両方向のバグを出しているので、境界を固定しておく。
	suite('current interaction priority', () => {
		const approval = { kind: 'approval' as const, id: 'approval:1:0', title: '操作の許可' };
		const question = { role: 'assistant' as const, kind: 'question' as const, text: '進めますか？', ts: 0, rev: 1, toolUseId: 'live:1:0' };
		const answered = { role: 'assistant' as const, kind: 'question' as const, text: '古い質問', ts: 0, rev: 0, toolUseId: 'live:1:9' };

		test('prefers an unanswered question over a stale approval that never got cleared', () => {
			assert.deepStrictEqual(
				paradisPickCurrentInteraction([answered, question], new Set(['live:1:0']), approval),
				{ kind: 'question', id: 'live:1:0' },
			);
		});

		test('falls back to the approval once every question has been answered', () => {
			assert.deepStrictEqual(
				paradisPickCurrentInteraction([answered, question], new Set(), approval),
				approval,
			);
		});

		test('groups multi-question batches under their shared group id', () => {
			const grouped = { ...question, questionGroup: 'liveg:1:0' };
			assert.deepStrictEqual(
				paradisPickCurrentInteraction([grouped], new Set(['live:1:0']), undefined),
				{ kind: 'question', id: 'liveg:1:0' },
			);
		});

		test('returns null when neither a pending question nor an approval exists', () => {
			assert.strictEqual(paradisPickCurrentInteraction([answered], new Set(), undefined), null);
		});
	});

	// ターン終了直後に折り返してくる hook で live 状態を作り直すと、それを消すイベントが
	// 二度と来ない（モバイルの「応答を生成中」が伸び続ける症状）。
	suite('late hooks after a turn ended', () => {
		test('drops live updates that arrive just after the turn ended', () => {
			assert.deepStrictEqual({
				messageDisplay: paradisIsLateHookAfterTurnEnd('MessageDisplay', 1_000_500, 1_000_000),
				postToolUse: paradisIsLateHookAfterTurnEnd('PostToolUse', 1_002_999, 1_000_000),
				permissionRequest: paradisIsLateHookAfterTurnEnd('PermissionRequest', 1_000_000, 1_000_000),
			}, { messageDisplay: true, postToolUse: true, permissionRequest: true });
		});

		test('keeps updates once the window has passed or no turn has ended', () => {
			assert.deepStrictEqual({
				afterWindow: paradisIsLateHookAfterTurnEnd('MessageDisplay', 1_003_001, 1_000_000),
				noTurnEnd: paradisIsLateHookAfterTurnEnd('MessageDisplay', 1_000_500, undefined),
			}, { afterWindow: false, noTurnEnd: false });
		});

		test('never drops turn boundaries themselves', () => {
			assert.deepStrictEqual({
				userPromptSubmit: paradisIsLateHookAfterTurnEnd('UserPromptSubmit', 1_000_500, 1_000_000),
				stop: paradisIsLateHookAfterTurnEnd('Stop', 1_000_500, 1_000_000),
				sessionEnd: paradisIsLateHookAfterTurnEnd('SessionEnd', 1_000_500, 1_000_000),
			}, { userPromptSubmit: false, stop: false, sessionEnd: false });
		});
	});
});
