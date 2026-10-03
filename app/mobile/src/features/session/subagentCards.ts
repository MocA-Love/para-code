// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { agentActivityDescendants } from '../../agentActivityTree.js';
import type { AgentActivityAgent, AgentActivityStatus, AgentChatMessage } from '../../store.js';
import type { ChatRow } from './chatRows.js';

/**
 * 会話のサブエージェントのカード（同じターンで呼んだサブエージェントを 1 枚にまとめたもの）の純ロジック。
 * 行のまとめ方、カードとサブエージェントの一覧（`AgentActivityAgent`）の結び、結果の要約を持つ。
 *
 * 結びの正本は PC が一覧の項目に載せる `toolUseIds`（起動・再開した呼び出しの id）。古い PC は送らないので、
 * 結果の本文の `agentId:`・`resumedAgentId` を拾う予備を持ち、それも無ければ一覧の画面へ案内する。
 */

/** カードの 1 行（サブエージェントの呼び出し 1 つと、その結果）。 */
export interface SubagentCall {
	readonly key: string;
	readonly use: AgentChatMessage;
	result?: AgentChatMessage;
}

/** サブエージェントのカードの行（`ChatRow` の 1 種）。 */
export interface SubagentCardChatRow {
	readonly type: 'agents';
	readonly key: string;
	readonly calls: SubagentCall[];
}

/** サブエージェントを起動する呼び出しか（Claude の Agent / Task。Codex の spawn_agent も PC が Agent に直して送る）。 */
export function isSubagentUse(message: AgentChatMessage): boolean {
	return message.kind === 'tool_use' && (message.tool === 'Agent' || message.tool === 'Task');
}

/** 人の発言（ターンの区切り）か。 */
function isTurnStart(row: ChatRow): boolean {
	return row.type === 'msg' && row.m.role === 'user' && row.m.kind === 'text';
}

/**
 * ツール実行のまとまりからサブエージェントの呼び出しを抜き出し、同じターンの呼び出しを 1 枚のカードにまとめる。
 * カードはそのターンで最初に呼んだ位置に置き、後から呼んだもの・後から届いた結果はそのカードへ寄せる。
 * 呼び出しの前後のツールは、元のまとまりを分けて残す（並びは変えない）。
 */
export function foldSubagentRows(rows: ChatRow[]): ChatRow[] {
	if (!rows.some(row => row.type === 'group' && row.msgs.some(isSubagentUse))) {
		return rows;
	}
	const callsById = new Map<string, SubagentCall>();
	const result: ChatRow[] = [];
	let card: SubagentCardChatRow | undefined;
	for (const row of rows) {
		if (isTurnStart(row)) {
			card = undefined;
		}
		if (row.type !== 'group') {
			result.push(row);
			continue;
		}
		let buffer: AgentChatMessage[] = [];
		const flush = () => {
			const first = buffer[0];
			if (first !== undefined) {
				result.push({ type: 'group', key: `g:${first.rev}`, msgs: buffer });
				buffer = [];
			}
		};
		for (const message of row.msgs) {
			const answered = message.kind === 'tool_result' && message.toolUseId !== undefined ? callsById.get(message.toolUseId) : undefined;
			if (isSubagentUse(message)) {
				const call: SubagentCall = { key: message.toolUseId ?? `u:${message.rev}`, use: message };
				if (message.toolUseId !== undefined) {
					callsById.set(message.toolUseId, call);
				}
				if (card === undefined) {
					flush();
					card = { type: 'agents', key: `a:${message.rev}`, calls: [] };
					result.push(card);
				}
				card.calls.push(call);
			} else if (answered !== undefined && answered.result === undefined) {
				answered.result = message;
			} else {
				buffer.push(message);
			}
		}
		flush();
	}
	return result;
}

/** カードの行を一覧の項目へ結ぶ手がかり。 */
export interface SubagentCallHint {
	readonly toolUseId?: string;
	/** 結果の本文から拾った子の ID（古い PC への備え）。 */
	readonly agentId?: string;
	readonly hasResult: boolean;
}

const AGENT_ID = '[A-Za-z0-9._:-]+';
const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** 非同期の起動（すぐ返り、子は裏で動き続ける）の結果か。 */
export function isSubagentLaunchResult(text: string): boolean {
	const head = text.slice(0, 400);
	return /^\s*(?:Async agent launched|Spawned successfully)/i.test(head) || /\basync_launched\b/.test(head);
}

/**
 * 結果の本文から子の ID を拾う。非同期の起動は先頭近くに、同期の報告は末尾に `agentId:` があり、SendMessage の
 * 結果（`resume`）は JSON の `resumedAgentId`。同期の報告は本文にも ID 風の文字列が混ざりうるので最後のものを採り、
 * PC で切り詰められた（末尾が落ちた）報告からは拾わない。
 */
export function agentIdFromSubagentResult(text: string, truncated: boolean, resume = false): string | undefined {
	if (resume) {
		// 子の報告の本文に出てくる `resumedAgentId` を拾わないよう、SendMessage の結果でだけ見る
		return new RegExp(`"resumedAgentId"\\s*:\\s*"(?<id>${AGENT_ID})"`).exec(text)?.groups?.['id'];
	}
	if (isSubagentLaunchResult(text)) {
		return new RegExp(`\\bagentId:\\s*(?<id>${AGENT_ID})`).exec(text)?.groups?.['id']
			?? new RegExp(`\\bagent_id:\\s*(?<id>${AGENT_ID})@`).exec(text)?.groups?.['id'];
	}
	if (truncated) {
		return undefined;
	}
	return [...text.matchAll(new RegExp(`\\bagentId:\\s*(?<id>${AGENT_ID})`, 'g'))].at(-1)?.groups?.['id'];
}

/**
 * カードの行の手がかり。子の ID は PC が添える構造化した値（`agentId`）を先に使い、無ければ本文から拾う。
 * `fullText` は切り詰められた報告の全文を取り寄せたときに渡す（末尾の `agentId:` を読めるようになる）。
 */
export function subagentCallHint(use: AgentChatMessage | undefined, result: AgentChatMessage | undefined, fullText?: string): SubagentCallHint {
	const toolUseId = use?.toolUseId ?? result?.toolUseId;
	const resume = use?.tool === 'SendMessage';
	const structured = !resume && result?.agentId !== undefined && AGENT_ID_PATTERN.test(result.agentId) ? result.agentId : undefined;
	const agentId = structured ?? (result === undefined ? undefined : fullText !== undefined
		? agentIdFromSubagentResult(fullText, false, resume)
		: agentIdFromSubagentResult(result.text, result.truncated === true || result.detailTruncated === true, resume));
	return {
		...(toolUseId !== undefined ? { toolUseId } : {}),
		...(agentId !== undefined ? { agentId } : {}),
		hasResult: result !== undefined,
	};
}

/**
 * カードの 1 行と一覧の項目の結び。カードは描くたびにこれを選び直すので、値は数と文字列だけにする
 * （{@link sameSubagentLinks} で前回と同じなら描き直さない）。
 *  - linked: 一覧に項目がある
 *  - pending: まだ結果が無い（起動の途中。一覧への反映を待つ）
 *  - missing: 結べるはずなのに一覧に無い（上限を超えて落ちた・記録が消えた）
 *  - unlinked: 古い PC で手がかりが無い（一覧の画面へ案内する）
 *  - none: 一覧そのものが無い（別の会話・まだ届いていない）
 */
export type SubagentLink =
	| {
		readonly kind: 'linked';
		readonly id: string;
		readonly label: string;
		readonly provider?: 'claude' | 'codex';
		readonly status: AgentActivityStatus;
		readonly startedAt: number;
		readonly updatedAt: number;
		/** 配下（孫以下）の数と、そのうち動いている数。 */
		readonly descendants: number;
		readonly descendantsRunning: number;
	}
	| { readonly kind: 'pending' | 'missing' | 'unlinked' | 'none' };

export function selectSubagentLink(agents: readonly AgentActivityAgent[] | undefined, hint: SubagentCallHint): SubagentLink {
	if (agents === undefined) {
		return { kind: 'none' };
	}
	const agent = (hint.toolUseId !== undefined ? agents.find(item => item.toolUseIds?.includes(hint.toolUseId!) === true) : undefined)
		?? (hint.agentId !== undefined ? agents.find(item => item.id === hint.agentId) : undefined);
	if (agent !== undefined) {
		const descendants = agentActivityDescendants(agents, agent.id);
		return {
			kind: 'linked', id: agent.id, label: agent.label, ...(agent.provider !== undefined ? { provider: agent.provider } : {}), status: agent.status, startedAt: agent.startedAt, updatedAt: agent.updatedAt,
			descendants: descendants.length,
			descendantsRunning: descendants.filter(item => item.status === 'running' || item.status === 'idle').length,
		};
	}
	if (!hint.hasResult) {
		return { kind: 'pending' };
	}
	// 子の ID が分かっていて一覧に無いときだけ「記録にない」と言う。ID が分からない（古い PC、切り詰められた報告、
	// 結びの反映待ち）ときは一覧の画面へ案内する
	return { kind: hint.agentId !== undefined ? 'missing' : 'unlinked' };
}

/** 結びの並びが前回と同じか（同じなら前回の配列を返して、カードを描き直さない）。 */
export function sameSubagentLinks(previous: readonly SubagentLink[], next: readonly SubagentLink[]): boolean {
	return previous.length === next.length && previous.every((link, index) => {
		const other = next[index] as Record<string, unknown> | undefined;
		const entries = Object.entries(link);
		return other !== undefined && entries.length === Object.keys(other).length && entries.every(([key, value]) => other[key] === value);
	});
}

/** カードの見出しの「実行中 2 · 完了 1」。 */
export function subagentCardSummary(links: readonly SubagentLink[]): string {
	const counts = new Map<string, number>();
	for (const link of links) {
		const label = link.kind === 'linked' ? subagentStatusLabel(link.status) : link.kind === 'pending' ? '起動中' : undefined;
		if (label !== undefined) {
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
	}
	return [...counts].map(([label, count]) => `${label} ${count}`).join(' · ');
}

function subagentStatusLabel(status: AgentActivityStatus): string {
	switch (status) {
		case 'running': return '実行中';
		case 'idle': return '待機';
		case 'completed': return '完了';
		case 'failed': return '失敗';
		case 'interrupted': return '中断';
		case 'unknown': return '状態不明';
	}
}

/**
 * 経過時間。動いている子は 1 分ごとにしか描き直さないので分までにし、終わった子は秒まで出す。
 */
export function formatSubagentElapsed(startedAt: number, endAt: number, running: boolean): string {
	const seconds = Math.max(0, Math.round((endAt - startedAt) / 1000));
	if (running) {
		return seconds < 60 ? '1分未満' : `${Math.floor(seconds / 60)}分`;
	}
	return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/** 結果の見せ方。 */
export type SubagentResultSummary =
	/** 非同期の起動。全文はモデル向けの指示と PC の一時ファイルの場所なので、1 行に畳む。 */
	| { readonly kind: 'launched' }
	/** 子の報告（同期の完了・Codex の起動の知らせ）。末尾の `agentId:` と `<usage>` は外し、数だけ取り出す。 */
	| { readonly kind: 'report'; readonly body: string; readonly toolUses?: number; readonly durationMs?: number };

export function summarizeSubagentResult(text: string): SubagentResultSummary {
	if (isSubagentLaunchResult(text)) {
		return { kind: 'launched' };
	}
	// 使用量は報告の末尾に付く。本文の途中に出てくる `<usage>`（報告がタグの例を引いたとき）は使わない
	const usageStart = /<usage>(?:(?!<usage>)[\s\S])*<\/usage>\s*$/i.exec(text)?.index ?? -1;
	const usage = usageStart >= 0 ? text.slice(usageStart) : '';
	const toolUses = Number(/\btool_uses:\s*(?<n>\d+)/.exec(usage)?.groups?.['n'] ?? NaN);
	const durationMs = Number(/\bduration_ms:\s*(?<n>\d+)/.exec(usage)?.groups?.['n'] ?? NaN);
	const lines = (usageStart >= 0 ? text.slice(0, usageStart) : text).replace(/\s+$/, '').split('\n');
	while (lines.length > 0 && (/^\s*agentId:\s*\S+/.test(lines[lines.length - 1] ?? '') || (lines[lines.length - 1] ?? '').trim().length === 0)) {
		lines.pop();
	}
	return {
		kind: 'report', body: lines.join('\n'),
		...(Number.isFinite(toolUses) ? { toolUses } : {}),
		...(Number.isFinite(durationMs) ? { durationMs } : {}),
	};
}

/** 報告の下に添える「ツール 21回 · 2分58秒」。値が無ければ undefined。 */
export function subagentReportStats(summary: SubagentResultSummary): string | undefined {
	if (summary.kind !== 'report') {
		return undefined;
	}
	const parts: string[] = [];
	if (summary.toolUses !== undefined) {
		parts.push(`ツール ${summary.toolUses}回`);
	}
	if (summary.durationMs !== undefined) {
		parts.push(formatSubagentElapsed(0, summary.durationMs, false));
	}
	return parts.length > 0 ? parts.join(' · ') : undefined;
}
