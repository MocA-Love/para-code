/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex の rollout の行（テスト用）。手元の実データ（codex-cli 0.149.1〜0.159.3、2026-10-03 に確認）から
// 行の形・フィールド名・content_item_kinds の並び・メッセージの見出しをそのまま写し、本文・パス・ID・
// 暗号化された本文は匿名のものへ置き換えた。

/** 暗号化された本文（Fernet の token の形だけを真似たもの。中身は無い）。 */
export const CODEX_FIXTURE_ENCRYPTED = 'gAAAAABqvtHrFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTURE0123456789_-';

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ timestamp, type, payload });
}

function userMessage(timestamp: string, texts: readonly string[], kinds?: readonly string[]): string {
	return line(timestamp, 'response_item', {
		type: 'message', role: 'user',
		content: texts.map(text => text === '[image]' ? { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' } : { type: 'input_text', text }),
		...(kinds !== undefined ? { internal_chat_message_metadata_passthrough: { turn_id: 'turn-1', content_item_kinds: kinds } } : {}),
	});
}

/** 差し込み・発言の見本。`injected` は表示しないもの、`authored` はユーザーの発言として残すもの。 */
export const CODEX_FIXTURE_USER_MESSAGES = {
	injected: {
		// 0.159.2: プロジェクトに AGENTS.md が無い（グローバルだけ）ときは見出しに ` for <path>` が付かない
		agentsMdGlobalWithKinds: userMessage('2026-10-01T21:34:04.748Z', ['# AGENTS.md instructions\n\n<INSTRUCTIONS>\n# グローバルルール\n- 常に日本語で話す\n</INSTRUCTIONS>', '<environment_context>\n  <cwd>/workspace/app</cwd>\n</environment_context>'], ['agents_md.instructions', 'environments.environment_context']),
		agentsMdGlobalLegacy: userMessage('2026-08-01T00:00:00.000Z', ['# AGENTS.md instructions\n\n<INSTRUCTIONS>\n# グローバルルール\n</INSTRUCTIONS>']),
		agentsMdProjectLegacy: userMessage('2026-08-01T00:00:00.000Z', ['# AGENTS.md instructions for /workspace/app\n\n<INSTRUCTIONS>\nテストを先に書く\n</INSTRUCTIONS>']),
		// 0.148〜0.153.4: plugin の案内が user role で入る
		recommendedPluginsLegacy: userMessage('2026-08-24T00:00:00.000Z', ['<recommended_plugins>\n- github: GitHub の操作\n</recommended_plugins>']),
		recommendedPluginsWithKinds: userMessage('2026-09-01T00:00:00.000Z', ['<recommended_plugins>\n- github\n</recommended_plugins>', '# AGENTS.md instructions for /workspace/app\n\n<INSTRUCTIONS>\nx\n</INSTRUCTIONS>', '<environment_context>\n</environment_context>'], ['plugins.recommendations', 'agents_md.instructions', 'environments.environment_context']),
		goalInternalLegacy: userMessage('2026-08-24T00:00:00.000Z', ['<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>']),
		skillLegacy: userMessage('2026-08-24T00:00:00.000Z', ['<skill>\n<name>example-skill</name>\n<path>/workspace/app/.agents/skills/example-skill/SKILL.md</path>\n</skill>']),
		appsOpenPageWithKinds: userMessage('2026-09-01T00:00:00.000Z', ['<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'], ['additional_content.codex_apps_open_page']),
		turnAborted: userMessage('2026-09-27T10:00:00.000Z', ['<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>']),
	},
	authored: {
		textWithKinds: userMessage('2026-10-01T21:34:04.923Z', ['設定画面の不具合を直して'], ['user.text']),
		// 画像を貼った発言は `<image name=…>` の包みと画像と本文が別の content になる
		imageWithKinds: userMessage('2026-10-01T21:40:00.000Z', ['<image name=[Image #1]>', '[image]', '</image>', 'この画面を見て'], ['user.text', 'user.image', 'user.text', 'user.text']),
		// Claude Code などから渡した依頼は `<task>` で始まるが、ユーザー（呼び出し元）の発言
		taskLegacy: userMessage('2026-08-24T00:00:00.000Z', ['<task>\nリポジトリ /workspace/app の実装計画をレビューしてください\n</task>']),
	},
} as const;

/**
 * 親スレッドの rollout（history_mode: paginated）。サブエージェント 1 件を起動し、やりとりして、完了の報告を受け、
 * ゴールと計画を立て、最後は usage limit で失敗して終わる。
 */
export const CODEX_FIXTURE_PARENT_ROLLOUT: readonly string[] = [
	line('2026-10-01T21:34:03.073Z', 'session_meta', { id: 'thread-root', session_id: 'thread-root', cwd: '/workspace/app', cli_version: '0.159.3', source: 'vscode' }),
	line('2026-10-01T21:34:03.074Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1', started_at: 1790890443 }),
	CODEX_FIXTURE_USER_MESSAGES.injected.agentsMdGlobalWithKinds,
	CODEX_FIXTURE_USER_MESSAGES.authored.textWithKinds,
	line('2026-10-01T21:34:35.275Z', 'response_item', { type: 'function_call', id: 'fc_spawn', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'reviewer', fork_turns: 'none', message: CODEX_FIXTURE_ENCRYPTED, model: 'gpt-5.5', reasoning_effort: 'high' }), call_id: 'call_spawn1' }),
	line('2026-10-01T21:34:35.402Z', 'event_msg', { type: 'item_completed', thread_id: 'thread-root', turn_id: 'turn-1', item: { type: 'SubAgentActivity', id: 'call_spawn1', kind: 'started', agent_thread_id: 'thread-child', agent_path: '/root/reviewer' }, started_at_ms: 1790890475402, completed_at_ms: 1790890475402 }),
	line('2026-10-01T21:34:35.419Z', 'response_item', { type: 'function_call_output', id: 'fco_spawn', call_id: 'call_spawn1', output: '{"task_name":"/root/reviewer"}' }),
	line('2026-10-01T21:35:59.447Z', 'inter_agent_communication_metadata', { trigger_turn: false }),
	line('2026-10-01T21:35:59.447Z', 'response_item', { type: 'agent_message', id: 'amsg_1', author: '/root/reviewer', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/reviewer\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: CODEX_FIXTURE_ENCRYPTED }] }),
	line('2026-10-01T21:36:10.000Z', 'response_item', { type: 'function_call', id: 'fc_send', name: 'send_message', namespace: 'collaboration', arguments: JSON.stringify({ target: 'reviewer', message: CODEX_FIXTURE_ENCRYPTED }), call_id: 'call_send1' }),
	line('2026-10-01T21:36:10.020Z', 'event_msg', { type: 'item_completed', thread_id: 'thread-root', turn_id: 'turn-1', item: { type: 'SubAgentActivity', id: 'call_send1', kind: 'interacted', agent_thread_id: 'thread-child', agent_path: '/root/reviewer' }, started_at_ms: 1790890570020, completed_at_ms: 1790890570020 }),
	line('2026-10-01T21:39:13.317Z', 'event_msg', { type: 'item_completed', thread_id: 'thread-root', turn_id: 'turn-1', item: { type: 'SubAgentActivity', id: 'subagent-completed-turn-2', kind: 'completed', agent_thread_id: 'thread-child', agent_path: '/root/reviewer' }, started_at_ms: 1790890753317, completed_at_ms: 1790890753317 }),
	line('2026-10-01T21:39:14.516Z', 'response_item', { type: 'agent_message', id: 'amsg_2', author: '/root/reviewer', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/reviewer\nPayload:\nレビューの結果、問題は 2 件です。' }] }),
	line('2026-10-01T21:40:00.000Z', 'event_msg', { type: 'thread_goal_updated', threadId: 'thread-root', goal: { threadId: 'thread-root', objective: '設定画面の不具合を直してテストまで通す', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1790890800, updatedAt: 1790890800 } }),
	line('2026-10-01T21:40:05.000Z', 'response_item', { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ explanation: '順に進めます', plan: [{ step: '原因を調べる', status: 'completed' }, { step: '直す', status: 'in_progress' }, { step: 'テストを足す', status: 'pending' }] }), call_id: 'call_plan1' }),
	line('2026-10-01T21:45:00.000Z', 'event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: null, error: { message: 'You\'ve hit your usage limit. Try again later.', codex_error_info: 'usage_limit_exceeded' }, started_at: 1790890443, completed_at: 1790891100, duration_ms: 657000 }),
];

/** 子スレッド（/root/reviewer）の rollout。親からの指示は暗号化されている。 */
export const CODEX_FIXTURE_CHILD_ROLLOUT: readonly string[] = [
	line('2026-10-01T21:34:35.409Z', 'session_meta', { id: 'thread-child', session_id: 'thread-root', parent_thread_id: 'thread-root', cwd: '/workspace/app', cli_version: '0.159.3', agent_path: '/root/reviewer', agent_nickname: 'Hooke' }),
	line('2026-10-01T21:34:35.409Z', 'event_msg', { type: 'task_started', turn_id: 'turn-2' }),
	CODEX_FIXTURE_USER_MESSAGES.injected.agentsMdGlobalWithKinds,
	line('2026-10-01T21:34:36.355Z', 'inter_agent_communication_metadata', { trigger_turn: true }),
	line('2026-10-01T21:34:36.355Z', 'response_item', { type: 'agent_message', id: 'amsg_0', author: '/root', recipient: '/root/reviewer', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/reviewer\nSender: /root\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: CODEX_FIXTURE_ENCRYPTED }] }),
	line('2026-10-01T21:35:59.058Z', 'response_item', { type: 'function_call', id: 'fc_child_send', name: 'send_message', namespace: 'collaboration', arguments: JSON.stringify({ target: '/root', message: CODEX_FIXTURE_ENCRYPTED }), call_id: 'call_child_send' }),
	line('2026-10-01T21:35:59.089Z', 'event_msg', { type: 'item_completed', thread_id: 'thread-child', turn_id: 'turn-2', item: { type: 'SubAgentActivity', id: 'call_child_send', kind: 'interacted', agent_thread_id: 'thread-root', agent_path: '/root' }, started_at_ms: 1790890559089, completed_at_ms: 1790890559089 }),
	line('2026-10-01T21:35:59.107Z', 'response_item', { type: 'function_call_output', call_id: 'call_child_send', output: '' }),
	line('2026-10-01T21:39:13.282Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'レビューの結果、問題は 2 件です。' }] }),
	line('2026-10-01T21:39:13.315Z', 'event_msg', { type: 'task_complete', turn_id: 'turn-2', last_agent_message: 'レビューの結果、問題は 2 件です。' }),
];
