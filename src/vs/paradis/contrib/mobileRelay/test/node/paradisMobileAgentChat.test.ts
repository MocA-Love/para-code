/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisMobileAgentChat, paradisClaudeAgentIdFromTranscriptPath, paradisClaudeRootTranscriptPath, paradisClaudeSubagentTranscriptCandidates, paradisCliDiscoveryCandidateIsFresh, paradisConfirmedAgentPaneTokens, paradisIsCodexDaemonApprovalInteraction, paradisIsCodexRootThreadSource, paradisIsValidAgentInboundForTest, paradisParseClaudeTranscriptLineForTest, paradisParseCodexDetailLinesForTest, paradisParseCodexSessionMeta, paradisParseCodexThreadSource, paradisParseCodexTranscriptLineForTest, paradisSelectUnambiguousSessionCandidate } from '../../node/paradisMobileAgentChat.js';
import { paradisCodexApprovalResultForTest, paradisParseCodexApprovalRequestForTest } from '../../node/paradisCodexLiveClient.js';

suite('ParadisMobileAgentChat', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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

	test('validates each mobile agent inbound shape before dispatch', () => {
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, token: 'pane-1', epoch: 'epoch-1', afterRev: -1 }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'model-catalog', id: 1, requestId: 'request-1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'command-catalog', id: 1, token: 'pane-1', requestId: 'request-1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'settings-update', id: 1, requestId: 'request-1', model: 'gpt-5', effort: 'high' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'activity-detail', id: 1, requestId: 'request-1', epoch: 'epoch-1', activityId: 'agent-1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'action/answerQuestion', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'question-1', answers: [{ kind: 'multi', indices: [0, 2] }] }), true);

		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, epoch: 1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, afterRev: -2 }), false);
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
			await new Promise(resolve => setTimeout(resolve, 25));
			chat.removePanes(1, 'window-session', 3);
			await new Promise(resolve => setTimeout(resolve, 1175));

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
			cwd: '/workspace', sessionId: 'child', parentThreadId: 'parent', depth: 2,
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
});
