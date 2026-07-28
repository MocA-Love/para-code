// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { PENDING_AGENT_MESSAGE_TTL_MS, reconcilePendingMessages, type PendingAgentMessage } from './pendingAgentMessages.js';

const NOW = 1_000_000;
const entry = (over: Partial<PendingAgentMessage> = {}): PendingAgentMessage => ({
	id: 'p1', text: 'テストも直して', sentAt: NOW - 5_000, afterRev: 10, epoch: 'e1', ...over,
});

describe('reconcilePendingMessages', () => {
	it('会話にまだ現れていない控えは残す', () => {
		expect(reconcilePendingMessages([entry()], 'e1', [{ rev: 11, text: '別の発言' }], NOW)).toEqual([entry()]);
	});

	it('送信より後に同じ本文が現れたら外す（＝エージェントが読んだ）', () => {
		expect(reconcilePendingMessages([entry()], 'e1', [{ rev: 11, text: 'テストも直して' }], NOW)).toEqual([]);
	});

	it('前後の空白は無視して照合する', () => {
		expect(reconcilePendingMessages([entry()], 'e1', [{ rev: 11, text: '  テストも直して\n' }], NOW)).toEqual([]);
	});

	it('送信より前の同じ本文では外さない（同じ指示を送り直したときに消えてしまう）', () => {
		expect(reconcilePendingMessages([entry()], 'e1', [{ rev: 9, text: 'テストも直して' }], NOW)).toEqual([entry()]);
	});

	it('同じ本文を2件送ったときは、現れたぶんだけ外す', () => {
		const pending = [entry({ id: 'p1' }), entry({ id: 'p2' })];
		expect(reconcilePendingMessages(pending, 'e1', [{ rev: 11, text: 'テストも直して' }], NOW))
			.toEqual([entry({ id: 'p2' })]);
	});

	it('セッションが変わったら控えごと捨てる（順番待ちも消えているため）', () => {
		expect(reconcilePendingMessages([entry()], 'e2', [], NOW)).toEqual([]);
		expect(reconcilePendingMessages([entry()], undefined, [], NOW)).toEqual([]);
	});

	it('読まれないまま上限を越えた控えは捨てる', () => {
		const stale = entry({ sentAt: NOW - PENDING_AGENT_MESSAGE_TTL_MS - 1 });
		expect(reconcilePendingMessages([stale], 'e1', [], NOW)).toEqual([]);
	});
});
