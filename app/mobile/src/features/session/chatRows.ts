// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { pinnedQuestionIndex } from '../../agentConversationUx.js';
import type { AgentChatMessage, AgentInteraction } from '../../store.js';
import { advisorInfoOf } from './advisor.js';
import { foldSubagentRows, type SubagentCardChatRow } from './subagentCards.js';

/**
 * 会話表示の1行。旧画面（legacy-screens/agent.tsx）の行の組み立てをそのまま移したもの。
 *  - 本文（text / peer_message）はそのまま1行
 *  - 本文以外の連続する thinking / tool_use / tool_result は1つのツール実行の行へまとめる
 *  - 質問は独立の行（同じ AskUserQuestion 由来の複数の質問は1行にまとめる）
 *  - Web 検索は開始と結果を別の行にする（結果は実際に届いた位置へ置く）
 *  - サブエージェントの呼び出しは、同じターンのものを 1 枚のカードにまとめる（`subagentCards.ts`）
 *  - Advisor への相談は、呼び出しと結果を独立した 1 行にする（ツールのまとまりに混ぜない。`advisor.ts`）
 */
export type ChatRow =
	| { readonly type: 'msg'; readonly m: AgentChatMessage }
	| { readonly type: 'question'; readonly m: AgentChatMessage; readonly answered: boolean }
	| { readonly type: 'questionGroup'; readonly key: string; readonly msgs: AgentChatMessage[]; answered: boolean }
	| { readonly type: 'web'; readonly key: string; readonly msgs: AgentChatMessage[] }
	| { readonly type: 'group'; readonly key: string; readonly msgs: AgentChatMessage[] }
	| AdvisorChatRow
	| SubagentCardChatRow;

/** Advisor への相談 1 回（呼び出しと、届いていれば結果）。 */
export interface AdvisorChatRow {
	readonly type: 'advisor';
	readonly key: string;
	readonly use?: AgentChatMessage;
	result?: AgentChatMessage;
}

export type QuestionChatRow = Extract<ChatRow, { type: 'question' | 'questionGroup' }>;

export function buildChatRows(messages: readonly AgentChatMessage[]): ChatRow[] {
	// 質問の「回答済み」判定: 同じ toolUseId の tool_result が後続に存在するか。
	const answeredIds = new Set<string>();
	for (const m of messages) {
		if (m.kind === 'tool_result' && m.toolUseId !== undefined) {
			answeredIds.add(m.toolUseId);
		}
	}
	const result: ChatRow[] = [];
	const webSearches = new Map<string, AgentChatMessage>();
	const advisorCalls = new Map<string, AdvisorChatRow>();
	let buffer: AgentChatMessage[] = [];
	const flush = () => {
		const first = buffer[0];
		if (first !== undefined) {
			result.push({ type: 'group', key: `g:${first.rev}`, msgs: buffer });
			buffer = [];
		}
	};
	for (const m of messages) {
		if (m.kind === 'text' || m.kind === 'peer_message') {
			flush();
			result.push({ type: 'msg', m });
		} else if (m.kind === 'question') {
			flush();
			const last = result[result.length - 1];
			const answered = m.toolUseId !== undefined && answeredIds.has(m.toolUseId);
			if (m.questionGroup !== undefined && (m.questionCount ?? 1) > 1) {
				if (last !== undefined && last.type === 'questionGroup' && last.key === m.questionGroup) {
					last.msgs.push(m);
					last.answered = last.answered || answered;
				} else {
					result.push({ type: 'questionGroup', key: m.questionGroup, msgs: [m], answered });
				}
			} else {
				result.push({ type: 'question', m, answered });
			}
		} else if (m.kind === 'tool_use' && m.tool === 'web_search') {
			flush();
			if (m.toolUseId === undefined || !answeredIds.has(m.toolUseId)) {
				result.push({ type: 'web', key: m.toolUseId ?? `web:${m.rev}`, msgs: [m] });
			}
			if (m.toolUseId !== undefined) {
				webSearches.set(m.toolUseId, m);
			}
		} else if (advisorInfoOf(m) !== undefined) {
			const call = m.kind === 'tool_result' && m.toolUseId !== undefined ? advisorCalls.get(m.toolUseId) : undefined;
			if (call !== undefined && call.result === undefined) {
				call.result = m;
			} else {
				flush();
				const row: AdvisorChatRow = m.kind === 'tool_use' ? { type: 'advisor', key: `adv:${m.rev}`, use: m } : { type: 'advisor', key: `adv:${m.rev}`, result: m };
				result.push(row);
				if (m.kind === 'tool_use' && m.toolUseId !== undefined) {
					advisorCalls.set(m.toolUseId, row);
				}
			}
		} else if (m.kind === 'tool_result' && m.toolUseId !== undefined && webSearches.has(m.toolUseId)) {
			flush();
			const use = webSearches.get(m.toolUseId);
			result.push({ type: 'web', key: `web-result:${m.rev}`, msgs: use !== undefined ? [use, m] : [m] });
		} else {
			buffer.push(m);
		}
	}
	flush();
	return foldSubagentRows(result);
}

/** 質問の行の回答の送り先 ID（questionGroup ?? toolUseId）。 */
export function questionRowId(row: QuestionChatRow): string | undefined {
	const first = row.type === 'question' ? row.m : row.msgs[0];
	return first?.questionGroup ?? first?.toolUseId;
}

/**
 * コンポーザーの直上に固定する質問の行を会話から外す。判定そのものは既存の
 * `pinnedQuestionIndex`（PC の現在の要求を正本にする）。固定した行は会話から外し、
 * 回答済みの質問だけを履歴として残す。
 */
export function splitPinnedQuestion(
	rows: readonly ChatRow[],
	interaction: Pick<AgentInteraction, 'kind' | 'id'> | undefined,
	agentStatus: string | undefined,
): { readonly pinned: QuestionChatRow | undefined; readonly listRows: readonly ChatRow[] } {
	const index = pinnedQuestionIndex(
		rows.map(row => row.type === 'question' || row.type === 'questionGroup'
			? { interactionId: questionRowId(row), answered: row.answered }
			: undefined),
		interaction,
		agentStatus,
	);
	const pinned = index >= 0 ? rows[index] : undefined;
	if (pinned === undefined || (pinned.type !== 'question' && pinned.type !== 'questionGroup')) {
		return { pinned: undefined, listRows: rows };
	}
	return { pinned, listRows: rows.filter(row => row !== pinned) };
}

/** 一覧の行の鍵（セッションが変わったら全行を作り直す）。 */
export function chatRowKey(row: ChatRow, epoch: string): string {
	return row.type === 'group' || row.type === 'questionGroup' || row.type === 'web' || row.type === 'agents' || row.type === 'advisor'
		? `${epoch}:${row.key}`
		: `${epoch}:${row.m.rev}`;
}
