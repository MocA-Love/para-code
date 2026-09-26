// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { appendQuickReply, nextAttentionAgent, pinnedQuestionIndex, shouldShowQuickReplies } from './agentConversationUx.js';

describe('shouldShowQuickReplies', () => {
	const base = { agentStatus: 'done', working: false, hasPinnedCard: false, chatReady: true, answering: false };

	it('shows chips only while the agent is finished (unreviewed or idle)', () => {
		expect(shouldShowQuickReplies(base)).toBe(true);
		expect(shouldShowQuickReplies({ ...base, agentStatus: undefined })).toBe(true);
		expect(shouldShowQuickReplies({ ...base, agentStatus: 'working' })).toBe(false);
		expect(shouldShowQuickReplies({ ...base, agentStatus: 'permission' })).toBe(false);
		expect(shouldShowQuickReplies({ ...base, agentStatus: 'question' })).toBe(false);
	});

	it('hides chips while working, answering, or with a pinned card', () => {
		expect(shouldShowQuickReplies({ ...base, working: true })).toBe(false);
		expect(shouldShowQuickReplies({ ...base, hasPinnedCard: true })).toBe(false);
		expect(shouldShowQuickReplies({ ...base, chatReady: false })).toBe(false);
		expect(shouldShowQuickReplies({ ...base, answering: true })).toBe(false);
	});
});

describe('appendQuickReply', () => {
	it('fills an empty draft and appends to an existing one', () => {
		expect(appendQuickReply('', '続けて')).toBe('続けて');
		expect(appendQuickReply('  ', '続けて')).toBe('続けて');
		expect(appendQuickReply('ありがとう', '続けて')).toBe('ありがとう 続けて');
		expect(appendQuickReply('ありがとう\n', '続けて')).toBe('ありがとう\n続けて');
	});
});

describe('pinnedQuestionIndex', () => {
	const rows = [
		undefined,
		{ interactionId: 'q1', answered: true },
		undefined,
		{ interactionId: 'q2', answered: false },
		{ interactionId: 'q3', answered: false },
	];

	it('pins the unanswered row the PC is currently asking', () => {
		expect(pinnedQuestionIndex(rows, { kind: 'question', id: 'q2' }, 'question')).toBe(3);
		expect(pinnedQuestionIndex(rows, { kind: 'question', id: 'q1' }, 'question')).toBe(-1);
		expect(pinnedQuestionIndex(rows, { kind: 'question', id: 'missing' }, 'question')).toBe(-1);
	});

	it('pins nothing while an approval is pending', () => {
		expect(pinnedQuestionIndex(rows, { kind: 'approval', id: 'a1' }, 'permission')).toBe(-1);
	});

	it('falls back to the latest unanswered question only when no interaction arrived', () => {
		expect(pinnedQuestionIndex(rows, undefined, 'question')).toBe(4);
		expect(pinnedQuestionIndex(rows, undefined, 'done')).toBe(-1);
	});
});

describe('nextAttentionAgent', () => {
	const terminals = [
		{ terminalKey: 'a', agent: true, agentStatus: 'question' },
		{ terminalKey: 'b', agent: true, agentStatus: 'working' },
		{ terminalKey: 'c', agent: true, agentStatus: 'permission' },
		{ terminalKey: 'd', agent: false, agentStatus: 'permission' },
		{ terminalKey: 'e', agent: true, agentStatus: 'question' },
	];

	it('counts the other waiting agents and picks the next one in home order', () => {
		// 並びは c（許可待ち）→ a → e（質問）。
		expect(nextAttentionAgent(terminals, 'c')).toEqual({ count: 2, next: terminals[0] });
		expect(nextAttentionAgent(terminals, 'a')).toEqual({ count: 2, next: terminals[4] });
		expect(nextAttentionAgent(terminals, 'e')).toEqual({ count: 2, next: terminals[2] });
	});

	it('starts from the first waiting agent when the current one is not waiting', () => {
		expect(nextAttentionAgent(terminals, 'b')).toEqual({ count: 3, next: terminals[2] });
	});

	it('reports nothing when no other agent is waiting', () => {
		expect(nextAttentionAgent([terminals[2]!], 'c')).toEqual({ count: 0, next: undefined });
		expect(nextAttentionAgent(undefined, 'c')).toEqual({ count: 0, next: undefined });
	});
});
