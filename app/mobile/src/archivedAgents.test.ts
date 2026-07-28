// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { releaseArchivedOnAttention } from './archivedAgents.js';

const term = (terminalKey: string, agentStatus?: string) => ({ terminalKey, agentStatus });

describe('releaseArchivedOnAttention', () => {
	it('静かなエージェントの印はそのまま残す', () => {
		const archived = new Set(['a', 'b']);
		expect([...releaseArchivedOnAttention(archived, [term('a'), term('b', 'working'), term('c')])])
			.toEqual(['a', 'b']);
	});

	it('質問・応答待ちになったら印を外す（一覧へ戻す）', () => {
		expect([...releaseArchivedOnAttention(new Set(['a', 'b']), [term('a', 'question'), term('b')])]).toEqual(['b']);
		expect([...releaseArchivedOnAttention(new Set(['a']), [term('a', 'permission')])]).toEqual([]);
	});

	it('レビューや実行中では外さない（こちらの回答を待っていないため）', () => {
		expect([...releaseArchivedOnAttention(new Set(['a', 'b']), [term('a', 'review'), term('b', 'working')])])
			.toEqual(['a', 'b']);
	});

	it('もう存在しないターミナルの印は捨てる', () => {
		expect([...releaseArchivedOnAttention(new Set(['a', 'gone']), [term('a')])]).toEqual(['a']);
	});

	it('変化が無ければ同じ集合をそのまま返す（無駄な再描画を起こさない）', () => {
		const archived = new Set(['a']);
		expect(releaseArchivedOnAttention(archived, [term('a')])).toBe(archived);
		const empty = new Set<string>();
		expect(releaseArchivedOnAttention(empty, [term('a', 'question')])).toBe(empty);
	});
});
