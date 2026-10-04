import { describe, expect, it } from 'vitest';
import { parseAgentCompactionInfo, parseAgentPanel, type AgentActivityState, type AgentChatMessage } from '../../store.js';
import { runningCompactionSince } from './compaction.js';

const activity = (compactions: AgentActivityState['compactions']): AgentActivityState => ({ agents: [], tasks: [], compactions, startedAt: 0, updatedAt: 0 });
const divider = (ts: number): AgentChatMessage => ({ rev: 1, role: 'assistant', kind: 'text', text: 'コンテキストを圧縮しました', ts, notice: true, noticeSource: 'compaction' });

describe('runningCompactionSince', () => {
	it('shows the compaction that is running until its divider arrives, and drops a stale one', () => {
		const now = 1_000_000;
		const running = activity([{ id: 'c1', status: 'running', startedAt: now - 18_000, updatedAt: now - 18_000 }]);
		expect([
			runningCompactionSince(running, [], now),
			runningCompactionSince(running, [divider(now - 1_000)], now),
			runningCompactionSince(running, [divider(now - 60_000)], now),
			runningCompactionSince(activity([{ id: 'c1', status: 'completed', startedAt: now - 5_000, updatedAt: now }]), [], now),
			runningCompactionSince(activity([{ id: 'c1', status: 'running', startedAt: now - 11 * 60_000, updatedAt: now }]), [], now),
			runningCompactionSince(undefined, [], now),
		]).toEqual([now - 18_000, undefined, now - 18_000, undefined, undefined, undefined]);
	});
});

describe('compaction and panel fields from the PC', () => {
	it('keeps only well-formed values', () => {
		expect({
			compaction: [
				parseAgentCompactionInfo({ trigger: 'auto', tokensBefore: 168412, tokensAfter: 21907 }),
				parseAgentCompactionInfo({ trigger: 'later', tokensBefore: 10, summaryChars: 4800 }),
				parseAgentCompactionInfo({ tokensBefore: -1, tokensAfter: 2 }),
				parseAgentCompactionInfo('x'),
			],
			panel: [parseAgentPanel({ command: 'config', since: 5 }), parseAgentPanel({ command: '../x', since: 5 }), parseAgentPanel(null), parseAgentPanel({ command: 'config' })],
		}).toEqual({
			compaction: [{ trigger: 'auto', tokensBefore: 168412, tokensAfter: 21907 }, { summaryChars: 4800 }, undefined, undefined],
			panel: [{ command: 'config', since: 5 }, { since: 5 }, null, undefined],
		});
	});
});
