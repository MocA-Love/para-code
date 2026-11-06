/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex 0.167.0 の command center で会話を切り替えたときに、1 つのペインへ届いた hook（テスト用）。
// 2026-11-07 に、npm の linux-x64 版を一時 HOME・一時 CODEX_HOME・`--no-daemon` で起動し、`requires_openai_auth = false`
// の偽の Responses API へ向けて tmux で操作した記録。hook は全部同じプロセス・同じ env（ペインのトークン）から届いた。
// 会話の ID は実物のまま、パスは匿名にした。順の番号は調査資料（cli-updates-2026-11-07.html）の表と同じ。

const A = '01a1b32a-9bea-7e91-82b4-20cd76a29b28';
const B = '01a1b32a-e85b-7e32-826c-765028b9a250';
/** 前の起動で閉じた会話（command center から開き直した）。 */
const OLD = '01a1b328-6bce-7b62-81c8-1d207b74bfb6';

const SESSIONS = '/Users/example/.codex/sessions/2026/11/07';
const CWD = '/Users/example/work';

function transcript(sessionId: string, started: string): string {
	return `${SESSIONS}/rollout-2026-11-07T${started}-${sessionId}.jsonl`;
}

const TRANSCRIPTS: Readonly<Record<string, string>> = {
	[A]: transcript(A, '08-21-16'),
	[B]: transcript(B, '08-21-36'),
	[OLD]: transcript(OLD, '08-18-53'),
};

export interface IParadisCodexCommandCenterHook {
	/** 調査資料の順の番号。 */
	readonly step: number;
	/** そのとき画面に出ていた会話。 */
	readonly front: 'A' | 'B' | 'OLD';
	readonly event: string;
	readonly payload: Readonly<Record<string, unknown>>;
}

function hook(step: number, front: 'A' | 'B' | 'OLD', event: string, sessionId: string, extra: Readonly<Record<string, unknown>> = {}): IParadisCodexCommandCenterHook {
	return {
		step, front, event,
		payload: { session_id: sessionId, transcript_path: TRANSCRIPTS[sessionId], cwd: CWD, hook_event_name: event, model: 'fake-model', ...extra },
	};
}

export const PARADIS_CODEX_COMMAND_CENTER_SESSIONS = { A, B, OLD } as const;

/** 届いた順の hook。 */
export const PARADIS_CODEX_COMMAND_CENTER_HOOKS: readonly IParadisCodexCommandCenterHook[] = [
	// 1. A で `fast one A`
	hook(1, 'A', 'SessionStart', A, { source: 'startup' }),
	hook(1, 'A', 'UserPromptSubmit', A, { prompt: 'fast one A' }),
	hook(1, 'A', 'Stop', A),
	// 2. A で `SLOW two A`（25 秒かかる）→ `←` で command center → `n` で新しい会話 B
	hook(2, 'A', 'UserPromptSubmit', A, { prompt: 'SLOW two A' }),
	// 3. B で `fast one B`（A は裏で作業中）
	hook(3, 'B', 'SessionStart', B, { source: 'startup' }),
	hook(3, 'B', 'UserPromptSubmit', B, { prompt: 'fast one B' }),
	hook(3, 'B', 'Stop', B),
	// 4. B を表にしたまま待つと、裏の A の終わりが届く
	hook(4, 'B', 'Stop', A),
	// 5. command center から読み込み済みの A を開くだけでは何も届かない
	// 7. command center から閉じた古い会話を開いて送る（実際の操作はこの順だった）
	hook(7, 'OLD', 'SessionStart', OLD, { source: 'resume' }),
	hook(7, 'OLD', 'UserPromptSubmit', OLD, { prompt: 'fast three A' }),
	hook(7, 'OLD', 'Stop', OLD),
	// 6. command center から A を開いて `fast four A`
	hook(6, 'A', 'UserPromptSubmit', A, { prompt: 'fast four A' }),
	hook(6, 'A', 'Stop', A),
];
