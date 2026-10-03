// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { AgentActivityAgent, AgentChatMessage } from '../../store.js';
import { buildChatRows, chatRowKey } from './chatRows.js';
import {
	agentIdFromSubagentResult, formatSubagentElapsed, sameSubagentLinks, selectSubagentLink, subagentCallHint, subagentCardSummary,
	subagentReportStats, summarizeSubagentResult,
} from './subagentCards.js';

let rev = 0;
function msg(kind: AgentChatMessage['kind'], extra: Partial<AgentChatMessage> = {}): AgentChatMessage {
	rev++;
	return { rev, role: kind === 'text' ? 'assistant' : 'tool', kind, text: `${kind}-${rev}`, ...extra };
}

function agent(id: string, extra: Partial<AgentActivityAgent> = {}): AgentActivityAgent {
	return { id, label: 'Explore', role: 'subagent', status: 'running', startedAt: 0, updatedAt: 0, ...extra };
}

const ASYNC_LAUNCH = 'Async agent launched successfully.\nagentId: a798fad27281411e5 (This tool result is internal metadata — never quote it to the user)\noutput_file: /private/tmp/claude/tasks/a798fad27281411e5.output';
const SYNC_REPORT = '# レビュー結果\n\n指摘は 2 件です。agentId: decoy は本文\nagentId: a111 (use SendMessage with to: \'a111\' to continue this agent)\n<usage>subagent_tokens: 105629\ntool_uses: 21\nduration_ms: 178142</usage>';

describe('サブエージェントのカードのまとめ方', () => {
	test('同じターンの呼び出しは 1 枚にまとめ、前後のツールと後から届いた結果を分ける', () => {
		const read = msg('tool_use', { tool: 'Read', toolUseId: 'r1' });
		const first = msg('tool_use', { tool: 'Agent', toolUseId: 'a1', text: 'レビュー (code-reviewer)' });
		const firstResult = msg('tool_result', { toolUseId: 'a1', text: ASYNC_LAUNCH });
		const bash = msg('tool_use', { tool: 'Bash', toolUseId: 'b1' });
		const prose = msg('text');
		const second = msg('tool_use', { tool: 'Task', toolUseId: 'a2' });
		const secondResult = msg('tool_result', { toolUseId: 'a2', text: SYNC_REPORT });
		const nextTurn = msg('text', { role: 'user' });
		const third = msg('tool_use', { tool: 'Agent', toolUseId: 'a3' });
		const rows = buildChatRows([read, first, firstResult, bash, prose, second, secondResult, nextTurn, third]);
		expect(rows.map(row => row.type === 'agents'
			? { agents: row.calls.map(call => [call.use.toolUseId, call.result?.toolUseId]) }
			: row.type === 'group' ? { group: row.msgs.map(m => m.toolUseId) } : { type: row.type })).toEqual([
			{ group: ['r1'] },
			{ agents: [['a1', 'a1'], ['a2', 'a2']] },
			{ group: ['b1'] },
			{ type: 'msg' },
			{ type: 'msg' },
			{ agents: [['a3', undefined]] },
		]);
		// 鍵はカードを最初に呼んだ発言で決まる（後から呼び出しや結果が増えても同じ行のまま）
		expect(rows.filter(row => row.type === 'agents').map(row => chatRowKey(row, 'e'))).toEqual([`e:a:${first.rev}`, `e:a:${third.rev}`]);
	});

	test('結果が別のまとまりに届いても、間に他のツールが挟まってもカードへ寄せ、残りのツールは並びのまま残す', () => {
		const call = msg('tool_use', { tool: 'Agent', toolUseId: 'a1' });
		const bash = msg('tool_use', { tool: 'Bash', toolUseId: 'b1' });
		const callResult = msg('tool_result', { toolUseId: 'a1', text: SYNC_REPORT });
		const bashResult = msg('tool_result', { toolUseId: 'b1' });
		const prose = msg('text');
		const read = msg('tool_use', { tool: 'Read', toolUseId: 'r1' });
		const lateCall = msg('tool_use', { tool: 'Agent', toolUseId: 'a2' });
		const lateResult = msg('tool_result', { toolUseId: 'a2', text: ASYNC_LAUNCH });
		const rows = buildChatRows([call, bash, callResult, bashResult, prose, read, lateResult, lateCall]);
		expect(rows.map(row => row.type === 'agents'
			? { agents: row.calls.map(item => [item.use.toolUseId, item.result?.toolUseId]) }
			: row.type === 'group' ? { group: row.msgs.map(m => `${m.kind}:${m.toolUseId}`) } : { type: row.type })).toEqual([
			// 呼び出しより先に届いた結果（a2）は寄せる先がまだ無いので、ツールのまとまりに残る
			{ agents: [['a1', 'a1'], ['a2', undefined]] },
			{ group: ['tool_use:b1', 'tool_result:b1'] },
			{ type: 'msg' },
			{ group: ['tool_use:r1', 'tool_result:a2'] },
		]);
	});

	test('サブエージェントを呼ばない会話は行をそのまま返す', () => {
		const rows = buildChatRows([msg('tool_use', { tool: 'Read', toolUseId: 'r' }), msg('tool_result', { toolUseId: 'r' })]);
		expect(rows.map(row => row.type)).toEqual(['group']);
	});
});

describe('カードと一覧の項目の結び', () => {
	test('PC が載せた toolUseIds で引き、無ければ本文の ID、それも無ければ状況で分ける', () => {
		const linkedAgents = [agent('a-spawn', { toolUseIds: ['call-1', 'resume-1'], status: 'completed', startedAt: 1_000, updatedAt: 61_000 }), agent('a-kid', { parentId: 'a-spawn' })];
		const oldPcAgents = [agent('a798fad27281411e5')];
		const launched = msg('tool_result', { toolUseId: 'old-1', text: ASYNC_LAUNCH });
		expect({
			byToolUse: selectSubagentLink(linkedAgents, { toolUseId: 'call-1', hasResult: true }),
			byResume: selectSubagentLink(linkedAgents, { toolUseId: 'resume-1', hasResult: true }).kind,
			byBody: selectSubagentLink(oldPcAgents, subagentCallHint(msg('tool_use', { tool: 'Agent', toolUseId: 'old-1' }), launched)).kind,
			pending: selectSubagentLink(linkedAgents, { toolUseId: 'call-9', hasResult: false }).kind,
			droppedFromList: selectSubagentLink(linkedAgents, { toolUseId: 'call-9', agentId: 'a-gone', hasResult: true }).kind,
			noIdYet: selectSubagentLink(linkedAgents, { toolUseId: 'call-9', hasResult: true }).kind,
			oldPcLongReport: selectSubagentLink(oldPcAgents, { toolUseId: 'call-9', hasResult: true }).kind,
			otherSession: selectSubagentLink(undefined, { toolUseId: 'call-1', hasResult: true }).kind,
		}).toEqual({
			byToolUse: { kind: 'linked', id: 'a-spawn', label: 'Explore', status: 'completed', startedAt: 1_000, updatedAt: 61_000, descendants: 1, descendantsRunning: 1 },
			byResume: 'linked',
			byBody: 'linked',
			pending: 'pending',
			droppedFromList: 'missing',
			noIdYet: 'unlinked',
			oldPcLongReport: 'unlinked',
			otherSession: 'none',
		});
	});

	test('本文から子の ID を拾う（起動・同期の報告・SendMessage・切り詰め）', () => {
		expect({
			launched: agentIdFromSubagentResult(ASYNC_LAUNCH, true),
			report: agentIdFromSubagentResult(SYNC_REPORT, false),
			truncatedReport: agentIdFromSubagentResult(SYNC_REPORT, true),
			resumed: agentIdFromSubagentResult('{"success":true,"message":"Resuming agent a798fad","resumedAgentId":"a798fad27281411e5"}', false, true),
			// 子の報告の本文に出てくる resumedAgentId は SendMessage の結果ではないので拾わない
			resumedInReport: agentIdFromSubagentResult('ログに "resumedAgentId": "decoy" とあった\nagentId: a222', false),
			teammate: agentIdFromSubagentResult('Spawned successfully.\nagent_id: researcher@para\nThe agent is now running', false),
		}).toEqual({ launched: 'a798fad27281411e5', report: 'a111', truncatedReport: undefined, resumed: 'a798fad27281411e5', resumedInReport: 'a222', teammate: 'researcher' });
	});

	test('切り詰められた報告は、PC が添えた ID か取り寄せた全文で結び、どちらも無ければ一覧へ案内する', () => {
		const call = msg('tool_use', { tool: 'Agent', toolUseId: 'long-1' });
		const cut = msg('tool_result', { toolUseId: 'long-1', text: SYNC_REPORT.slice(0, 40), truncated: true });
		const agents = [agent('a111'), agent('a-other', { toolUseIds: ['other'] })];
		expect({
			cut: selectSubagentLink(agents, subagentCallHint(call, cut)).kind,
			structured: selectSubagentLink(agents, subagentCallHint(call, { ...cut, agentId: 'a111' })).kind,
			structuredGone: selectSubagentLink(agents, subagentCallHint(call, { ...cut, agentId: 'a-gone' })).kind,
			fullText: selectSubagentLink(agents, subagentCallHint(call, cut, SYNC_REPORT)).kind,
			detail: subagentCallHint(call, { ...msg('tool_result', { toolUseId: 'long-1', text: SYNC_REPORT }), detailTruncated: true }).agentId,
		}).toEqual({ cut: 'unlinked', structured: 'linked', structuredGone: 'missing', fullText: 'linked', detail: undefined });
	});

	test('状態と時刻が変わらなければ前回の結びをそのまま使う', () => {
		const before = [selectSubagentLink([agent('a', { toolUseIds: ['c'] })], { toolUseId: 'c', hasResult: true })];
		const same = [selectSubagentLink([agent('a', { toolUseIds: ['c'], detail: '別の項目が変わった' })], { toolUseId: 'c', hasResult: true })];
		const changed = [selectSubagentLink([agent('a', { toolUseIds: ['c'], status: 'completed' })], { toolUseId: 'c', hasResult: true })];
		expect([sameSubagentLinks(before, same), sameSubagentLinks(before, changed)]).toEqual([true, false]);
	});

	test('見出しの数と経過時間', () => {
		const links = [
			selectSubagentLink([agent('a', { toolUseIds: ['c1'] })], { toolUseId: 'c1', hasResult: true }),
			selectSubagentLink([agent('b', { toolUseIds: ['c2'], status: 'completed' })], { toolUseId: 'c2', hasResult: true }),
			selectSubagentLink([], { toolUseId: 'c3', hasResult: false }),
		];
		expect({
			summary: subagentCardSummary(links),
			running: [formatSubagentElapsed(0, 59_000, true), formatSubagentElapsed(0, 185_000, true)],
			finished: formatSubagentElapsed(0, 185_000, false),
		}).toEqual({ summary: '実行中 1 · 完了 1 · 起動中 1', running: ['1分未満', '3分'], finished: '3分5秒' });
	});
});

describe('結果の要約', () => {
	test('非同期の起動は 1 行に畳み、同期の報告は末尾の ID と使用量を外して数にする', () => {
		const report = summarizeSubagentResult(SYNC_REPORT);
		expect({
			launched: summarizeSubagentResult(ASYNC_LAUNCH),
			report,
			stats: subagentReportStats(report),
			codex: summarizeSubagentResult('起動しました: /root/reviewer'),
			// 本文の途中の <usage> は使用量ではない（末尾のものだけを外す）
			quoted: summarizeSubagentResult('タグの例: <usage>tool_uses: 99</usage> を出す\n<usage>tool_uses: 3\nduration_ms: 4000</usage>\n'),
		}).toEqual({
			launched: { kind: 'launched' },
			report: { kind: 'report', body: '# レビュー結果\n\n指摘は 2 件です。agentId: decoy は本文', toolUses: 21, durationMs: 178142 },
			stats: 'ツール 21回 · 2分58秒',
			codex: { kind: 'report', body: '起動しました: /root/reviewer' },
			quoted: { kind: 'report', body: 'タグの例: <usage>tool_uses: 99</usage> を出す', toolUses: 3, durationMs: 4000 },
		});
	});
});
