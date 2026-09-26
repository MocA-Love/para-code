// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { AgentChatMessage } from '../../store.js';
import { agentLogoKind, agentRowLine, formatElapsedShort, lastAssistantText, lastChatActivityAt } from './agentRowLine.js';
import { nextStatusSince } from './statusSince.js';

function message(rev: number, role: AgentChatMessage['role'], kind: AgentChatMessage['kind'], text: string, ts?: number): AgentChatMessage {
	return { rev, role, kind, text, ...(ts !== undefined ? { ts } : {}) };
}

describe('行の3段目の一文', () => {
	test('ターミナルは「ターミナル」で時刻を出さない', () => {
		expect(agentRowLine({ agent: false }, undefined)).toEqual({ text: 'ターミナル', emphasized: false, at: undefined });
	});

	test('会話の写しが無ければ状態の呼び名だけ', () => {
		expect(agentRowLine({ agent: true, agentStatus: 'permission' }, undefined).text).toBe('許可待ち');
		expect(agentRowLine({ agent: true, agentStatus: 'working' }, undefined).text).toBe('実行中');
		expect(agentRowLine({ agent: true, agentStatus: 'review' }, undefined)).toEqual({ text: '完了', emphasized: true, at: undefined });
		expect(agentRowLine({ agent: true }, undefined).text).toBe('待機中');
	});

	test('最後の本文（考え中・ツールは除く）の1行目を出す', () => {
		const chat = { messages: [message(1, 'assistant', 'text', '\n  最初の行\n2行目', 1_000), message(2, 'assistant', 'thinking', '考え中', 2_000), message(3, 'tool', 'tool_result', 'ok', 3_000)] };
		expect(lastAssistantText(chat)).toBe('最初の行');
		expect(lastChatActivityAt(chat)).toBe(3_000);
		expect(agentRowLine({ agent: true, agentStatus: 'review' }, chat)).toEqual({ text: '最初の行', emphasized: true, at: 3_000 });
	});

	test('実行中は動いているツールとその対象を優先する', () => {
		const chat = { messages: [message(1, 'assistant', 'text', '進めます')], live: { phase: 'tool' as const, source: 'hook' as const, startedAt: 1, updatedAt: 5_000, tool: 'Bash', detail: 'pnpm test' } };
		expect(agentRowLine({ agent: true, agentStatus: 'working' }, chat)).toEqual({ text: 'Bash pnpm test', emphasized: false, at: 5_000 });
	});

	test('要対応は何を待っているかを添える', () => {
		const chat = { messages: [], interaction: { kind: 'question' as const, id: 'q1', title: '上限は何回にしますか？' } };
		expect(agentRowLine({ agent: true, agentStatus: 'question' }, chat).text).toBe('質問 · 上限は何回にしますか？');
	});

	test('PC にセッションが無いときの写しは使わない', () => {
		expect(agentRowLine({ agent: true, agentStatus: 'review' }, { messages: [message(1, 'assistant', 'text', '古い', 9)], none: true }).text).toBe('完了');
	});
});

describe('ロゴと経過時間', () => {
	test('会話の写しのエージェント名、無ければ名前から推し量る', () => {
		expect(agentLogoKind({ agent: true, title: 'shell' }, 'codex')).toBe('codex');
		expect(agentLogoKind({ agent: true, title: 'Claude Code' }, undefined)).toBe('claude');
		expect(agentLogoKind({ agent: true, title: 'my agent' }, undefined)).toBe('agent');
		expect(agentLogoKind({ agent: false, title: 'claude' }, undefined)).toBe('terminal');
	});

	test('経過時間は短い形', () => {
		const now = 10 * 24 * 60 * 60_000;
		expect(formatElapsedShort(now - 30_000, now)).toBe('今');
		expect(formatElapsedShort(now - 3 * 60_000, now)).toBe('3分');
		expect(formatElapsedShort(now - 2 * 60 * 60_000, now)).toBe('2時間');
		expect(formatElapsedShort(now - 4 * 24 * 60 * 60_000, now)).toBe('4日');
		expect(formatElapsedShort(now + 60_000, now)).toBe('今');
	});
});

describe('状態が変わった時刻の記録', () => {
	test('初めて見た状態には時刻を付けず、目の前で変わったときだけ付ける', () => {
		const first = nextStatusSince(new Map(), [{ terminalKey: 'a', agentStatus: 'working' }], 100);
		expect(first.get('a')).toEqual({ status: 'working', since: undefined });
		const same = nextStatusSince(first, [{ terminalKey: 'a', agentStatus: 'working' }], 200);
		expect(same).toBe(first);
		const changed = nextStatusSince(same, [{ terminalKey: 'a', agentStatus: 'review' }], 300);
		expect(changed.get('a')).toEqual({ status: 'review', since: 300 });
	});

	test('消えたターミナルの記録は落とす', () => {
		const first = nextStatusSince(new Map(), [{ terminalKey: 'a' }, { terminalKey: 'b' }], 100);
		const next = nextStatusSince(first, [{ terminalKey: 'b' }], 200);
		expect([...next.keys()]).toEqual(['b']);
	});
});
