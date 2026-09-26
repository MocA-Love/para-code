// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { agentStatusKind, agentStatusLabel } from '../../agentStatus.js';
import type { AgentChatState } from '../../store.js';

/**
 * PC の画面の行の3段目（Orca の WorktreeAgentRow: 状態の点・エージェントのロゴ・最後の一言・経過時間）に
 * 出す中身を決める純関数。
 *
 * PC から届く `workspace.terminals` には最後の発言も時刻も無い。手元にあるのは、一度開いた（購読した）
 * エージェントの会話の写し（`agentChats`）だけなので、それがあれば最後の発言と時刻を使い、
 * 無ければ状態の呼び名だけを出す。時刻が分からないものに時刻をでっち上げない。
 */

/** 行の頭に出すロゴの種類。 */
export type AgentLogoKind = 'claude' | 'codex' | 'agent' | 'terminal';

/**
 * ロゴを決める。会話の写しがあればそのエージェント名、無ければターミナルの名前から推し量る
 * （PC 側はエージェントを起動したターミナルに `claude` / `codex` を含む名前を付ける）。
 */
export function agentLogoKind(terminal: { readonly agent?: boolean; readonly title?: string }, chatAgent: string | undefined): AgentLogoKind {
	if (terminal.agent !== true) {
		return 'terminal';
	}
	const source = (chatAgent ?? terminal.title ?? '').toLowerCase();
	if (source.includes('claude')) {
		return 'claude';
	}
	if (source.includes('codex')) {
		return 'codex';
	}
	return 'agent';
}

/** 行に出す一文の長さの上限（1行で切れるので、それ以上は持たない）。 */
const LINE_MAX = 160;

function firstLine(text: string | undefined): string | undefined {
	if (text === undefined) {
		return undefined;
	}
	const line = text.split('\n').map(part => part.trim()).find(part => part.length > 0);
	if (line === undefined) {
		return undefined;
	}
	const collapsed = line.replace(/\s+/g, ' ');
	return collapsed.length > LINE_MAX ? `${collapsed.slice(0, LINE_MAX)}…` : collapsed;
}

type ChatLike = Pick<AgentChatState, 'messages'> & Partial<Pick<AgentChatState, 'live' | 'interaction' | 'none'>>;

/** 会話の写しのうち、エージェントの最後の本文（考え中・ツールの結果は除く）。 */
export function lastAssistantText(chat: ChatLike | undefined): string | undefined {
	const messages = chat?.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message !== undefined && message.role === 'assistant' && message.kind === 'text') {
			const line = firstLine(message.text);
			if (line !== undefined) {
				return line;
			}
		}
	}
	return undefined;
}

/** 会話の写しの中で一番新しい時刻（epoch ms）。無ければ undefined。 */
export function lastChatActivityAt(chat: ChatLike | undefined): number | undefined {
	let latest: number | undefined;
	for (const message of chat?.messages ?? []) {
		if (typeof message.ts === 'number' && Number.isFinite(message.ts) && (latest === undefined || message.ts > latest)) {
			latest = message.ts;
		}
	}
	const live = chat?.live?.updatedAt;
	if (typeof live === 'number' && Number.isFinite(live) && (latest === undefined || live > latest)) {
		latest = live;
	}
	return latest;
}

export interface AgentRowLine {
	readonly text: string;
	/** 未確認（作業を終えてまだ見ていない）のとき、本文色・太字で目立たせる（モックの `.aglabel.unv`）。 */
	readonly emphasized: boolean;
	/** 最後に動いた時刻（epoch ms）。分からなければ undefined（時刻を出さない）。 */
	readonly at: number | undefined;
}

/**
 * 3段目の一文。
 *  - ターミナル: 「ターミナル」
 *  - 要対応: 「許可待ち · 〜」「質問 · 〜」（何を待っているかが分かればそれを添える）
 *  - 実行中: 実行中のツールとその対象、無ければ最後の発言、それも無ければ「実行中」
 *  - 未確認・待機: 最後の発言、無ければ「完了」「待機中」
 */
export function agentRowLine(terminal: { readonly agent?: boolean; readonly agentStatus?: string }, chat: ChatLike | undefined): AgentRowLine {
	if (terminal.agent !== true) {
		return { text: 'ターミナル', emphasized: false, at: undefined };
	}
	const usable = chat !== undefined && chat.none !== true ? chat : undefined;
	const kind = agentStatusKind(terminal.agentStatus);
	const last = lastAssistantText(usable);
	const at = lastChatActivityAt(usable);
	if (kind === 'attention') {
		const label = agentStatusLabel(terminal.agentStatus);
		const detail = firstLine(usable?.interaction?.title) ?? firstLine(usable?.interaction?.detail);
		return { text: detail !== undefined ? `${label} · ${detail}` : label, emphasized: false, at };
	}
	if (kind === 'running') {
		const live = usable?.live;
		const tool = live?.phase === 'tool' && live.tool !== undefined
			? firstLine(live.detail !== undefined ? `${live.tool} ${live.detail}` : live.tool)
			: undefined;
		return { text: tool ?? firstLine(live?.text) ?? last ?? '実行中', emphasized: false, at };
	}
	if (kind === 'review') {
		return { text: last ?? '完了', emphasized: true, at };
	}
	return { text: last ?? '待機中', emphasized: false, at };
}

/**
 * 経過時間を行の右端に出す短い形にする（モックの `.agtime`: 「今」「3分」「2時間」「4日」）。
 * 「〜前」を付けないのは、1行の右端に収めるため（Orca と同じ）。
 */
export function formatElapsedShort(at: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 1) {
		return '今';
	}
	if (minutes < 60) {
		return `${minutes}分`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}時間`;
	}
	return `${Math.floor(hours / 24)}日`;
}
