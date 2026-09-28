// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 会話の古い発言をさかのぼって読む（Orca W2-30、Q122）。
 *
 * PC（`agent.history.page.v1` を広告する版）に `history` を求めると、まず PC のメモリにある発言（ペインごとに 400 件）から、
 * 読み切ると記録ファイルを後ろへ読んで返す。ファイルから読んだ発言の rev は負の数（-1 から古い方へ減る）で、1 ペインで
 * {@link AGENT_HISTORY_FILE_CAP} 件まで。
 *
 * 古い発言は会話の状態（`AgentChatState.messages`。新しい発言で 500 件に切られる）とは別に持ち、同じ epoch の間は
 * PC からの snapshot で消さない。epoch が変わったら捨てる。副作用の無い関数だけを置く。
 */

import type { AgentChatMessage } from './store.js';

/** capability の名前（PC の `PARADIS_MOBILE_PC_CAPABILITIES` と同じ）。 */
export const AGENT_HISTORY_CAPABILITY = 'agent.history.page.v1';
/** ファイルから読める発言の上限（PC の PARADIS_HISTORY_FILE_CAP と同じ）。 */
export const AGENT_HISTORY_FILE_CAP = 2000;
/** 1 回に求める件数。 */
export const AGENT_HISTORY_PAGE_SIZE = 60;

/** 1 つの会話（epoch）ぶんの古い発言。 */
export interface AgentHistoryState {
	readonly epoch: string;
	/** 古い順。 */
	readonly messages: readonly AgentChatMessage[];
	/** 次に PC へ渡す位置（記録ファイルの中）。無ければ次は PC のメモリから。 */
	readonly cursor?: string;
	/** まだ前がある。 */
	readonly hasMore: boolean;
	/** 読める上限に達した（これより前は PC で見る）。 */
	readonly capped: boolean;
	readonly loading: boolean;
	/** 直前の読み込みの失敗（画面に出す文）。 */
	readonly error?: string;
}

/** PC の `history` の返事。 */
export interface AgentHistoryPage {
	readonly messages: readonly AgentChatMessage[];
	readonly cursor?: string;
	readonly hasMore: boolean;
	readonly capped: boolean;
	readonly error?: string;
}

const ROLES = new Set(['user', 'assistant', 'tool']);
const KINDS = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'question', 'peer_message']);

/** 返事を読む。形が違えば undefined。発言は形の正しいものだけを残し、取り寄せの印（全文・画像）は外す。 */
export function parseAgentHistoryReply(reply: Record<string, unknown>): AgentHistoryPage | undefined {
	if (typeof reply['error'] === 'string') {
		return { messages: [], hasMore: false, capped: false, error: reply['error'] };
	}
	if (!Array.isArray(reply['messages'])) {
		return undefined;
	}
	const messages: AgentChatMessage[] = [];
	for (const candidate of reply['messages'].slice(0, 200)) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
			continue;
		}
		const raw = candidate as Record<string, unknown>;
		if (typeof raw['rev'] !== 'number' || !Number.isSafeInteger(raw['rev']) || typeof raw['text'] !== 'string'
			|| !ROLES.has(raw['role'] as string) || !KINDS.has(raw['kind'] as string)) {
			continue;
		}
		const { images: _images, truncated: _truncated, ...rest } = raw;
		messages.push(rest as unknown as AgentChatMessage);
	}
	const cursor = typeof reply['cursor'] === 'string' && reply['cursor'].length <= 100 ? reply['cursor'] : undefined;
	return { messages, ...(cursor !== undefined ? { cursor } : {}), hasMore: reply['hasMore'] === true, capped: reply['capped'] === true };
}

/** 次に求めるときの `beforeRev`（持っているいちばん古い発言の rev）。何も無ければ undefined（求めない）。 */
export function historyBeforeRev(history: AgentHistoryState | undefined, live: readonly AgentChatMessage[]): number | undefined {
	return history?.messages[0]?.rev ?? live[0]?.rev;
}

/**
 * 会話の状態が変わったときに古い発言を合わせ直す。epoch が変わったら捨てる（undefined）。新しい発言と重なった分は外し、
 * 間が空いた（PC のメモリから押し出された分が抜けた）ら、つながらないので捨てる。
 */
export function reconcileAgentHistory(history: AgentHistoryState | undefined, epoch: string | undefined, live: readonly AgentChatMessage[]): AgentHistoryState | undefined {
	if (history === undefined || epoch === undefined || history.epoch !== epoch) {
		return undefined;
	}
	const oldestLive = live[0]?.rev;
	if (oldestLive === undefined) {
		return history;
	}
	const kept = history.messages.filter(message => message.rev < oldestLive);
	const newest = kept.at(-1)?.rev;
	// メモリから読んだ発言（0 以上）は、新しい発言の直前までつながっていなければならない。
	if (newest !== undefined && newest >= 0 && newest < oldestLive - 1) {
		return undefined;
	}
	return kept.length === history.messages.length ? history : { ...history, messages: kept };
}

/** 古い発言として手元に持つ上限（新しい発言から繰り入れた分を含む）。超えたら古い方を捨て、それより前は PC で見てもらう。 */
export const AGENT_HISTORY_KEEP_LIMIT = 2500;

/**
 * 新しい発言の差分で会話の状態が 500 件に切られたとき、切られた発言を古い発言の末尾へ繰り入れる（シミュレータ確認の NG-1）。
 * これをしないと、古い発言と新しい発言の間が空いて {@link reconcileAgentHistory} が古い発言を全部捨て、表示位置も飛ぶ。
 * 並びは切る前と同じなので、一覧の行（キーは rev）は変わらず、見ている位置も保たれる。
 * 古い発言が無い（さかのぼっていない）ときは何もしない（切られた分は PC から読み直せる）。
 */
export function absorbTrimmedIntoHistory(
	history: AgentHistoryState | undefined,
	epoch: string | undefined,
	previousLive: readonly AgentChatMessage[],
	nextLive: readonly AgentChatMessage[],
	/**
	 * この更新で切られた発言（切る前の結合結果 = 直前の発言 + 届いた差分 のうち、500 件からはみ出した古い側）。1 回の差分に
	 * 500 件を超える発言が載ると、差分自身の古い側も切られ、直前の発言だけからでは繰り入れきれないため（統合確認の NG）。
	 */
	trimmedByUpdate: readonly AgentChatMessage[] = [],
): AgentHistoryState | undefined {
	const oldestNext = nextLive[0]?.rev;
	if (history === undefined || epoch === undefined || history.epoch !== epoch || oldestNext === undefined) {
		return history;
	}
	const newestHistory = history.messages.at(-1)?.rev;
	const candidates = new Map<number, AgentChatMessage>();
	for (const message of [...previousLive, ...trimmedByUpdate]) {
		if (message.rev < oldestNext && (newestHistory === undefined || message.rev > newestHistory) && !candidates.has(message.rev)) {
			candidates.set(message.rev, message);
		}
	}
	const trimmed = [...candidates.values()].sort((a, b) => a.rev - b.rev);
	if (trimmed.length === 0) {
		return history;
	}
	const messages = [...history.messages, ...trimmed];
	if (messages.length <= AGENT_HISTORY_KEEP_LIMIT) {
		return { ...history, messages };
	}
	const { cursor: _cursor, ...rest } = history;
	return { ...rest, messages: messages.slice(-AGENT_HISTORY_KEEP_LIMIT), hasMore: false, capped: true };
}

/** 読み込みを始めた状態。 */
export function beginAgentHistoryLoad(history: AgentHistoryState | undefined, epoch: string): AgentHistoryState {
	const base: AgentHistoryState = history ?? { epoch, messages: [], hasMore: true, capped: false, loading: false };
	const { error: _error, ...rest } = base;
	return { ...rest, loading: true };
}

/** 返事を足す（古い方へつなぐ）。 */
export function applyAgentHistoryPage(history: AgentHistoryState, page: AgentHistoryPage): AgentHistoryState {
	if (page.error !== undefined) {
		const { error: _error, ...rest } = history;
		const retryable = page.error === 'busy';
		return { ...rest, loading: false, hasMore: retryable ? history.hasMore : false, error: agentHistoryErrorText(page.error) };
	}
	const oldest = history.messages[0]?.rev;
	const older = oldest === undefined ? page.messages : page.messages.filter(message => message.rev < oldest);
	const { error: _error, cursor: _cursor, ...rest } = history;
	return {
		...rest,
		messages: [...older, ...history.messages],
		...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
		hasMore: page.hasMore,
		capped: page.capped,
		loading: false,
	};
}

/** 失敗の理由を画面の文にする。 */
export function agentHistoryErrorText(code: string): string {
	switch (code) {
		case 'busy': return 'PC が読み込み中です。少し待ってからもう一度さかのぼってください';
		case 'history-moved': return 'PC 側で会話が進んだため、ここから前は読めません。会話を開き直してください';
		case 'stale-session': return '会話が切り替わりました。開き直してください';
		default: return '古い発言を読み込めませんでした';
	}
}

/** 一覧の先頭に出す案内。 */
export type AgentHistoryHeader =
	| { readonly kind: 'none' }
	| { readonly kind: 'truncated' }
	| { readonly kind: 'more'; readonly loading: boolean }
	| { readonly kind: 'capped' }
	| { readonly kind: 'error'; readonly message: string };

/**
 * 一覧の先頭に何を出すか。古い PC（さかのぼれない）で省略しているときは従来の「古い履歴は省略しています」。
 */
export function agentHistoryHeader(supported: boolean, truncated: boolean, history: AgentHistoryState | undefined): AgentHistoryHeader {
	if (!supported) {
		return truncated ? { kind: 'truncated' } : { kind: 'none' };
	}
	if (history === undefined) {
		return truncated ? { kind: 'more', loading: false } : { kind: 'none' };
	}
	if (history.error !== undefined && !history.hasMore) {
		return { kind: 'error', message: history.error };
	}
	if (history.capped) {
		return { kind: 'capped' };
	}
	return history.hasMore || history.loading ? { kind: 'more', loading: history.loading } : { kind: 'none' };
}
