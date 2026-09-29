// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { AGENT_HISTORY_KEEP_LIMIT, absorbTrimmedIntoHistory, agentHistoryHeader, applyAgentHistoryPage, beginAgentHistoryLoad, historyBeforeRev, parseAgentHistoryReply, reconcileAgentHistory, type AgentHistoryState } from './agentHistory.js';
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

	it('moves the messages a delta trimmed off the live list into the history instead of dropping everything (NG-1)', () => {
		// 古い発言 100〜199、手元の新しい発言 200〜699（500 件）。差分で 700〜709 が届き、手元は 210〜709 に切られた
		const history: AgentHistoryState = { epoch: 'e1', messages: Array.from({ length: 100 }, (_, index) => message(100 + index)), hasMore: true, capped: false, loading: false };
		const previousLive = Array.from({ length: 500 }, (_, index) => message(200 + index));
		const nextLive = Array.from({ length: 500 }, (_, index) => message(210 + index));
		const absorbed = absorbTrimmedIntoHistory(history, 'e1', previousLive, nextLive);
		const reconciled = reconcileAgentHistory(absorbed, 'e1', nextLive);
		// 並び（古い発言 + 新しい発言）は切る前と同じ 100〜709 のまま。一覧の行が変わらないので表示位置も動かない
		const before = [...history.messages, ...previousLive, ...Array.from({ length: 10 }, (_, index) => message(700 + index))].map(entry => entry.rev);
		const after = [...(reconciled?.messages ?? []), ...nextLive].map(entry => entry.rev);
		expect({ same: JSON.stringify(after) === JSON.stringify(before), historyTail: reconciled?.messages.at(-1)?.rev, hasMore: reconciled?.hasMore }).toEqual({ same: true, historyTail: 209, hasMore: true });
		// さかのぼっていなければ何もしない。別の会話の差分も繰り入れない
		expect(absorbTrimmedIntoHistory(undefined, 'e1', previousLive, nextLive)).toBeUndefined();
		expect(absorbTrimmedIntoHistory(history, 'e2', previousLive, nextLive)).toBe(history);
	});

	it.each([600, 520, 1500])('keeps the history and a continuous order when one delta carries %i messages', count => {
		// 古い発言 100〜199、手元の新しい発言 200〜699（500 件）。1 回の差分で 700 から count 件が届く
		const history: AgentHistoryState = { epoch: 'e1', messages: Array.from({ length: 100 }, (_, index) => message(100 + index)), hasMore: true, capped: false, loading: false };
		const previousLive = Array.from({ length: 500 }, (_, index) => message(200 + index));
		const fresh = Array.from({ length: count }, (_, index) => message(700 + index));
		// ストア（store.ts の delta）と同じ切り方: 結合して新しい 500 件を残し、はみ出した古い側を渡す
		const merged = [...previousLive, ...fresh];
		const nextLive = merged.slice(-500);
		const trimmedByDelta = merged.slice(0, merged.length - 500);
		const absorbed = absorbTrimmedIntoHistory(history, 'e1', previousLive, nextLive, trimmedByDelta);
		const reconciled = reconcileAgentHistory(absorbed, 'e1', nextLive);
		const revs = [...(reconciled?.messages ?? []), ...nextLive].map(entry => entry.rev);
		expect({
			kept: reconciled !== undefined,
			first: revs[0],
			last: revs.at(-1),
			continuous: revs.every((rev, index) => index === 0 || rev === revs[index - 1]! + 1),
		}).toEqual({ kept: true, first: 100, last: 699 + count, continuous: true });
		// 直前の発言だけからでは、差分の中で切られた分が抜けて古い発言が捨てられていた
		expect(reconcileAgentHistory(absorbTrimmedIntoHistory(history, 'e1', previousLive, nextLive), 'e1', nextLive)).toBeUndefined();
	});

	it('keeps at most the history limit and then says the rest is on the PC', () => {
		const history: AgentHistoryState = { epoch: 'e1', messages: Array.from({ length: AGENT_HISTORY_KEEP_LIMIT }, (_, index) => message(index)), cursor: 'f:1:0', hasMore: true, capped: false, loading: false };
		const previousLive = [message(AGENT_HISTORY_KEEP_LIMIT), message(AGENT_HISTORY_KEEP_LIMIT + 1)];
		const absorbed = absorbTrimmedIntoHistory(history, 'e1', previousLive, [message(AGENT_HISTORY_KEEP_LIMIT + 1)])!;
		expect({ length: absorbed.messages.length, first: absorbed.messages[0]?.rev, capped: absorbed.capped, hasMore: absorbed.hasMore, cursor: absorbed.cursor })
			.toEqual({ length: AGENT_HISTORY_KEEP_LIMIT, first: 1, capped: true, hasMore: false, cursor: undefined });
	});

	it('keeps a busy PC retryable, and stops on errors that cannot be retried', () => {
		const loading = beginAgentHistoryLoad(undefined, 'e1');
		const busy = applyAgentHistoryPage(loading, { messages: [], hasMore: false, capped: false, error: 'busy' });
		const moved = applyAgentHistoryPage(loading, { messages: [], hasMore: false, capped: false, error: 'history-moved' });
		expect({
			busy: agentHistoryHeader(true, true, busy),
			moved: agentHistoryHeader(true, true, moved).kind,
			busyRetrying: agentHistoryHeader(true, true, beginAgentHistoryLoad(busy, 'e1')),
		}).toEqual({
			busy: { kind: 'more', loading: false, message: 'PC が読み込み中です。少し待ってからもう一度さかのぼってください' },
			moved: 'error',
			busyRetrying: { kind: 'more', loading: true },
		});
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
