/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 動いているペインの無い会話（眠った Bot の会話など）を、会話の記録の行から読むだけの吹き出しにする。
// 行の解釈は中継の tailer と同じ parser（paradisAgentTranscriptParser.ts）を通す。

import { IParadisAgentChatMessage } from './paradisAgentChat.js';
import { IRawMessage, newClaudeQueuedPromptState, newParseSignals, parseClaudeLine, parseCodexLine, rec } from './paradisAgentTranscriptParser.js';

/** 読むだけの吹き出しに出す、最後のメッセージの数。 */
export const PARADIS_AGENT_TRANSCRIPT_SNAPSHOT_LIMIT = 200;

/**
 * Claude Code の transcript（jsonl）か Codex の rollout の行を、チャット表示のメッセージにする。読めない行は飛ばす。
 * 最後の `limit` 件だけを返し、`truncated` はそれより前を落としたか。
 */
export function paradisAgentTranscriptSnapshot(agent: 'claude' | 'codex', lines: readonly string[], limit = PARADIS_AGENT_TRANSCRIPT_SNAPSHOT_LIMIT): { readonly messages: IParadisAgentChatMessage[]; readonly truncated: boolean } {
	const signals = agent === 'claude' ? newParseSignals(newClaudeQueuedPromptState()) : newParseSignals();
	const raw: IRawMessage[] = [];
	for (const line of lines) {
		if (line.trim().length === 0) {
			continue;
		}
		let obj: Record<string, unknown> | undefined;
		try {
			obj = rec(JSON.parse(line));
		} catch {
			continue;
		}
		if (obj !== undefined) {
			raw.push(...(agent === 'claude' ? parseClaudeLine(obj, signals) : parseCodexLine(obj, signals)));
		}
	}
	const kept = raw.slice(-limit);
	// 中継と同じく、行の解釈の途中の値（Map など）を持ち出さない形に写してから番号を振る
	const plain = JSON.parse(JSON.stringify(kept)) as IRawMessage[];
	const messages: IParadisAgentChatMessage[] = plain.map((message, index) => ({ ...message, rev: index + 1 }));
	return { messages, truncated: raw.length > kept.length };
}
