/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex 0.167.0 の子エージェント（multi_agent_v1 の spawn_agent）の hook を、1 つのペインへ届いた順に並べたもの（テスト用）。
// 2026-11-09 に、npm の linux-x64 版を一時 HOME・一時 CODEX_HOME で `codex exec` として起動し、`requires_openai_auth = false`
// の偽の Responses API へ向けて記録した。偽のモデルは、親で spawn_agent → 子で exec_command（`echo`）→ 子が答える →
// 親で wait_agent → 親が答える、の順に返した。hook は全部同じプロセスから届いた。
// 会話の ID は実物のまま、パスは匿名にした。分かったこと:
//  - 子の hook（SubagentStart・子の UserPromptSubmit・子のツール）の session_id は親の会話のもの。transcript_path は子の rollout
//  - 子は Stop を送らず、終わりは SubagentStop（transcript_path は親の rollout、子の rollout は agent_transcript_path）
//  - 子の hook には agent_id・agent_type が付く（SubagentStart・SubagentStop を含む）。親の hook には付かない

const PARENT = '01a1bc7c-39cc-7890-82c8-4e4773e81e73';
const CHILD = '01a1bc7c-3b21-7f20-898b-92442bbcdf4b';

export const PARADIS_CODEX_SUBAGENT_SESSIONS = { PARENT, CHILD } as const;

export interface IParadisCodexSubagentHook {
	readonly event: string;
	/** 誰の hook か（親・子・子の始まりと終わり）。 */
	readonly from: 'parent' | 'child' | 'child-boundary';
	readonly payload: Readonly<Record<string, unknown>>;
}

/** 届いた順の hook。 */
export const PARADIS_CODEX_SUBAGENT_HOOKS: readonly IParadisCodexSubagentHook[] = [
	{ event: 'SessionStart', from: 'parent', payload: { session_id: PARENT, transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${PARENT}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'SessionStart', model: 'fake-model', permission_mode: 'bypassPermissions', source: 'startup' } },
	{ event: 'UserPromptSubmit', from: 'parent', payload: { session_id: PARENT, turn_id: '01a1bc7c-3a26-7022-a952-555459508f48', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${PARENT}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'UserPromptSubmit', model: 'fake-model', permission_mode: 'bypassPermissions', prompt: 'PARENT-MARK spawn a helper' } },
	{ event: 'PreToolUse', from: 'parent', payload: { session_id: PARENT, turn_id: '01a1bc7c-3a26-7022-a952-555459508f48', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${PARENT}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'PreToolUse', model: 'fake-model', permission_mode: 'bypassPermissions', tool_name: 'spawn_agent', tool_input: { message: 'SUBTASK-MARK please run echo' }, tool_use_id: 'call_0' } },
	{ event: 'PostToolUse', from: 'parent', payload: { session_id: PARENT, turn_id: '01a1bc7c-3a26-7022-a952-555459508f48', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${PARENT}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'PostToolUse', model: 'fake-model', permission_mode: 'bypassPermissions', tool_name: 'spawn_agent', tool_input: { message: 'SUBTASK-MARK please run echo' }, tool_response: `{"agent_id":"${CHILD}","nickname":"Plato"}`, tool_use_id: 'call_0' } },
	{ event: 'SubagentStart', from: 'child-boundary', payload: { session_id: PARENT, turn_id: '01a1bc7c-3b37-7a61-9d73-15b7665eba71', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${CHILD}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'SubagentStart', model: 'fake-model', permission_mode: 'bypassPermissions', agent_id: CHILD, agent_type: 'default' } },
	{ event: 'UserPromptSubmit', from: 'child', payload: { session_id: PARENT, turn_id: '01a1bc7c-3b37-7a61-9d73-15b7665eba71', agent_id: CHILD, agent_type: 'default', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${CHILD}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'UserPromptSubmit', model: 'fake-model', permission_mode: 'bypassPermissions', prompt: 'SUBTASK-MARK please run echo' } },
	{ event: 'PreToolUse', from: 'parent', payload: { session_id: PARENT, turn_id: '01a1bc7c-3a26-7022-a952-555459508f48', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${PARENT}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'PreToolUse', model: 'fake-model', permission_mode: 'bypassPermissions', tool_name: 'multi_agent_v1wait_agent', tool_input: { targets: [CHILD], timeout_ms: 30000 }, tool_use_id: 'call_1' } },
	{ event: 'PreToolUse', from: 'child', payload: { session_id: PARENT, turn_id: '01a1bc7c-3b37-7a61-9d73-15b7665eba71', agent_id: CHILD, agent_type: 'default', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${CHILD}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'PreToolUse', model: 'fake-model', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'echo child-ran' }, tool_use_id: 'call_2' } },
	{ event: 'PostToolUse', from: 'child', payload: { session_id: PARENT, turn_id: '01a1bc7c-3b37-7a61-9d73-15b7665eba71', agent_id: CHILD, agent_type: 'default', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${CHILD}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'PostToolUse', model: 'fake-model', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'echo child-ran' }, tool_response: 'child-ran\n', tool_use_id: 'call_2' } },
	{ event: 'SubagentStop', from: 'child-boundary', payload: { session_id: PARENT, turn_id: '01a1bc7c-3b37-7a61-9d73-15b7665eba71', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${PARENT}.jsonl`, agent_transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${CHILD}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'SubagentStop', model: 'fake-model', permission_mode: 'bypassPermissions', stop_hook_active: false, agent_id: CHILD, agent_type: 'default', last_assistant_message: 'child done' } },
	{ event: 'PostToolUse', from: 'parent', payload: { session_id: PARENT, turn_id: '01a1bc7c-3a26-7022-a952-555459508f48', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${PARENT}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'PostToolUse', model: 'fake-model', permission_mode: 'bypassPermissions', tool_name: 'multi_agent_v1wait_agent', tool_input: { targets: [CHILD], timeout_ms: 30000 }, tool_response: `{"status":{"${CHILD}":{"completed":"child done"}},"timed_out":false}`, tool_use_id: 'call_1' } },
	{ event: 'Stop', from: 'parent', payload: { session_id: PARENT, turn_id: '01a1bc7c-3a26-7022-a952-555459508f48', transcript_path: `/Users/example/.codex/sessions/2026/11/09/rollout-2026-11-09T03-47-00-${PARENT}.jsonl`, cwd: '/Users/example/work', hook_event_name: 'Stop', model: 'fake-model', permission_mode: 'bypassPermissions', stop_hook_active: false, last_assistant_message: 'parent done' } },
];
