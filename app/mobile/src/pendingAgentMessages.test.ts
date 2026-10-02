// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PENDING_AGENT_MESSAGE_SWEEP_MS, PENDING_AGENT_MESSAGE_TTL_MS, normalizeAgentMessageText, reconcilePendingMessages, usePendingAgentMessages, type PendingAgentMessage } from './pendingAgentMessages.js';

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

describe('本文の照合', () => {
	it('Claude Code が貼り付けを包んだ形（pasted_content）でも外す', () => {
		const sent = entry({ text: '一行目\n二行目' });
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: '\n\n<pasted_content id="512f">\n一行目\n二行目\n</pasted_content id="512f">\n' }], NOW)).toEqual([]);
		// id の無い形・閉じタグの id が違う形は Claude Code の書き方ではないので展開しない
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: '\n\n<pasted_content>\n一行目\n二行目\n</pasted_content>\n' }], NOW)).toEqual([sent]);
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: '\n\n<pasted_content id="a">\n一行目\n二行目\n</pasted_content id="b">\n' }], NOW)).toEqual([sent]);
	});

	it('包みの前後に文があっても、新しい PC が入れる区切りの改行を無視して外す', () => {
		const sent = entry({ text: 'これを見てlogどう思う?' });
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: 'これを見て\n\n<pasted_content id="a1">\nlog\n</pasted_content id="a1">\nどう思う?' }], NOW)).toEqual([]);
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: 'これを見て\nlog\nどう思う?' }], NOW)).toEqual([]);
	});

	it('改行コードと行末の空白の違いは無視する', () => {
		const sent = entry({ text: '一行目  \r\n二行目\r\n' });
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: '一行目\n二行目' }], NOW)).toEqual([]);
	});

	it('複数行の本文は行の中身まで一致したときだけ外す', () => {
		const sent = entry({ text: 'A\nB\nC' });
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: 'A\nB' }], NOW)).toEqual([sent]);
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: 'A\nB\nC' }], NOW)).toEqual([]);
	});

	it('PC が長い本文を切り詰めて送ってきたときは先頭の一致で外す', () => {
		const long = 'あ'.repeat(5_000) + '\n' + 'い'.repeat(3_000);
		const sent = entry({ text: long });
		const truncated = `${long.slice(0, 6_000)}…`;
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: truncated }], NOW)).toEqual([]);
		// 短い本文の先頭が一致するだけでは外さない（切り詰めの印が無い）
		expect(reconcilePendingMessages([sent], 'e1', [{ rev: 11, text: 'あ'.repeat(10) }], NOW)).toEqual([sent]);
	});

	it('normalizeAgentMessageText は前後の空白と包みを落とす', () => {
		expect(normalizeAgentMessageText('  前\r\n\n<pasted_content id="x">\n中\n</pasted_content id="x">\n後  \n')).toBe('前\n中\n後');
	});
});

describe('上限を越えた控えの掃除', () => {
	afterEach(() => {
		usePendingAgentMessages.setState({ byTerminal: {} });
		vi.useRealTimers();
	});

	it('会話が更新されなくても、上限を越えた控えはタイマーで外れる', () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		usePendingAgentMessages.getState().add('t1', '読まれない発言', 10, 'e1');
		expect(usePendingAgentMessages.getState().byTerminal.t1).toHaveLength(1);
		vi.advanceTimersByTime(PENDING_AGENT_MESSAGE_TTL_MS - PENDING_AGENT_MESSAGE_SWEEP_MS);
		expect(usePendingAgentMessages.getState().byTerminal.t1).toHaveLength(1);
		vi.advanceTimersByTime(PENDING_AGENT_MESSAGE_SWEEP_MS * 2);
		expect(usePendingAgentMessages.getState().byTerminal).toEqual({});
		// 空になったらタイマーは止まる
		expect(vi.getTimerCount()).toBe(0);
	});
});
