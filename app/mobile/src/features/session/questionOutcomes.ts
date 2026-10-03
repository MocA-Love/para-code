// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { questionOutcomeFromResult, type QuestionOutcome } from '../../agentQuestionMod.js';
import type { AgentChatMessage } from '../../store.js';
import type { ChatRow, QuestionChatRow } from './chatRows.js';

/** 取り下げた質問の行（`buildChatRows` の行に結果を添えたもの）。 */
export type QuestionRowWithOutcome = QuestionChatRow & { readonly outcome?: QuestionOutcome };

/** 質問の行の結果（取り下げたか）。添えていなければ undefined。 */
export function questionRowOutcome(row: QuestionChatRow): QuestionOutcome | undefined {
	return (row as QuestionRowWithOutcome).outcome;
}

/**
 * 「質問に答えずに話す」で取り下げた質問を、会話の上で分かるようにする（`buildChatRows` の後に通す）。
 *  - 取り下げた質問の行に結果を添える（行は「N つの質問・取り下げ」になり、メッセージがあればその上にあなたの吹き出しを出す）
 *  - その質問の結果（ツールの結果の行）はツールの実行の行から外す（同じ内容を 2 か所に出さない）
 * 取り下げた質問が無ければ、受け取った配列をそのまま返す。
 */
export function withQuestionOutcomes(rows: readonly ChatRow[]): readonly ChatRow[] {
	const questionIds = new Set<string>();
	for (const row of rows) {
		for (const message of row.type === 'question' ? [row.m] : row.type === 'questionGroup' ? row.msgs : []) {
			if (message.toolUseId !== undefined) {
				questionIds.add(message.toolUseId);
			}
		}
	}
	if (questionIds.size === 0) {
		return rows;
	}
	const outcomes = new Map<string, { readonly outcome: QuestionOutcome; readonly rev: number }>();
	for (const row of rows) {
		if (row.type !== 'group') {
			continue;
		}
		for (const message of row.msgs) {
			if (message.kind === 'tool_result' && message.toolUseId !== undefined && questionIds.has(message.toolUseId)) {
				const outcome = questionOutcomeFromResult(message.text, message.isError === true);
				if (outcome !== undefined) {
					outcomes.set(message.toolUseId, { outcome, rev: message.rev });
				}
			}
		}
	}
	if (outcomes.size === 0) {
		return rows;
	}
	const hidden = new Set([...outcomes.values()].map(entry => entry.rev));
	const result: ChatRow[] = [];
	for (const row of rows) {
		if (row.type === 'group') {
			const msgs = row.msgs.filter(message => !hidden.has(message.rev));
			if (msgs.length > 0) {
				result.push(msgs.length === row.msgs.length ? row : { ...row, msgs });
			}
			continue;
		}
		if (row.type === 'question' || row.type === 'questionGroup') {
			const first: AgentChatMessage | undefined = row.type === 'question' ? row.m : row.msgs[0];
			const outcome = first?.toolUseId !== undefined ? outcomes.get(first.toolUseId)?.outcome : undefined;
			result.push(outcome !== undefined ? { ...row, outcome } as QuestionRowWithOutcome : row);
			continue;
		}
		result.push(row);
	}
	return result;
}
