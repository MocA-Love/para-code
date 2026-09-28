// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	AGENT_RESUME_CAPABILITY, AGENT_SEND_AUTO_WINDOW_MS, AGENT_SEND_QUEUE_LIMIT, agentSendConversationMatches, AGENT_SEND_QUEUE_TTL_MS, addAgentSendQueueItem, agentSendResumeTarget, deserializeAgentSendQueue, expireAgentSendQueue, parseAgentPastSessionPage,
	parseAgentPastSessionPreview, parseAgentResumeResult, planAgentSendQueue, serializeAgentSendQueue, type AgentSendQueueItem,
} from './agentSessions.js';
import { AGENT_HISTORY_CAPABILITY } from './agentHistory.js';
import { PcCapability } from './pcCompat.js';

const KEY = 'a'.repeat(40);
const item = (id: string, fields: Partial<AgentSendQueueItem> = {}): AgentSendQueueItem => ({
	id, pcId: 'pc-1', createdAt: 1_000, text: `text ${id}`, target: { kind: 'live', terminalKey: 'term-1', ws: 'repo-1', resumeKey: KEY }, status: 'waiting', ...fields,
});

describe('agentSessions (W2-29)', () => {
	it('uses the same capability names as the PC advertises', () => {
		expect([AGENT_RESUME_CAPABILITY, AGENT_HISTORY_CAPABILITY]).toEqual([PcCapability.AgentResume, PcCapability.AgentHistoryPage]);
	});

	it('reads the past-session list, dropping entries without a valid fingerprint', () => {
		expect(parseAgentPastSessionPage({
			sessions: [
				{ key: KEY, agent: 'claude', title: 'ログインの修正', preview: '直しました', previewRole: 'assistant', updatedAt: 2, terminalKey: 'term-9' },
				{ key: 'not-a-key', agent: 'claude', title: 'x', updatedAt: 1 },
				{ key: KEY, agent: 'gemini', title: 'x', updatedAt: 1 },
			],
			total: 3, nextOffset: 30,
		})).toEqual({
			sessions: [{ key: KEY, agent: 'claude', title: 'ログインの修正', preview: '直しました', previewRole: 'assistant', updatedAt: 2, terminalKey: 'term-9' }],
			total: 3, nextOffset: 30,
		});
	});

	it('reads the preview and the resume result', () => {
		expect(parseAgentPastSessionPreview({
			session: { key: KEY, agent: 'codex', title: 't', updatedAt: 1 },
			messages: [{ role: 'user', text: 'やって', ts: 5 }, { role: 'tool', text: 'x' }],
			truncated: true,
		})).toEqual({ session: { key: KEY, agent: 'codex', title: 't', updatedAt: 1 }, messages: [{ role: 'user', text: 'やって', ts: 5 }], truncated: true });
		expect(parseAgentPastSessionPreview({ messages: [] })).toBeUndefined();
		expect(parseAgentResumeResult({ status: 'resumed', terminalKey: 'term-2', delivered: true })).toEqual({ status: 'resumed', terminalKey: 'term-2', delivered: true });
		expect(parseAgentResumeResult({ status: 'unknown' })).toBeUndefined();
	});

	it('sends to open agent terminals, asks before resuming closed ones and past sessions, and fails what cannot be resumed', () => {
		const items = [
			item('open', { createdAt: 3 }),
			item('closed', { createdAt: 2, target: { kind: 'live', terminalKey: 'gone', ws: 'repo-1', resumeKey: KEY } }),
			item('closed-no-key', { createdAt: 4, target: { kind: 'live', terminalKey: 'gone' } }),
			item('past', { createdAt: 1, target: { kind: 'resume', ws: 'repo-1', key: KEY } }),
			item('other-pc', { pcId: 'pc-2' }),
			item('done', { status: 'failed' }),
		];
		expect(planAgentSendQueue(items, 'pc-1', [{ terminalKey: 'term-1', agent: true }], 10).map(plan => [plan.kind, plan.item.id])).toEqual([
			['confirm', 'past'],
			['confirm', 'closed'],
			['send', 'open'],
			['fail', 'closed-no-key'],
		]);
		// エージェントでなくなったターミナル（シェルに戻った）へは送らない
		expect(planAgentSendQueue([item('open')], 'pc-1', [{ terminalKey: 'term-1', agent: false }], 10).map(plan => plan.kind)).toEqual(['confirm']);
		// 預けてから 15 分を過ぎたものは、開いているターミナル宛てでも確かめる（H2）
		expect(planAgentSendQueue([item('old', { createdAt: 0 })], 'pc-1', [{ terminalKey: 'term-1', agent: true }], AGENT_SEND_AUTO_WINDOW_MS + 1)
			.map(plan => plan.kind === 'confirm' ? [plan.kind, plan.reason] : [plan.kind])).toEqual([['confirm', 'stale']]);
	});

	it('only sends automatically when the terminal still runs the same conversation (H2)', () => {
		expect({
			same: agentSendConversationMatches(item('a'), KEY),
			other: agentSendConversationMatches(item('a'), 'b'.repeat(40)),
			unknownNow: agentSendConversationMatches(item('a'), undefined),
			unknownThen: agentSendConversationMatches(item('a', { target: { kind: 'live', terminalKey: 'term-1' } }), KEY),
		}).toEqual({ same: true, other: false, unknownNow: false, unknownThen: false });
	});

	it('expires items after 24 hours and keeps at most the limit per PC', () => {
		const items = [item('old', { createdAt: 0 }), item('new', { createdAt: AGENT_SEND_QUEUE_TTL_MS })];
		const expired = expireAgentSendQueue(items, AGENT_SEND_QUEUE_TTL_MS + 1);
		expect(expired.map(entry => [entry.status, entry.text])).toEqual([['expired', ''], ['waiting', 'text new']]);
		// 期限切れの印も、さらに 1 日たったら消す（L5）
		expect(expireAgentSendQueue(expired, 3 * AGENT_SEND_QUEUE_TTL_MS).map(entry => entry.id)).toEqual(['new']);
		expect(expireAgentSendQueue(items, 10)).toBe(items);
		let queue: readonly AgentSendQueueItem[] = [item('other', { pcId: 'pc-2' })];
		for (let index = 0; index <= AGENT_SEND_QUEUE_LIMIT; index++) {
			queue = addAgentSendQueueItem(queue, item(`q${index}`, { createdAt: index }));
		}
		expect({ length: queue.length, first: queue[1]?.id, kept: queue.some(entry => entry.id === 'other') }).toEqual({ length: AGENT_SEND_QUEUE_LIMIT + 1, first: 'q1', kept: true });
	});

	it('round-trips the saved form per PC and turns an interrupted send back into waiting', () => {
		const saved = serializeAgentSendQueue('pc-1', [
			item('a', { status: 'sending' }), item('b', { pcId: 'pc-2' }), item('c', { target: { kind: 'resume', ws: 'repo-1', key: KEY }, status: 'needs-confirm', reason: 'closed' }),
			item('d', { target: { kind: 'resume', ws: 'repo-1', key: KEY }, status: 'sending' }), item('e', { status: 'expired', text: '' }),
		]);
		// 送っている途中で止まったもの（M4）: ターミナル宛ては同じ id で送り直す待ちへ、再開は確かめ直しへ
		expect(deserializeAgentSendQueue('pc-1', saved).map(entry => [entry.id, entry.status, entry.reason])).toEqual([
			['a', 'waiting', undefined], ['c', 'needs-confirm', 'closed'], ['d', 'needs-confirm', 'closed'], ['e', 'expired', undefined],
		]);
		expect(deserializeAgentSendQueue('pc-2', saved)).toEqual([]);
		expect(deserializeAgentSendQueue('pc-1', 'garbage')).toEqual([]);
	});

	it('knows where to resume a queued send', () => {
		expect(agentSendResumeTarget(item('a'))).toEqual({ ws: 'repo-1', key: KEY });
		expect(agentSendResumeTarget(item('b', { target: { kind: 'live', terminalKey: 't' } }))).toBeUndefined();
		expect(agentSendResumeTarget(item('c', { target: { kind: 'resume', ws: 'repo-2', key: KEY } }))).toEqual({ ws: 'repo-2', key: KEY });
	});
});
