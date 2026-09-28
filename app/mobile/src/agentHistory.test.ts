// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { agentHistoryHeader, applyAgentHistoryPage, beginAgentHistoryLoad, historyBeforeRev, parseAgentHistoryReply, reconcileAgentHistory, type AgentHistoryState } from './agentHistory.js';
import type { AgentChatMessage } from './store.js';

const message = (rev: number, text = `m${rev}`): AgentChatMessage => ({ rev, role: 'user', kind: 'text', text });

describe('agentHistory (W2-30)', () => {
	it('reads a reply, keeping only well-formed messages and dropping payloads that cannot be fetched', () => {
		expect(parseAgentHistoryReply({
			messages: [
				{ rev: -2, role: 'user', kind: 'text', text: 'a', truncated: true },
				{ rev: -1, role: 'tool', kind: 'tool_result', text: 'b', images: [{ index: 0 }] },
				{ rev: 'x', role: 'user', kind: 'text', text: 'bad' },
				{ rev: 0, role: 'robot', kind: 'text', text: 'bad' },
			],
			cursor: 'f:10:0', hasMore: true,
		})).toEqual({
			messages: [{ rev: -2, role: 'user', kind: 'text', text: 'a' }, { rev: -1, role: 'tool', kind: 'tool_result', text: 'b' }],
			cursor: 'f:10:0', hasMore: true, capped: false,
		});
		expect(parseAgentHistoryReply({ error: 'busy' })).toEqual({ messages: [], hasMore: false, capped: false, error: 'busy' });
		expect(parseAgentHistoryReply({})).toBeUndefined();
	});

	it('prepends pages from the ring, then from the file, and remembers the cursor', () => {
		const live = [message(200), message(201)];
		let state: AgentHistoryState = beginAgentHistoryLoad(undefined, 'e1');
		expect(historyBeforeRev(undefined, live)).toBe(200);
		state = applyAgentHistoryPage(state, { messages: [message(140), message(199)], hasMore: true, capped: false, cursor: 'f:500:0' });
		expect(historyBeforeRev(state, live)).toBe(140);
		state = applyAgentHistoryPage(beginAgentHistoryLoad(state, 'e1'), { messages: [message(-2), message(-1)], hasMore: false, capped: false });
		expect(state).toEqual({ epoch: 'e1', messages: [message(-2), message(-1), message(140), message(199)], hasMore: false, capped: false, loading: false });
	});

	it('drops what the live messages now cover, and throws away history that no longer connects or belongs to another epoch', () => {
		const state: AgentHistoryState = { epoch: 'e1', messages: [message(-1), message(198), message(199)], hasMore: true, capped: false, loading: false };
		expect(reconcileAgentHistory(state, 'e1', [message(199), message(200)])?.messages).toEqual([message(-1), message(198)]);
		expect(reconcileAgentHistory(state, 'e1', [message(200)])).toBe(state);
		// 199 と 250 の間が抜けた（PC のメモリから押し出された）
		expect(reconcileAgentHistory(state, 'e1', [message(250)])).toBeUndefined();
		expect(reconcileAgentHistory(state, 'e2', [message(200)])).toBeUndefined();
	});

	it('keeps a busy PC retryable, and stops on errors that cannot be retried', () => {
		const loading = beginAgentHistoryLoad(undefined, 'e1');
		const busy = applyAgentHistoryPage(loading, { messages: [], hasMore: false, capped: false, error: 'busy' });
		const moved = applyAgentHistoryPage(loading, { messages: [], hasMore: false, capped: false, error: 'history-moved' });
		expect({
			busy: agentHistoryHeader(true, true, busy),
			moved: agentHistoryHeader(true, true, moved).kind,
		}).toEqual({ busy: { kind: 'more', loading: false }, moved: 'error' });
	});

	it('chooses the header for old PCs, untouched lists, loading, the cap and the start', () => {
		const base: AgentHistoryState = { epoch: 'e1', messages: [], hasMore: true, capped: false, loading: false };
		expect({
			oldPcTruncated: agentHistoryHeader(false, true, undefined),
			oldPcComplete: agentHistoryHeader(false, false, undefined),
			untouched: agentHistoryHeader(true, true, undefined),
			complete: agentHistoryHeader(true, false, undefined),
			loading: agentHistoryHeader(true, true, { ...base, loading: true }),
			capped: agentHistoryHeader(true, true, { ...base, hasMore: false, capped: true }),
			start: agentHistoryHeader(true, true, { ...base, hasMore: false }),
		}).toEqual({
			oldPcTruncated: { kind: 'truncated' },
			oldPcComplete: { kind: 'none' },
			untouched: { kind: 'more', loading: false },
			complete: { kind: 'none' },
			loading: { kind: 'more', loading: true },
			capped: { kind: 'capped' },
			start: { kind: 'none' },
		});
	});
});
